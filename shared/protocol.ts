/*
 * VesktopClaudeBridge
 * Copyright (c) 2026 dataterminals
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Wire protocol shared by the Equicord plugin (renderer) and the sidecar (Node).
 *
 * This file is the single source of truth. `scripts/install-plugin.ps1` copies it
 * into the plugin folder inside the Equicord tree, and `sidecar/src/protocol.ts`
 * re-exports it. Edit it HERE, nowhere else.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8787;

/** Origins the sidecar will accept a plugin socket from. */
export const ALLOWED_ORIGINS = [
    "https://discord.com",
    "https://ptb.discord.com",
    "https://canary.discord.com"
];

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface BridgeUser {
    id: string;
    /** Discord username (the @handle, no discriminator on the new system). */
    username: string;
    /** Server nickname if present, else global display name, else username. */
    displayName: string;
    bot: boolean;
}

export interface BridgeAttachment {
    id: string;
    filename: string;
    size: number;
    contentType: string | null;
    /**
     * Signed CDN url. These expire (the `ex`/`is`/`hm` query params), so treat
     * them as short-lived — hand them to `attachment.fetch` promptly.
     */
    url: string;
    /** Heuristic: is this something worth reading as text (a log, a diff, json...). */
    likelyText: boolean;
}

export interface BridgeEmbed {
    type: string | null;
    title: string | null;
    description: string | null;
    url: string | null;
    author: string | null;
    footer: string | null;
    fields: { name: string; value: string; }[];
}

export interface BridgeReaction {
    emoji: string;
    /**
     * Set for custom emoji, null for unicode ones.
     *
     * `emoji` renders a custom emoji as `:name:`, which reads fine and cannot be
     * sent back to Discord — its reaction routes are keyed by `name:id`. Keeping
     * the id is what makes a reaction addressable rather than merely printable.
     */
    emojiId: string | null;
    count: number;
    /** The signed-in account is one of the `count`. */
    me: boolean;
}

export interface BridgePollAnswer {
    /** Discord's per-poll answer id. `count` is keyed by this, not by position. */
    id: number;
    text: string | null;
    /**
     * Votes for this answer, or null when Discord sent no tally at all.
     *
     * Null is not zero. A poll the client has already rendered arrives with its
     * counts inline; one pulled cold out of history can come back with the
     * question, the options, and no numbers — and reporting that as zero votes
     * would be a fabricated result rather than a missing one.
     */
    count: number | null;
    /** The signed-in account picked this answer. */
    me: boolean;
}

export interface BridgePoll {
    question: string | null;
    answers: BridgePollAnswer[];
    /** ISO 8601, or null for a poll with no expiry set. */
    expiresAt: string | null;
    allowMultiselect: boolean;
    /** Voting has closed; Discord considers the tally final. */
    finalized: boolean;
    /**
     * Sum of every answer's `count`, or null when no counts were sent.
     *
     * Votes, not voters. Under `allowMultiselect` one person can appear in
     * several answers, so this deliberately over-counts people and must not be
     * read as a headcount.
     */
    totalVotes: number | null;
}

/** One emoji's worth of reactors, as returned by the `reactors` method. */
export interface ReactorGroup {
    emoji: string;
    emojiId: string | null;
    /** What Discord says the total is — which `users` may fall short of. */
    count: number;
    users: BridgeUser[];
    /** More people reacted than were fetched; raise `limit` to page further. */
    truncated: boolean;
}

export interface BridgeReplyRef {
    id: string | null;
    author: string | null;
    /** First ~120 chars of the message being replied to, resolved. */
    excerpt: string | null;
    /** True when Discord did not give us the referenced message body. */
    unresolved: boolean;
}

export interface BridgeMessage {
    id: string;
    channelId: string;
    guildId: string | null;
    author: BridgeUser;
    /** ISO 8601, always UTC. */
    timestamp: string;
    editedTimestamp: string | null;
    /**
     * Message body with mentions, channel links, custom emoji and <t:> stamps
     * already resolved to readable text. Code fences are preserved byte-exact.
     */
    content: string;
    replyTo: BridgeReplyRef | null;
    attachments: BridgeAttachment[];
    embeds: BridgeEmbed[];
    reactions: BridgeReaction[];
    /**
     * Present only on poll messages.
     *
     * The client has always held this and the bridge never read it, so a poll
     * rendered as an empty message with an author and no body — the one shape
     * that looks like a transcription bug rather than a missing feature.
     */
    poll: BridgePoll | null;
    pinned: boolean;
    /** Permalink, so a human can jump to it. */
    link: string;
    /** Present when `content` was cut down; use `history` with `around` to expand. */
    truncated?: { originalLength: number; };
}

export interface BridgeChannel {
    id: string;
    name: string;
    /** Numeric Discord channel type, kept raw so the sidecar can label it. */
    type: number;
    topic: string | null;
    guildId: string | null;
    parentId: string | null;
    isThread: boolean;
    isDm: boolean;
}

export interface BridgeGuild {
    id: string;
    name: string;
}

export interface CurrentView {
    guild: BridgeGuild | null;
    channel: BridgeChannel | null;
    messages: BridgeMessage[];
    /** ISO timestamp of when the plugin snapshotted this. */
    capturedAt: string;
    /** True when messages came from the client cache rather than a REST fetch. */
    fromCache: boolean;
}

/**
 * One search result.
 *
 * Search spans channels, so unlike `history` a hit can't inherit its channel
 * from the request — it carries its own.
 */
export interface SearchHit {
    message: BridgeMessage;
    channel: BridgeChannel | null;
}

/** What Discord's search endpoint accepts. `has` mirrors its filter vocabulary. */
export type SearchHasFilter = "file" | "link" | "embed" | "image" | "sound" | "video" | "poll";

export interface MarkedItem {
    /** Monotonic per-session id, so `marked.clear` can drop a single entry. */
    markId: number;
    markedAt: string;
    note: string | null;
    guild: BridgeGuild | null;
    channel: BridgeChannel | null;
    messages: BridgeMessage[];
}

/**
 * A message the third-eye watcher captured on its own.
 *
 * `notable` is what earns an interruption; everything else just accumulates and
 * is read later. Capture is free — it costs no model — so the buffer keeps
 * everything and the filtering happens at the point where it would cost tokens.
 */
export interface LiveMessage {
    message: BridgeMessage;
    /** Mention of you, reply to you, a term you named, or any message in a DM. */
    notable: boolean;
    /** Which rule fired, so a digest can say why without re-deriving it. */
    reason: "mention" | "reply" | "term" | "dm" | null;
}

export interface ThirdEyeState {
    watching: boolean;
    guild: BridgeGuild | null;
    channel: BridgeChannel | null;
    /** When the watch started, and when it will lapse on its own. */
    since: string | null;
    expiresAt: string | null;
    /**
     * The channel's newest message at the moment the watch armed.
     *
     * The buffer starts empty, so everything in it is *after* this id and
     * nothing before it was ever captured. Naming that edge is what makes the
     * run-up recoverable — `history before=<anchorId>` reads what led up to the
     * first buffered message — on the same principle as a truncation note.
     */
    anchorId: string | null;
    /**
     * Set when a Discord reload restored this watch, cleared by the first
     * consuming drain.
     *
     * Only the intent survives a Ctrl+R; whatever was buffered does not. Without
     * this the restored state reads `0 buffered, 0 dropped`, which is
     * indistinguishable from a quiet channel — when what actually happened is
     * that everything unread was discarded.
     */
    resumedAt: string | null;
    /** Buffered but not yet drained. */
    pending: number;
    notablePending: number;
    /**
     * Volume counters for the current watch, so "is this a firehose?" is
     * measured rather than guessed. Reset by `start()`, because they are
     * rendered as "since it started" and a watch moved from a busy channel to a
     * quiet one would otherwise report the busy one's traffic forever.
     */
    seen: number;
    matched: number;
    /** Messages the ring evicted before anything read them. */
    dropped: number;
}

// ---------------------------------------------------------------------------
// RPC surface
// ---------------------------------------------------------------------------

export type RpcMethod =
    | "ping"
    | "current_view"
    | "history"
    | "search"
    | "resolve_link"
    | "marked.list"
    | "marked.clear"
    | "third_eye.state"
    | "third_eye.drain"
    | "guilds"
    | "channels"
    | "reactors";

export interface RpcParams {
    ping: Record<string, never>;
    current_view: { limit?: number; };
    history: {
        channelId: string;
        limit?: number;
        before?: string;
        after?: string;
        around?: string;
    };
    search: {
        /** Guild to search. Omit only for a DM search, which needs `channelId`. */
        guildId?: string;
        /** Narrow a guild search to one channel, or name the DM to search. */
        channelId?: string;
        content?: string;
        authorId?: string;
        mentions?: string;
        has?: SearchHasFilter;
        /** Snowflake bounds, same ids as `history` uses. */
        before?: string;
        after?: string;
        limit?: number;
        /** Result offset, for paging past the first page. */
        offset?: number;
        /** Newest first by default. */
        sortOrder?: "asc" | "desc";
    };
    resolve_link: { url: string; context?: number; };
    "marked.list": { consume?: boolean; };
    "marked.clear": { markId?: number; };
    "third_eye.state": Record<string, never>;
    /** Reading is the only part that costs anything, so it's explicit. */
    "third_eye.drain": { consume?: boolean; notableOnly?: boolean; limit?: number; };
    guilds: Record<string, never>;
    channels: { guildId: string; };
    reactors: {
        channelId: string;
        messageId: string;
        /**
         * Which reaction to expand, written the way `history` prints it: the
         * emoji itself for a unicode one, `:name:` or bare `name` for a custom
         * one. Omit to expand every reaction on the message.
         */
        emoji?: string;
        /** Users to collect per reaction. Discord pages these 100 at a time. */
        limit?: number;
    };
}

export interface RpcResults {
    ping: { pong: true; user: BridgeUser | null; };
    current_view: CurrentView;
    history: { channel: BridgeChannel | null; messages: BridgeMessage[]; };
    search: {
        guild: BridgeGuild | null;
        /** Total matches Discord claims, which is usually far more than `hits`. */
        totalResults: number;
        hits: SearchHit[];
        /** Echoed back so the caller knows what to add to for the next page. */
        offset: number;
        /**
         * Discord is still building this guild's search index, so results are
         * incomplete. Worth saying out loud rather than reporting a short list
         * as if it were the whole answer.
         */
        indexing: boolean;
    };
    resolve_link: {
        guild: BridgeGuild | null;
        channel: BridgeChannel | null;
        target: BridgeMessage | null;
        context: BridgeMessage[];
    };
    "marked.list": { items: MarkedItem[]; };
    "marked.clear": { cleared: number; };
    "third_eye.state": ThirdEyeState;
    "third_eye.drain": {
        state: ThirdEyeState;
        messages: LiveMessage[];
        /**
         * Evicted before anything read them. Surfaced rather than swallowed, on
         * the same principle as truncation: a gap you know about is recoverable.
         */
        dropped: number;
        /**
         * `resumedAt` as it stood *before* this drain cleared it.
         *
         * Carried beside `dropped` for the same reason that one is: `state`
         * describes the buffer after the drain, but both of these are facts
         * about the gap this particular drain is reporting, and a consuming
         * read would otherwise clear the flag before anyone saw it.
         */
        resumed: string | null;
    };
    guilds: { guilds: BridgeGuild[]; };
    channels: { channels: BridgeChannel[]; };
    reactors: {
        channel: BridgeChannel | null;
        /** The message itself, so a caller can see what was reacted to. */
        message: BridgeMessage | null;
        groups: ReactorGroup[];
        /**
         * Reactions left unexpanded because the message carried more distinct
         * emoji than one call will walk.
         *
         * Named rather than dropped, on the same principle as `dropped` and
         * `truncated`: a partial answer that looks complete is worse than a
         * short one that says so.
         */
        skipped: number;
    };
}

export interface RpcError {
    code:
        | "no_client"
        | "timeout"
        | "bad_params"
        | "not_found"
        | "forbidden"
        | "discord_error"
        | "internal";
    message: string;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/** plugin -> sidecar, first frame. */
export interface HelloFrame {
    t: "hello";
    protocol: number;
    token: string;
    user: BridgeUser | null;
    pluginVersion: string;
}

/** sidecar -> plugin, acknowledges `hello`. */
export interface HelloOkFrame {
    t: "hello-ok";
    protocol: number;
    sidecarVersion: string;
}

/** sidecar -> plugin. */
export interface ReqFrame {
    t: "req";
    id: string;
    method: RpcMethod;
    params: unknown;
}

/** plugin -> sidecar. */
export type ResFrame =
    | { t: "res"; id: string; ok: true; data: unknown; }
    | { t: "res"; id: string; ok: false; error: RpcError; };

/**
 * plugin -> sidecar, unsolicited.
 *
 * Adding an event name is backward compatible in the direction that matters — an
 * older plugin simply never sends it — so this does not move PROTOCOL_VERSION.
 * Bumping it would close(4426) every tool on a half-upgraded install.
 */
export interface EventFrame {
    t: "event";
    event: "marked" | "view-changed" | "third-eye";
    data: unknown;
}

export type PluginFrame = HelloFrame | ResFrame | EventFrame;
export type SidecarFrame = HelloOkFrame | ReqFrame;

export function isPluginFrame(v: unknown): v is PluginFrame {
    return typeof v === "object" && v !== null && typeof (v as { t?: unknown; }).t === "string";
}
