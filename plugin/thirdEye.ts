/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Third eye mode: a quiet second pair of eyes on one channel.
 *
 * The buffer lives HERE, in the renderer, not in the sidecar. That is the whole
 * architectural bet and it pays three ways:
 *
 *  - Claude Code spawns the sidecar per session and kills it when the session
 *    ends. A sidecar-side buffer would evaporate exactly when you walked away,
 *    which is precisely when you wanted it. Discord runs all day; this doesn't.
 *  - Scope guards get stronger rather than weaker. Content the sidecar isn't
 *    allowed to see never crosses the process boundary at all, so `denyDms`
 *    means "never left the renderer" instead of "refused after arrival".
 *  - The drain is a pull, like `marked.list`. Sidecar restarts cost nothing.
 *
 * Capture is free — no model, no tokens, no session. Reading is the only part
 * that costs anything. So this keeps everything it sees and does the filtering
 * at the point where it would actually be spent.
 */

import * as DataStore from "@api/DataStore";
import { ChannelStore, GuildStore, UserStore } from "@webpack/common";

import { toBridgeChannel, toBridgeGuild, toBridgeMessage } from "./discord";
import type { BridgeChannel, BridgeGuild, LiveMessage, ThirdEyeState } from "./protocol";
import { settings } from "./settings";

/**
 * Only the *intent* is persisted, never message bodies — reloading Discord
 * shouldn't leave other people's chat on disk. The cost is that a Ctrl+R drops
 * whatever you hadn't read yet, which is the trade the ecosystem's other
 * watchers make too.
 */
const STORE_KEY = "VesktopClaudeBridge_thirdEye";

const RING_MAX = 300;
const AUTO_OFF_MS = 4 * 60 * 60 * 1000;

interface PersistedIntent {
    channelId: string;
    since: string;
    expiresAt: string;
}

let channelId: string | null = null;
let since: string | null = null;
let expiresAt: number | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

let ring: LiveMessage[] = [];
let seen = 0;
let matched = 0;
let dropped = 0;

/**
 * Watch terms, parsed lazily.
 *
 * This runs on every MESSAGE_CREATE, so it must not re-split the setting each
 * time — but it also has to notice an edit made in the settings UI without
 * waiting for a reload. Comparing the raw string is cheap enough to do per
 * message and gets both.
 */
let terms: string[] = [];
let termsRaw: string | null = null;

/**
 * Fold away spacing and punctuation on both sides before matching.
 *
 * People write the same mod both ways in the same breath — "UnkillablesRebalance"
 * and "Unkillables rebalance" both appear in the channel this was built for — and
 * a plain substring test catches only whichever form the user happened to type
 * into the settings box.
 */
function fold(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

let onNotable: ((entry: LiveMessage) => void) | null = null;
let onExpire: ((channel: BridgeChannel | null) => void) | null = null;

/**
 * True only while a session is actively draining the buffer.
 *
 * Drives the burst in the chat-bar icon, so "compute is being spent" is legible
 * at a glance rather than something you take on faith — which matters for a mode
 * that sits reading other people's conversation.
 */
let reading = false;
let readingTimer: ReturnType<typeof setTimeout> | null = null;

export function noteRead(): void {
    reading = true;
    if (readingTimer) clearTimeout(readingTimer);
    readingTimer = setTimeout(() => {
        reading = false;
        readingTimer = null;
    }, 20_000);
}

export function isReading(): boolean {
    return reading;
}

export function isWatching(): boolean {
    return channelId !== null;
}

export function watchedChannelId(): string | null {
    return channelId;
}

export function refreshTerms(): void {
    const raw = String(settings.store.thirdEyeTerms ?? "");
    if (raw === termsRaw) return;
    termsRaw = raw;
    terms = raw
        .split(",")
        .map(t => fold(t))
        // Two characters folds to noise; "ai" would match half the channel.
        .filter(t => t.length >= 3);
}

export function setCallbacks(
    notable: (entry: LiveMessage) => void,
    expire: (channel: BridgeChannel | null) => void
): void {
    onNotable = notable;
    onExpire = expire;
}

// ---------------------------------------------------------------------------

function resolveChannel(id: string | null): BridgeChannel | null {
    return id ? toBridgeChannel(ChannelStore.getChannel(id)) : null;
}

function resolveGuild(channel: BridgeChannel | null): BridgeGuild | null {
    return channel?.guildId ? toBridgeGuild(GuildStore.getGuild(channel.guildId)) : null;
}

function persist(): void {
    const value: PersistedIntent | null =
        channelId && since && expiresAt
            ? { channelId, since, expiresAt: new Date(expiresAt).toISOString() }
            : null;
    void DataStore.set(STORE_KEY, value).catch(err =>
        console.warn("[VesktopClaudeBridge] could not persist third eye state:", err)
    );
}

function armExpiry(): void {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    if (expiresAt === null) return;

    const delay = expiresAt - Date.now();
    if (delay <= 0) return void stop(true);
    expiryTimer = setTimeout(() => stop(true), delay);
}

export function start(id: string): ThirdEyeState {
    // One channel at a time: moving the watch is the common case, and two live
    // channels multiply the volume and the privacy surface for little gain.
    channelId = id;
    since = new Date().toISOString();
    expiresAt = Date.now() + AUTO_OFF_MS;
    ring = [];
    dropped = 0;
    refreshTerms();
    armExpiry();
    persist();
    return state();
}

/** `expired` distinguishes "you turned it off" from "it lapsed", which the UI says out loud. */
export function stop(expired = false): ThirdEyeState {
    const channel = resolveChannel(channelId);
    const snapshot = state();

    channelId = null;
    since = null;
    expiresAt = null;
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    ring = [];
    persist();

    // A watcher that stops silently is worse than one that never stopped: you
    // believe you're covered when you aren't.
    if (expired) onExpire?.(channel);
    return { ...snapshot, watching: false };
}

/** Restores the watch across a Ctrl+R. Intent survives; buffered content does not. */
export async function loadThirdEye(): Promise<void> {
    refreshTerms();
    try {
        const saved = await DataStore.get<PersistedIntent | null>(STORE_KEY);
        if (!saved?.channelId) return;

        const expiry = Date.parse(saved.expiresAt);
        if (!Number.isFinite(expiry) || expiry <= Date.now()) {
            void DataStore.set(STORE_KEY, null);
            return;
        }
        channelId = saved.channelId;
        since = saved.since;
        expiresAt = expiry;
        armExpiry();
    } catch (err) {
        console.warn("[VesktopClaudeBridge] could not restore third eye state:", err);
    }
}

// ---------------------------------------------------------------------------

/**
 * Drops the oldest ambient chatter first, and only touches notable messages once
 * there is nothing else left to give up.
 *
 * A flat ring is the wrong shape here. Measured on a real channel: 475 messages
 * an hour, so a 300-entry ring is full in 38 minutes and "what did I miss while
 * I was heads-down for three hours" would return the last half hour of banter
 * having already discarded the one reply that was actually for you. Notable
 * entries are ~1% of traffic, so keeping them costs almost nothing and is the
 * entire point of leaving this running.
 */
function evict(): void {
    if (ring.length <= RING_MAX) return;

    const excess = ring.length - RING_MAX;
    let toDrop = excess;
    const kept: LiveMessage[] = [];

    for (const entry of ring) {
        if (toDrop > 0 && !entry.notable) {
            toDrop--;
            dropped++;
            continue;
        }
        kept.push(entry);
    }

    // Everything left is notable and it still doesn't fit: fall back to oldest-first.
    if (kept.length > RING_MAX) {
        dropped += kept.length - RING_MAX;
        ring = kept.slice(-RING_MAX);
        return;
    }
    ring = kept;
}

/**
 * What earns an interruption. Everything else still accumulates.
 *
 * Attachments deliberately do NOT qualify: a channel with a bot posting build
 * artifacts would turn the interrupt tier into a pager. Logs still land in the
 * buffer, they just don't break concentration.
 *
 * A DM has no ambient tier at all, so everything in one qualifies — see the
 * note on the fallback at the bottom.
 */
function notabilityOf(raw: any, meId: string, isDm: boolean): LiveMessage["reason"] {
    if (Array.isArray(raw?.mentions) && raw.mentions.some((u: any) => String(u?.id) === meId)) {
        return "mention";
    }
    if (raw?.mention_everyone) return "mention";

    const repliedTo = raw?.referenced_message;
    if (repliedTo && String(repliedTo?.author?.id ?? "") === meId) return "reply";

    // Picks up settings-UI edits without a reload; no-ops when unchanged.
    refreshTerms();
    if (terms.length) {
        const body = fold(String(raw?.content ?? ""));
        if (body && terms.some(t => body.includes(t))) return "term";
    }

    // Everything in a DM is notable, because a DM has no ambient tier: each
    // message is addressed to you personally, and nobody @-mentions or uses the
    // reply affordance in a one-to-one. Without this the guild rules would find
    // nothing to fire on, so the buffer would fill correctly while the hook —
    // which reads notable-only, and is what makes the button sufficient — stayed
    // silent. That failure looks exactly like a watch that never armed.
    //
    // Group DMs count too. They're small enough that volume isn't the problem it
    // is in a public channel, and being in one is already the reason to watch it.
    return isDm ? "dm" : null;
}

/**
 * The MESSAGE_CREATE handler.
 *
 * Flux handlers are subscribed when the dispatcher is *found*, which is before
 * `start()` has run — so every module-level thing this touches must tolerate
 * being null, and the watch gate has to live inside the function rather than in
 * whether the handler is registered. Mutating `plugin.flux` later does nothing;
 * the object is read once at subscribe time.
 */
export function onMessageCreate(payload: any): void {
    if (!channelId) return;
    if (String(payload?.channelId ?? "") !== channelId) return;

    // The local echo of your own send. Without this, and without the SENDING
    // state check, self-sent messages arrive twice.
    if (payload?.optimistic) return;

    const raw = payload?.message;
    if (!raw || raw.state === "SENDING") return;

    const me = UserStore.getCurrentUser();
    const meId = String(me?.id ?? "");
    if (meId && String(raw?.author?.id ?? "") === meId) return;

    if (!settings.store.thirdEyeIncludeBots && raw?.author?.bot) return;

    seen++;

    // guildId is taken from the channel, never from the payload, because
    // toBridgeMessage resolves mentions and roles against it.
    const channel = resolveChannel(channelId);
    const reason = notabilityOf(raw, meId, channel?.isDm ?? false);
    const entry: LiveMessage = {
        message: toBridgeMessage(raw, channel),
        notable: reason !== null,
        reason
    };
    if (entry.notable) matched++;

    ring.push(entry);
    evict();

    if (entry.notable) onNotable?.(entry);
}

/**
 * A message deleted before anything read it is never delivered at all.
 *
 * Deletions aren't reported — the payload carries no body, and several plugins
 * dispatch synthetic deletes for their own UI. This subscribes purely to drop
 * the entry, which is a property only a buffer can offer.
 */
export function onMessageDelete(payload: any): void {
    if (!channelId || payload?.mlDeleted) return;
    if (String(payload?.channelId ?? "") !== channelId) return;

    const id = String(payload?.id ?? "");
    if (!id) return;
    ring = ring.filter(e => e.message.id !== id);
}

// ---------------------------------------------------------------------------

export function state(): ThirdEyeState {
    const channel = resolveChannel(channelId);
    return {
        watching: channelId !== null,
        guild: resolveGuild(channel),
        channel,
        since,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        pending: ring.length,
        notablePending: ring.filter(e => e.notable).length,
        seen,
        matched,
        dropped
    };
}

export function drain(opts: { consume?: boolean; notableOnly?: boolean; limit?: number; }): {
    state: ThirdEyeState;
    messages: LiveMessage[];
    dropped: number;
} {
    const wanted = opts.notableOnly ? ring.filter(e => e.notable) : ring;
    const limit = Math.max(1, Math.min(opts.limit ?? 100, RING_MAX));
    const messages = wanted.slice(-limit);
    const droppedNow = dropped;

    if (opts.consume) {
        // Consuming a filtered view would silently bin everything that didn't
        // match, so only a full drain empties the ring.
        ring = opts.notableOnly ? ring.filter(e => !e.notable) : [];
        dropped = 0;
    }

    return { state: state(), messages, dropped: droppedNow };
}

export function pendingCount(): number {
    return ring.length;
}
