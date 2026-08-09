/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The mark queue.
 *
 * This is the feature the whole plugin is really for. "Read the logs" normally
 * costs a round-trip of *which* logs, where, how far back — marking collapses
 * that into one right-click, and the model just reads what was pointed at.
 *
 * Marks are pulled, never pushed: MCP gives a server no way to wake a model up,
 * so the queue simply waits until something asks for it. It does not, however,
 * wait forever — see the note above prune().
 */

import * as DataStore from "@api/DataStore";

import type { MarkedItem } from "./protocol";
import { settings } from "./settings";

const STORE_KEY = "VesktopClaudeBridge_marks";
const MAX_ITEMS = 50;

/**
 * Two days.
 *
 * The failure this exists for: marks were capped by count and never by age, so
 * somebody marked a handful of things, came back days later, asked Claude to
 * read "what I marked", and got the day-before-yesterday's marks blended into
 * the answer with nothing saying so.
 *
 * 12h was the first number tried and it is wrong: mark things while reading in
 * the evening, open Claude at 09:00, queue empty — silently, with no undo. That
 * is the ordinary shape of this workflow, and generating "my marks vanished" to
 * fix "my marks were stale" is a bad trade. 24h has its own cliff sitting
 * exactly on the daily rhythm. 48h still kills the reported bug (marks from
 * *days* ago) while missing the daily rhythm entirely, and the today-versus-
 * yesterday discrimination is left to the age the sidecar prints, which is
 * recoverable because the model can read it. Expiry is the blunt backstop
 * against "forever", not the instrument for "yesterday".
 */
const DEFAULT_EXPIRY_HOURS = 48;

let items: MarkedItem[] = [];
let nextId = 1;

/**
 * Resolves the setting, and does it explicitly rather than with `||`.
 *
 * `0` means "keep marks forever" and is a value the user can deliberately pick,
 * so `settings.store.markExpiryHours || DEFAULT_EXPIRY_HOURS` is wrong: it reads
 * "never" as "unset" and quietly reinstates a 48h window on somebody who asked
 * for none. A negative number is treated as unset too, because the other reading
 * of a negative window — "everything is already expired" — would empty the queue
 * the instant a typo landed in the settings box.
 */
function expiryHours(): number {
    const raw = settings.store.markExpiryHours;
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_EXPIRY_HOURS;
}

/** The instant a mark has to be newer than to survive. */
function cutoff(): number {
    const hours = expiryHours();
    return hours === 0 ? Number.NEGATIVE_INFINITY : Date.now() - hours * 60 * 60 * 1000;
}

/**
 * An unparseable `markedAt` counts as fresh, deliberately.
 *
 * Binning somebody's marked conversation over a `Date.parse` quirk is the worse
 * of the two failures, and the queue is capped at MAX_ITEMS so a stuck entry
 * costs one slot rather than unbounded memory. The sidecar renders it as
 * "unknown age" and flags it, which is the right place to be suspicious.
 */
function isFresh(item: MarkedItem, at: number): boolean {
    const marked = Date.parse(item.markedAt);
    return !Number.isFinite(marked) || marked >= at;
}

/**
 * Drops expired marks. Returns how many went, persists only if any did.
 *
 * Expiry is enforced *here*, in the renderer, and not in the sidecar where the
 * filtering would be easier to write. Two reasons, both decisive:
 *
 *  - The queue is capped by count. A sidecar-side filter hides stale marks but
 *    cannot stop fifty of them from occupying all fifty slots and evicting the
 *    fresh ones as they arrive. Only the owner of the array can free a slot.
 *  - The sidecar is dead for most of the queue's life. Claude Code spawns one
 *    per session and kills it when the session ends; Discord runs all day. The
 *    thing that is actually awake while marks are going stale is this file.
 *
 * Called from every path that already touches the array — load, add, read and
 * clear — rather than from a timer. Third eye has a timer (thirdEye.ts,
 * armExpiry) because a lapsed watch owes the user a loud toast at the instant
 * it lapses. An expired mark owes nobody anything at the instant it expires, so
 * a timer would only buy wakeups.
 */
function prune(): number {
    const at = cutoff();
    const before = items.length;
    items = items.filter(i => isFresh(i, at));
    const dropped = before - items.length;
    if (dropped) {
        console.debug(`[VesktopClaudeBridge] ${dropped} mark(s) expired`);
        persist();
    }
    return dropped;
}

/** Restores marks made before the last Ctrl+R. Best effort — never throws. */
export async function loadMarks(): Promise<void> {
    try {
        const saved = await DataStore.get<MarkedItem[]>(STORE_KEY);
        if (!Array.isArray(saved) || !saved.length) return;

        // Ids climb from what was on disk, not from what survived the prune: a
        // morning where everything expired must not start handing out markId 1
        // again while somebody is still holding "mark 1" from last night.
        // Math.max(0, ...) rather than a bare spread, because spreading an empty
        // array yields -Infinity and nextId would go with it — and folding in the
        // current nextId covers a mark made while this await was in flight.
        nextId = Math.max(nextId, Math.max(0, ...saved.map(i => Number(i.markId) || 0)) + 1);

        const at = cutoff();
        const restored = saved.filter(i => isFresh(i, at));

        // Pruning before the slice matters: expired entries must not consume the
        // MAX_ITEMS budget that fresh ones are competing for. It also keeps other
        // people's message bodies from outliving the policy on disk, which is the
        // same argument thirdEye.ts makes for persisting intent only.
        //
        // Concatenating rather than assigning, because Vencord registers context
        // menus around plugin start: a right-click during this await would
        // otherwise be clobbered by whatever came back from IndexedDB.
        items = [...restored, ...items].slice(-MAX_ITEMS);

        if (restored.length !== saved.length) {
            console.debug(
                `[VesktopClaudeBridge] ${saved.length - restored.length} mark(s) expired while Discord was closed`
            );
            persist();
        }
    } catch (err) {
        console.warn("[VesktopClaudeBridge] could not restore marks:", err);
    }
}

function persist(): void {
    void DataStore.set(STORE_KEY, items).catch(err =>
        console.warn("[VesktopClaudeBridge] could not persist marks:", err)
    );
}

export function addMark(item: Omit<MarkedItem, "markId" | "markedAt">): MarkedItem {
    // Before the push, so corpses aren't holding slots the new mark has to
    // evict a live one to get.
    prune();

    const entry: MarkedItem = {
        ...item,
        markId: nextId++,
        markedAt: new Date().toISOString()
    };
    items.push(entry);
    if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
    persist();
    return entry;
}

export function listMarks(consume: boolean): MarkedItem[] {
    // The read is the boundary where staleness turns into a wrong answer, and
    // it is the one site that holds however long Discord sat idle. It also
    // covers the raw /rpc passthrough a proxying sidecar uses, for free.
    prune();

    const snapshot = items.slice();
    if (consume) {
        items = [];
        persist();
    }
    return snapshot;
}

export function clearMarks(markId?: number): number {
    // Prune first, *then* measure. The other order counts expired marks as
    // cleared, so the toast says "Cleared 5" right after the menu label said
    // "3 marked" — which is exactly the mismatch pruning on clear is here to
    // prevent.
    prune();

    const before = items.length;
    items = markId == null ? [] : items.filter(i => i.markId !== markId);
    persist();
    return before - items.length;
}

/**
 * Pure: counts what a read would return, and mutates nothing.
 *
 * It has to be pure because it now runs on React render paths — the chat-bar
 * tooltip and the menu label — and neither of those is a sane place to write to
 * IndexedDB. The cost is a Date.parse per item, bounded by MAX_ITEMS.
 */
export function markCount(): number {
    const at = cutoff();
    return items.filter(i => isFresh(i, at)).length;
}
