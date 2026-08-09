/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Turning message objects into something worth spending context on.
 *
 * The whole point of this project is that a transcript should cost less and say
 * more than a screenshot. Two rules follow from that:
 *
 *  1. Never indent a message body. Log files and code fences arrive here intact
 *     and they leave here intact — indenting them breaks the fence and mangles
 *     the very thing the user wanted read.
 *  2. Don't pay for ids you won't use. Per-message ids are 19 characters each;
 *     the header carries the first/last pair, which is all pagination needs.
 */

import type { Config } from "./config.js";
import { BridgeError } from "./bridge-server.js";
import type { BridgeChannel, BridgeGuild, BridgeMessage, MarkedItem, SearchHit } from "./protocol.js";

const CHANNEL_TYPES: Record<number, string> = {
    0: "text",
    1: "dm",
    2: "voice",
    3: "group-dm",
    4: "category",
    5: "announcement",
    10: "announcement-thread",
    11: "thread",
    12: "private-thread",
    13: "stage",
    15: "forum",
    16: "media"
};

const DM_TYPES = new Set([1, 3]);

export function channelTypeName(type: number): string {
    return CHANNEL_TYPES[type] ?? `type-${type}`;
}

export function isDmChannel(channel: BridgeChannel): boolean {
    return channel.isDm || DM_TYPES.has(channel.type);
}

/**
 * Enforces the scope rules before any content is handed back.
 *
 * "Read my discord" should not silently mean "read all of it" — so DMs are off
 * unless asked for, and an explicit guild allowlist wins when one is configured.
 */
export function assertAllowed(cfg: Config, channel: BridgeChannel | null): void {
    if (!channel) return;

    if (cfg.denyDms && isDmChannel(channel)) {
        throw new BridgeError({
            code: "forbidden",
            message:
                "This is a DM, and DMs are disabled. Set \"denyDms\": false in the sidecar config to allow them."
        });
    }

    if (cfg.allowGuilds.length > 0) {
        if (!channel.guildId || !cfg.allowGuilds.includes(channel.guildId)) {
            throw new BridgeError({
                code: "forbidden",
                message: `Guild ${channel.guildId ?? "(none)"} is not in the sidecar's allowGuilds list.`
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Pseudonymisation
// ---------------------------------------------------------------------------

export class Pseudonymizer {
    private map = new Map<string, string>();

    constructor(private readonly enabled: boolean) {}

    private label(index: number): string {
        // user_a .. user_z, then user_aa, user_ab, ...
        let n = index;
        let out = "";
        do {
            out = String.fromCharCode(97 + (n % 26)) + out;
            n = Math.floor(n / 26) - 1;
        } while (n >= 0);
        return `user_${out}`;
    }

    private nameFor(id: string): string {
        const existing = this.map.get(id);
        if (existing) return existing;
        const label = this.label(this.map.size);
        this.map.set(id, label);
        return label;
    }

    apply(messages: BridgeMessage[]): BridgeMessage[] {
        if (!this.enabled) return messages;
        return messages.map(m => {
            const alias = this.nameFor(m.author.id);
            return {
                ...m,
                author: { ...m.author, id: alias, username: alias, displayName: alias },
                replyTo: m.replyTo
                    ? { ...m.replyTo, author: m.replyTo.author ? "(someone)" : null }
                    : null
            };
        });
    }
}

// ---------------------------------------------------------------------------
// Compact rendering
// ---------------------------------------------------------------------------

export interface CompactOptions {
    truncateAt: number;
    /**
     * IANA zone every stamp in this render is expressed in.
     *
     * Required rather than optional-with-a-default on purpose: a renderer that
     * quietly picks a zone for you is precisely how a bare clock time ends up
     * meaning something other than it appears to.
     */
    timezone: string;
    /** Emit a `⟨id⟩` marker on every message, not just in the header. */
    ids?: boolean;
    /**
     * Transcripts are one channel over minutes, so the date in the header is
     * enough and every line can be a bare clock time. Search results are the
     * opposite — scattered across channels and often years — so they carry the
     * date on every line.
     */
    stamp?: "time" | "datetime";
}

/**
 * Renders a UTC instant in a named zone.
 *
 * This used to be `iso.slice(11, 19)`, which was free but published UTC dressed
 * as an unlabelled wall clock. Everything downstream then read it as local and
 * was wrong by the offset, silently and with no way to notice.
 *
 * `hourCycle: "h23"` rather than `hour12: false`, because the latter is supposed
 * to give a 24-hour clock but renders midnight as "24" on some implementations.
 * Parts are reassembled by name rather than trusting a locale to emit them in
 * ISO order.
 */
function stamper(timezone: string) {
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });

    return (iso: string, mode: CompactOptions["stamp"]): string => {
        const at = new Date(iso);
        if (Number.isNaN(at.getTime())) return iso;

        const part: Record<string, string> = {};
        for (const { type, value } of fmt.formatToParts(at)) part[type] = value;

        const clock = `${part.hour}:${part.minute}:${part.second}`;
        return mode === "datetime" ? `${part.year}-${part.month}-${part.day} ${clock}` : clock;
    };
}

/**
 * The one place the rendered zone is spelled out.
 *
 * Every surface that emits stamps carries this, because the stamps themselves
 * can't: putting an offset on each line would cost more than the transcript
 * saves, and a header that governs the block reads once and covers all of it.
 */
export function zoneNote(timezone: string): string {
    return `times in ${timezone}`;
}

function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n…[+${text.length - limit} chars — refetch this message with discord_history around=<id> for the full body]`;
}

export function compactHeader(
    guild: BridgeGuild | null,
    channel: BridgeChannel | null,
    messages: BridgeMessage[],
    opts: CompactOptions
): string {
    const where = channel
        ? `${channel.isDm ? "" : "#"}${channel.name}${channel.isThread ? " (thread)" : ""}`
        : "(unknown channel)";
    const scope = guild ? ` · ${guild.name}` : channel?.isDm ? " · direct message" : "";
    const lines = [`── ${where}${scope} · ${channelTypeName(channel?.type ?? -1)}`];

    if (messages.length === 0) {
        lines.push("── no messages");
        return lines.join("\n");
    }

    const first = messages[0]!;
    const last = messages[messages.length - 1]!;
    const at = stamper(opts.timezone);
    lines.push(
        `── ${messages.length} messages · ${at(first.timestamp, "datetime")} → ${at(last.timestamp, "time")} · ${zoneNote(opts.timezone)} · ids ${first.id} → ${last.id}`
    );
    return lines.join("\n");
}

export function compactMessages(messages: BridgeMessage[], opts: CompactOptions): string {
    const out: string[] = [];
    const at = stamper(opts.timezone);

    for (const m of messages) {
        const marks: string[] = [];

        if (m.replyTo) {
            const who = m.replyTo.author ?? "someone";
            const what = m.replyTo.excerpt
                ? `: "${m.replyTo.excerpt}"`
                : m.replyTo.unresolved
                  ? " (body not loaded)"
                  : "";
            marks.push(`   ↳ replying to ${who}${what}`);
        }

        for (const a of m.attachments) {
            marks.push(
                `   [attachment] ${a.filename} · ${humanSize(a.size)} · ${a.contentType ?? "unknown type"} · msg ${m.id}`
            );
        }

        for (const e of m.embeds) {
            const bits = [e.title, e.description].filter(Boolean).join(" — ");
            if (bits) marks.push(`   [embed] ${truncate(bits, 300)}`);
            for (const f of e.fields) marks.push(`   [embed] ${f.name}: ${truncate(f.value, 200)}`);
        }

        if (m.reactions.length) {
            marks.push(`   ${m.reactions.map(r => `${r.emoji} ${r.count}`).join("  ")}`);
        }

        const suffix = [
            m.editedTimestamp ? "(edited)" : null,
            m.pinned ? "(pinned)" : null,
            opts.ids ? `⟨${m.id}⟩` : null
        ]
            .filter(Boolean)
            .join(" ");

        const name = m.author.displayName + (m.author.bot ? " [bot]" : "");
        const body = truncate(m.content, opts.truncateAt);
        const stamp = at(m.timestamp, opts.stamp);

        if (body.includes("\n")) {
            // Header line, then the body verbatim on its own lines. No indent —
            // see the note at the top of this file.
            out.push(`[${stamp}] ${name}:${suffix ? " " + suffix : ""}`);
            if (marks.length) out.push(...marks);
            out.push(body);
        } else {
            const line = body.length ? ` ${body}` : "";
            out.push(`[${stamp}] ${name}:${line}${suffix ? " " + suffix : ""}`);
            if (marks.length) out.push(...marks);
        }
    }

    return out.join("\n");
}

export function renderTranscript(
    guild: BridgeGuild | null,
    channel: BridgeChannel | null,
    messages: BridgeMessage[],
    opts: CompactOptions
): string {
    const header = compactHeader(guild, channel, messages, opts);
    if (messages.length === 0) return header;
    return `${header}\n\n${compactMessages(messages, opts)}`;
}

// ---------------------------------------------------------------------------
// Mark ages
// ---------------------------------------------------------------------------

/*
 * The bug these exist for: the user marked a few things on Monday, asked about
 * something else on Wednesday, and got Monday's marks blended into the answer
 * with nothing in the output to suggest they were old. The header printed
 * `markedAt` as a raw UTC ISO stamp, which is exactly the kind of thing a reader
 * skims past.
 *
 * So the age comes first, in words, and anything that isn't from the current
 * working day gets called out. The plugin also expires marks on its own, but the
 * two measures are deliberately different and never conflict: the plugin drops
 * marks at a hard cap, this only annotates. A soft signal at "not today" and a
 * hard cap days later means the model can still see yesterday's mark and reason
 * about it, rather than a queue that silently emptied itself overnight.
 */

/**
 * Older than this and a mark is called out even if it is still the same local
 * day. The calendar-day test alone would let a 00:30 mark read at 23:00 pass as
 * current, which is the one case where "today" is a lie.
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface MarkAge {
    /** Milliseconds old, or null when `markedAt` could not be parsed. */
    ms: number | null;
    /** "just now", "19 hours ago", "unknown age" — what actually gets printed. */
    label: string;
    stale: boolean;
}

/** The local calendar date of an instant, as `YYYY-MM-DD`, in a named zone. */
function localDay(timezone: string, at: Date): string {
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    });
    const part: Record<string, string> = {};
    // Reassembled by name rather than trusting a locale to emit the parts in
    // ISO order — same reasoning as `stamper()` above.
    for (const { type, value } of fmt.formatToParts(at)) part[type] = value;
    return `${part.year}-${part.month}-${part.day}`;
}

function plural(n: number, unit: string): string {
    return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * How old a mark is, in the words a reader actually wants.
 *
 * `now` is injectable so the buckets can be tested directly against a fixed
 * instant; every caller in the sidecar leaves it alone.
 *
 * An unparseable stamp is reported as `unknown age` and treated as stale rather
 * than dropped. Binning what the user marked over a `Date.parse` quirk is the
 * wrong failure, and calling it stale errs in the safe direction — it gets
 * flagged, not hidden.
 */
export function markAge(markedAt: string, timezone: string, now: number = Date.now()): MarkAge {
    const at = new Date(markedAt);
    if (Number.isNaN(at.getTime())) return { ms: null, label: "unknown age", stale: true };

    // Clamped at zero: a mark stamped slightly in the future is clock skew
    // between two machines' clocks, not a message from the future.
    const ms = Math.max(0, now - at.getTime());

    let label: string;
    if (ms < 60_000) label = "just now";
    else if (ms < 90 * 60_000) label = plural(Math.round(ms / 60_000), "minute");
    else if (ms < 36 * 3_600_000) label = plural(Math.round(ms / 3_600_000), "hour");
    else label = plural(Math.round(ms / 86_400_000), "day");

    const differentDay = localDay(timezone, at) !== localDay(timezone, new Date(now));
    return { ms, label, stale: ms >= STALE_AFTER_MS || differentDay };
}

/**
 * The `### mark N` line.
 *
 * Relative age first, because that is what changes how the block underneath
 * should be read; the absolute stamp second, in the configured zone, because
 * that is what you cross-reference against the Discord client sitting next to
 * you. This is also the last place in the sidecar that used to publish a raw
 * UTC ISO string straight out of the plugin.
 */
export function renderMarkHeader(item: MarkedItem, timezone: string, now?: number): string {
    const age = markAge(item.markedAt, timezone, now);
    const when = stamper(timezone)(item.markedAt, "datetime");
    const flag = age.stale ? "⚠ " : "";
    const note = item.note ? ` · note: ${item.note}` : "";
    return `### mark ${item.markId} · ${flag}${age.label} · ${when}${note}`;
}

/**
 * The preamble above a queue of marks.
 *
 * The second line only appears when something is actually stale, because a
 * warning that prints every time is a warning nobody reads. It names
 * `consume=true` because that is the specific thing that stops the same old
 * marks coming back on the next read.
 */
export function markQueueNote(items: MarkedItem[], timezone: string, now?: number): string {
    if (!items.length) return "";

    const ages = items.map(i => markAge(i.markedAt, timezone, now));
    // An unknown age sorts as the oldest thing in the queue: it is the entry we
    // are least able to vouch for, so it should not be able to hide behind a
    // fresh one. Reduced rather than indexed — `noUncheckedIndexedAccess` is on.
    const rank = (a: MarkAge) => a.ms ?? Number.POSITIVE_INFINITY;
    const newest = ages.reduce((a, b) => (rank(b) < rank(a) ? b : a));
    const oldest = ages.reduce((a, b) => (rank(b) > rank(a) ? b : a));

    const span =
        items.length === 1
            ? newest.label
            : `newest ${newest.label}, oldest ${oldest.label}`;
    const lines = [`── ${items.length} mark${items.length === 1 ? "" : "s"} · ${span}`];

    const stale = ages.filter(a => a.stale).length;
    if (stale) {
        const which =
            items.length === 1
                ? "This mark is not from the current session"
                : `${stale} of these ${stale === 1 ? "is" : "are"} not from the current session`;
        lines.push(
            `── ${which} — marked before today, or hours ago — and may not be what the user is asking about now. ` +
                "Say which marks you used. If you have acted on them, call this tool again with consume=true, " +
                "or tell the user they can clear the queue from the chat-bar menu in Discord."
        );
    }

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

export interface SearchRenderInput {
    guild: BridgeGuild | null;
    hits: SearchHit[];
    totalResults: number;
    offset: number;
    indexing: boolean;
}

/**
 * Renders search hits grouped by channel.
 *
 * A transcript is one conversation in order; search results are a scattered
 * set, so they get a different shape. Grouping by channel keeps related hits
 * together and says where each one lives, and every hit keeps its id, because
 * the only useful next step from a search result is to go and read around it.
 */
export function renderSearchResults(input: SearchRenderInput, opts: CompactOptions): string {
    const { guild, hits, totalResults, offset, indexing } = input;

    const scope = guild ? ` · ${guild.name}` : "";
    const shown = hits.length
        ? `showing ${offset + 1}-${offset + hits.length} of ${totalResults}`
        : `${totalResults} matches`;
    const lines = [`── search${scope} · ${shown} · ${zoneNote(opts.timezone)}`];

    if (indexing) {
        lines.push("── Discord is still building this server's search index; results may be incomplete.");
    }

    if (!hits.length) {
        lines.push("── no matches");
        return lines.join("\n");
    }

    // Preserve Discord's ordering of the hits themselves; only cluster runs of
    // the same channel so the reader isn't re-reading the channel name.
    const groups: { channel: BridgeChannel | null; messages: BridgeMessage[]; }[] = [];
    for (const hit of hits) {
        const last = groups[groups.length - 1];
        if (last && last.channel?.id === hit.channel?.id) last.messages.push(hit.message);
        else groups.push({ channel: hit.channel, messages: [hit.message] });
    }

    const blocks = groups.map(g => {
        const where = g.channel
            ? `${g.channel.isDm ? "" : "#"}${g.channel.name}${g.channel.isThread ? " (thread)" : ""} · ${channelTypeName(g.channel.type)}`
            : "(unknown channel)";
        return `── ${where}\n${compactMessages(g.messages, { ...opts, stamp: "datetime" })}`;
    });

    const more =
        offset + hits.length < totalResults
            ? `\n\n(more matches — repeat with offset=${offset + hits.length})`
            : "";

    return `${lines.join("\n")}\n\n${blocks.join("\n\n")}${more}`;
}
