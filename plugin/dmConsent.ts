/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The DM gate: asks before a private conversation leaves the renderer.
 *
 * This is the strongest of the three DM guards in this project, and the reason
 * is where it sits rather than what it checks. The sidecar's `denyDms` and
 * `allowDms` refuse content that has already crossed the process boundary; this
 * refuses before the handler runs, so nothing was ever read, serialised, or put
 * on a socket. Same argument the third eye makes for keeping its buffer in the
 * renderer — see the header of live.ts.
 *
 * It hangs off a single point. bridge.ts dispatches every RPC through one
 * `handlers[method]` lookup, so one `await` in front of that covers the whole
 * surface. That matters more than the lines it saves: the sidecar's own guard is
 * called from fifteen places, and twice now it has been found sitting downstream
 * of one of two exits (`/marked`, `/live`). A gate with one call site cannot
 * develop that bug.
 *
 * What each method can touch is a table rather than a run of ifs, and it is
 * typed `Record<RpcMethod, ...>` on purpose: adding a method to the protocol
 * without deciding whether it can reach a DM is then a compile error rather than
 * a silent hole. Same trick `handlers` itself uses.
 */

import { Alerts, ChannelStore, SelectedChannelStore } from "@webpack/common";

import { dmRecipients, fail, parseMessageLink, toBridgeChannel } from "./discord";
import { grantFor, grantForever, isGranted, LISTING_KEY, refuse, refusedFor } from "./dmLedger";
import { listMarks } from "./marked";
import type { RpcMethod } from "./protocol";
import { settings } from "./settings";
import { state as thirdEyeState } from "./thirdEye";

/**
 * How long the bridge holds an RPC open waiting for you to click.
 *
 * Sits deliberately under the sidecar's `rpcTimeoutMs`, which defaults to 15s.
 * A modal that waits on a human outlasts that easily, and the tool then reports
 * `timeout` — which reads as "the bridge is broken" rather than "you have not
 * clicked yet", and sends people debugging instead of answering.
 *
 * So the wait is bounded here instead, and expiry is not a denial: the modal
 * stays on screen, the refusal says so, and clicking Allow afterwards works
 * normally. At-the-keyboard is one click; away-from-it degrades to
 * approve-then-retry rather than to a misleading timeout.
 *
 * Lower `rpcTimeoutMs` below this and the sidecar gives up first, which is the
 * timeout this exists to avoid. The README says so next to the setting.
 */
const WAIT_MS = 10_000;

const DEFAULT_GRANT_MINUTES = 60;

type Decision = "temporary" | "forever" | "denied";

/** One prompt per set of conversations, however many callers are waiting on it. */
const inFlight = new Map<string, Promise<Decision>>();

export type DmAccessMode = "off" | "ask" | "allow";

export function accessMode(): DmAccessMode {
    const raw = settings.store.dmAccess;
    return raw === "off" || raw === "allow" ? raw : "ask";
}

function grantMinutes(): number {
    const raw = settings.store.dmGrantMinutes;
    // Zero is not read as "forever" here, unlike markExpiryHours. A consent
    // prompt whose Allow never expires is the Always allow button, and that one
    // at least writes itself down somewhere you can see and revoke it.
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GRANT_MINUTES;
}

// ---------------------------------------------------------------------------
// What each method can reach
// ---------------------------------------------------------------------------

/** `[id]` when this channel is a DM, `[]` otherwise. An unknown id is not a DM. */
function dmKey(channelId: string | null | undefined): string[] {
    if (!channelId) return [];
    const channel = toBridgeChannel(ChannelStore.getChannel(channelId));
    return channel?.isDm ? [channel.id] : [];
}

/**
 * Which conversations a call would expose, keyed for the ledger.
 *
 * Exhaustive over RpcMethod, so a new method has to answer this before it will
 * compile. The five that return nothing each earn it:
 *
 *  - `ping` carries the signed-in account and no channel at all.
 *  - `guilds` and `channels` read guild stores, which by construction hold no
 *    private channels — that gap is the whole reason `dms` had to be added.
 *  - `marked.clear` destroys and discloses nothing; it returns a count. Gating
 *    it would make a DM mark permanently unclearable under `off`, which is the
 *    same dead end the sidecar already refuses to build, for the same reason.
 *  - `third_eye.state` names the watched channel and carries no message bodies.
 *    It is left open deliberately, and it is the one place a DM's *identity* is
 *    visible without a prompt. Two reasons. You cannot arm a DM watch without
 *    turning on `thirdEyeWatchDms`, which is off by default, so that particular
 *    channel has already been opted into twice. And the sidecar calls `state`
 *    precisely so it can guard *before* draining — refusing the probe would
 *    break the ordering that stops a refused drain destroying the buffer it was
 *    refusing to show. The drain is gated below, which is where content lives.
 */
const REACHES: Record<RpcMethod, (params: any) => string[]> = {
    ping: () => [],
    guilds: () => [],
    channels: () => [],
    "marked.clear": () => [],
    "third_eye.state": () => [],

    // Guild-scoped by construction — a member list or role list has no DM
    // equivalent, same reasoning as guilds/channels above.
    members: () => [],
    roles: () => [],

    dms: () => [LISTING_KEY],

    current_view: () => dmKey(SelectedChannelStore.getChannelId()),
    history: params => dmKey(params?.channelId),
    reactors: params => dmKey(params?.channelId),
    // Polls can sit in a DM same as any other message, so this is channel-scoped
    // exactly like reactors.
    pollVoters: params => dmKey(params?.channelId),

    // A search with a guildId is scoped to that guild and cannot return a DM.
    // Without one it is a DM search, and channelId names which.
    search: params => (params?.guildId ? [] : dmKey(params?.channelId)),

    resolve_link: params => {
        try {
            return dmKey(parseMessageLink(String(params?.url ?? "")).channelId);
        } catch {
            // Not a link at all. The handler rejects it with a reason of its own.
            return [];
        }
    },

    // Every DM sitting in the queue, deduped. One prompt naming all of them
    // beats one prompt per mark, and the queue caps at 50.
    "marked.list": () => [...new Set(listMarks(false).flatMap(item => dmKey(item.channel?.id)))],

    "third_eye.drain": () => dmKey(thirdEyeState().channel?.id)
};

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

/** How a conversation is named, in the prompt and in every refusal about it. */
function describe(key: string): string {
    if (key === LISTING_KEY) return "your DM list";

    const raw = ChannelStore.getChannel(key);
    if (!raw) return `an unknown conversation (${key})`;

    const names = dmRecipients(raw).map(u => u.displayName);
    const title = raw.name || null;
    if (title) return names.length ? `${title} (${names.join(", ")})` : title;
    return names.length ? names.join(", ") : `an empty conversation (${key})`;
}

function describeAll(keys: string[]): string {
    const named = keys.map(describe);
    if (named.length === 1) return named[0]!;
    return `${named.length} conversations: ${named.join("; ")}`;
}

function prompt(keys: string[], action: string): Promise<Decision> {
    const cacheKey = keys.join("|");
    const existing = inFlight.get(cacheKey);
    if (existing) return existing;

    const label = describeAll(keys);
    const minutes = grantMinutes();

    const run = new Promise<Decision>(resolve => {
        let settled = false;

        /*
         * The decision is recorded here rather than by whoever is waiting,
         * because by the time you click, nothing may still be waiting — see
         * WAIT_MS. Clicking Allow on a prompt whose RPC already gave up has to
         * grant access anyway, or the retry it just told you to make would
         * prompt you a second time for the thing you had only now allowed.
         */
        const finish = (decision: Decision) => {
            if (settled) return;
            settled = true;
            for (const key of keys) {
                if (decision === "forever") grantForever(key, describe(key));
                else if (decision === "temporary") grantFor(key, minutes * 60_000);
                else refuse(key);
            }
            inFlight.delete(cacheKey);
            resolve(decision);
        };

        Alerts.show({
            title: "Claude wants to read a DM",
            body:
                `The bridge is asking to ${action}: ${label}.` +
                "\n\nNothing has been read yet — this is asked before anything leaves Discord.",
            confirmText: `Allow for ${minutes} min`,
            secondaryConfirmText: "Always allow",
            cancelText: "Deny",
            onConfirm: () => finish("temporary"),
            onConfirmSecondary: () => finish("forever"),
            onCancel: () => finish("denied"),
            // Fires on every close, a button press included. The settled guard is
            // what narrows it to "dismissed without choosing" — and dismissing a
            // permission prompt is a no, not a maybe.
            onCloseCallback: () => finish("denied")
        });
    });

    inFlight.set(cacheKey, run);
    return run;
}

/** Minutes, rounded up, for a refusal that has to quote a remaining cooldown. */
function minutesLeft(ms: number): string {
    const mins = Math.ceil(ms / 60_000);
    return `${mins} minute${mins === 1 ? "" : "s"}`;
}

/**
 * The gate. Returns quietly when a call may proceed, throws an RpcError when it
 * may not.
 *
 * Every refusal names which of this project's switches refused it and where that
 * switch lives. There are four of them now across two processes, and a bare
 * "forbidden" leaves you guessing which one to go and change.
 */
export async function requestDmAccess(method: RpcMethod, params: unknown): Promise<void> {
    const mode = accessMode();
    if (mode === "allow") return;

    const keys = REACHES[method]?.(params) ?? [];
    if (!keys.length) return;

    const label = describeAll(keys);

    if (mode === "off") {
        throw fail(
            "forbidden",
            `Refused by the Discord plugin: DM access is switched off, so ${label} cannot be read. ` +
                'This is the plugin\'s own switch, separate from the sidecar\'s "denyDms" — change it in Discord under ' +
                'Equicord settings, Plugins, VesktopClaudeBridge, "DM access". A permanent allow does not override it.'
        );
    }

    const needed = keys.filter(key => !isGranted(key));
    if (!needed.length) return;

    const cooling = needed.find(key => refusedFor(key) > 0);
    if (cooling) {
        throw fail(
            "forbidden",
            `Refused by the Discord plugin: access to ${describe(cooling)} was declined, and the bridge will not ask ` +
                `again for ${minutesLeft(refusedFor(cooling))}. Do not retry — ask the user to approve it in Discord, ` +
                'or to tick "Let Claude read DMs without asking" in the menu behind the Claude bridge button on the ' +
                "chat bar."
        );
    }

    if (!Alerts?.show) {
        // Before Discord's modal module has resolved, which is a narrow window at
        // boot. Refused rather than allowed, and without a cooldown, because this
        // is the plugin failing rather than you declining.
        throw fail(
            "forbidden",
            "Refused by the Discord plugin: DM access needs a confirmation prompt, and Discord's modal system is not " +
                "ready yet. Try again in a moment."
        );
    }

    const action = needed.length === 1 && needed[0] === LISTING_KEY ? "list" : "read";

    let timer: ReturnType<typeof setTimeout> | undefined;
    let decision: Decision | null;
    try {
        decision = await Promise.race([
            prompt(needed, action),
            new Promise<null>(resolve => {
                timer = setTimeout(() => resolve(null), WAIT_MS);
            })
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }

    if (decision === null) {
        throw fail(
            "forbidden",
            `A confirmation for ${label} is on screen in Discord and has not been answered yet. It is still up — the ` +
                "user can approve it there and this call will work on the next attempt. Nothing has been read."
        );
    }

    if (decision === "denied") {
        throw fail("forbidden", `Refused by the user in Discord: ${label} was not approved.`);
    }
}
