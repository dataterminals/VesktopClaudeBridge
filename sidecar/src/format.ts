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
import type { BridgeChannel, BridgeGuild, BridgeMessage } from "./protocol.js";

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
    /** Emit a `⟨id⟩` marker on every message, not just in the header. */
    ids?: boolean;
}

function hhmmss(iso: string): string {
    return iso.length >= 19 ? iso.slice(11, 19) : iso;
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
    messages: BridgeMessage[]
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
    lines.push(
        `── ${messages.length} messages · ${first.timestamp} → ${hhmmss(last.timestamp)} · ids ${first.id} → ${last.id}`
    );
    return lines.join("\n");
}

export function compactMessages(messages: BridgeMessage[], opts: CompactOptions): string {
    const out: string[] = [];

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
        const stamp = hhmmss(m.timestamp);

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
    const header = compactHeader(guild, channel, messages);
    if (messages.length === 0) return header;
    return `${header}\n\n${compactMessages(messages, opts)}`;
}
