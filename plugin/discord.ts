/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Everything that touches Discord's internals lives here.
 *
 * This is the file that earns the project: the client already knows who
 * `<@1399482100000000000>` is, which channel `<#...>` points at, and what the
 * message being replied to actually said. Resolving all of that here — where
 * the stores are — is the difference between a transcript worth reading and a
 * wall of raw markup.
 *
 * Everything below is normalised into the shapes in protocol.ts, because the
 * cached Message records and the REST payloads disagree about almost every
 * field name (`editedTimestamp` vs `edited_timestamp`, Moment vs ISO string,
 * and so on).
 */

import {
    ChannelStore,
    Constants,
    GuildChannelStore,
    GuildMemberStore,
    GuildRoleStore,
    GuildStore,
    MessageStore,
    RestAPI,
    SelectedChannelStore,
    SelectedGuildStore,
    UserStore
} from "@webpack/common";

import type {
    BridgeAttachment,
    BridgeChannel,
    BridgeEmbed,
    BridgeGuild,
    BridgeMessage,
    BridgeReaction,
    BridgeReplyRef,
    BridgeUser,
    RpcError
} from "./protocol";

const DM_CHANNEL_TYPES = new Set([1, 3]);
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

const TEXTUAL_EXTENSIONS = new Set([
    "log", "txt", "json", "yml", "yaml", "md", "ini", "cfg", "conf", "csv", "tsv",
    "diff", "patch", "lua", "ts", "tsx", "js", "jsx", "py", "cs", "cpp", "cc", "h",
    "hpp", "xml", "toml", "sh", "ps1", "bat", "sql", "rs", "go", "java", "kt", "css"
]);

export function fail(code: RpcError["code"], message: string): RpcError {
    return { code, message };
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Cached records hand back Moments, REST hands back ISO strings. Take either. */
function toIso(value: unknown): string | null {
    if (!value) return null;
    if (typeof value === "string") return new Date(value).toISOString();
    if (typeof value === "object" && typeof (value as any).toISOString === "function") {
        try {
            return (value as any).toISOString();
        } catch {
            return null;
        }
    }
    return null;
}

export function toBridgeUser(raw: any, guildId: string | null): BridgeUser {
    const id = String(raw?.id ?? "0");
    const username = raw?.username ?? "unknown";
    const nick = guildId ? GuildMemberStore?.getNick?.(guildId, id) : null;
    return {
        id,
        username,
        displayName: nick || raw?.globalName || raw?.global_name || username,
        bot: Boolean(raw?.bot)
    };
}

export function currentUser(): BridgeUser | null {
    const me = UserStore.getCurrentUser();
    return me ? toBridgeUser(me, null) : null;
}

// ---------------------------------------------------------------------------
// Content resolution
// ---------------------------------------------------------------------------

const MENTION_USER = /<@!?(\d+)>/g;
const MENTION_ROLE = /<@&(\d+)>/g;
const MENTION_CHANNEL = /<#(\d+)>/g;
const CUSTOM_EMOJI = /<a?:(\w+):\d+>/g;
const TIMESTAMP = /<t:(-?\d+)(?::[tTdDfFR])?>/g;

/**
 * Splits on code spans so their contents survive untouched.
 *
 * A pasted log full of `<@1234>`-looking noise is exactly the kind of thing
 * people ask to have read, and rewriting the inside of a fence would corrupt
 * the one part of the message that had to stay byte-exact.
 */
const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]*`)/g;

function resolveSegment(text: string, guildId: string | null): string {
    return text
        .replace(MENTION_USER, (_m, id: string) => {
            const user = UserStore.getUser(id);
            if (!user) return `@unknown-user(${id})`;
            return `@${toBridgeUser(user, guildId).displayName}`;
        })
        .replace(MENTION_ROLE, (_m, id: string) => {
            // Roles live on GuildRoleStore, not GuildStore.
            const role = guildId ? GuildRoleStore.getRolesSnapshot(guildId)?.[id] : null;
            return role?.name ? `@${role.name}` : `@role(${id})`;
        })
        .replace(MENTION_CHANNEL, (_m, id: string) => {
            const channel = ChannelStore.getChannel(id);
            return channel?.name ? `#${channel.name}` : `#channel(${id})`;
        })
        .replace(CUSTOM_EMOJI, (_m, name: string) => `:${name}:`)
        .replace(TIMESTAMP, (_m, seconds: string) => {
            const ms = Number.parseInt(seconds, 10) * 1000;
            return Number.isFinite(ms) ? new Date(ms).toISOString() : _m;
        });
}

export function resolveContent(content: string, guildId: string | null): string {
    if (!content) return "";
    return content
        .split(CODE_SPAN)
        .map((part, index) => (index % 2 === 1 ? part : resolveSegment(part, guildId)))
        .join("");
}

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

export function toBridgeGuild(guild: any): BridgeGuild | null {
    if (!guild) return null;
    return { id: String(guild.id), name: guild.name ?? "(unnamed server)" };
}

export function toBridgeChannel(channel: any): BridgeChannel | null {
    if (!channel) return null;
    const type = Number(channel.type ?? -1);
    const isDm = DM_CHANNEL_TYPES.has(type);
    return {
        id: String(channel.id),
        name: channel.name || (isDm ? dmLabel(channel) : "(unnamed)"),
        type,
        topic: channel.topic ?? null,
        guildId: channel.guild_id ? String(channel.guild_id) : null,
        parentId: channel.parent_id ? String(channel.parent_id) : null,
        isThread: THREAD_CHANNEL_TYPES.has(type),
        isDm
    };
}

function dmLabel(channel: any): string {
    const ids: string[] = channel.recipients ?? [];
    const names = ids
        .map(id => UserStore.getUser(id))
        .filter(Boolean)
        .map((u: any) => u.username);
    return names.length ? `dm:${names.join(",")}` : "dm";
}

function toAttachment(raw: any): BridgeAttachment {
    const filename = raw?.filename ?? "attachment";
    const contentType = raw?.content_type ?? raw?.contentType ?? null;
    const extension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
    return {
        id: String(raw?.id ?? "0"),
        filename,
        size: Number(raw?.size ?? 0),
        contentType,
        url: raw?.url ?? raw?.proxy_url ?? "",
        likelyText:
            TEXTUAL_EXTENSIONS.has(extension) ||
            (typeof contentType === "string" &&
                (contentType.startsWith("text/") || contentType === "application/json"))
    };
}

function toEmbed(raw: any): BridgeEmbed {
    return {
        type: raw?.type ?? null,
        title: raw?.rawTitle ?? raw?.title ?? null,
        description: raw?.rawDescription ?? raw?.description ?? null,
        url: raw?.url ?? null,
        author: raw?.author?.name ?? null,
        footer: raw?.footer?.text ?? null,
        fields: Array.isArray(raw?.fields)
            ? raw.fields.map((f: any) => ({
                  name: f?.rawName ?? f?.name ?? "",
                  value: f?.rawValue ?? f?.value ?? ""
              }))
            : []
    };
}

function toReaction(raw: any): BridgeReaction {
    const emoji = raw?.emoji ?? {};
    return {
        emoji: emoji.id ? `:${emoji.name}:` : (emoji.name ?? "?"),
        count: Number(raw?.count ?? 0),
        me: Boolean(raw?.me)
    };
}

function toReplyRef(raw: any, channelId: string, guildId: string | null): BridgeReplyRef | null {
    const ref = raw?.messageReference ?? raw?.message_reference;
    if (!ref) return null;

    const referencedId = ref.message_id ? String(ref.message_id) : null;

    // REST embeds the referenced message; the cache usually already has it.
    const referenced =
        raw?.referenced_message ??
        (referencedId ? MessageStore.getMessage(ref.channel_id ?? channelId, referencedId) : null);

    if (!referenced) {
        return { id: referencedId, author: null, excerpt: null, unresolved: true };
    }

    const author = toBridgeUser(referenced.author, guildId);
    const body = resolveContent(referenced.content ?? "", guildId).replace(/\s+/g, " ").trim();

    return {
        id: referencedId,
        author: author.displayName,
        excerpt: body.length > 120 ? `${body.slice(0, 120)}…` : body || null,
        unresolved: false
    };
}

export function toBridgeMessage(raw: any, channel: BridgeChannel | null): BridgeMessage {
    const channelId = String(raw?.channel_id ?? channel?.id ?? "0");
    const guildId = channel?.guildId ?? null;

    return {
        id: String(raw?.id ?? "0"),
        channelId,
        guildId,
        author: toBridgeUser(raw?.author, guildId),
        timestamp: toIso(raw?.timestamp) ?? new Date(0).toISOString(),
        editedTimestamp: toIso(raw?.editedTimestamp ?? raw?.edited_timestamp),
        content: resolveContent(raw?.content ?? "", guildId),
        replyTo: toReplyRef(raw, channelId, guildId),
        attachments: Array.isArray(raw?.attachments) ? raw.attachments.map(toAttachment) : [],
        embeds: Array.isArray(raw?.embeds) ? raw.embeds.map(toEmbed) : [],
        reactions: Array.isArray(raw?.reactions) ? raw.reactions.map(toReaction) : [],
        pinned: Boolean(raw?.pinned),
        link: `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${raw?.id}`
    };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function selectedChannel(): BridgeChannel | null {
    const id = SelectedChannelStore.getChannelId();
    return id ? toBridgeChannel(ChannelStore.getChannel(id)) : null;
}

export function selectedGuild(): BridgeGuild | null {
    const id = SelectedGuildStore.getGuildId();
    return id ? toBridgeGuild(GuildStore.getGuild(id)) : null;
}

/** Messages already in the client's cache — instant, but only the recent tail. */
export function cachedMessages(channelId: string, limit: number): BridgeMessage[] {
    const channel = toBridgeChannel(ChannelStore.getChannel(channelId));
    const store: any = MessageStore.getMessages(channelId);
    const all: any[] = store?.toArray?.() ?? store?._array ?? [];
    return all.slice(-limit).map(m => toBridgeMessage(m, channel));
}

export interface HistoryQuery {
    channelId: string;
    limit: number;
    before?: string;
    after?: string;
    around?: string;
}

/**
 * Goes to the API for history the cache doesn't hold.
 *
 * This rides the client's own authenticated REST layer, so it is the same
 * request the app would make if you scrolled up — no separate token, no bot.
 */
export async function fetchMessages(query: HistoryQuery): Promise<BridgeMessage[]> {
    const channel = toBridgeChannel(ChannelStore.getChannel(query.channelId));

    const params: Record<string, string | number> = { limit: query.limit };
    if (query.before) params.before = query.before;
    if (query.after) params.after = query.after;
    if (query.around) params.around = query.around;

    let response: any;
    try {
        response = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(query.channelId),
            query: params,
            retries: 2
        });
    } catch (err: any) {
        const status = err?.status ?? err?.body?.code;
        throw fail(
            status === 403 ? "forbidden" : "discord_error",
            status === 403
                ? `No permission to read channel ${query.channelId}.`
                : `Discord rejected the history request (${status ?? "unknown"}).`
        );
    }

    const body: any[] = Array.isArray(response?.body) ? response.body : [];
    // The API returns newest-first; everything downstream assumes chronological.
    return body.reverse().map(m => toBridgeMessage(m, channel));
}

export function listGuilds(): BridgeGuild[] {
    const guilds: Record<string, any> = GuildStore.getGuilds() ?? {};
    return Object.values(guilds)
        .map(toBridgeGuild)
        .filter((g): g is BridgeGuild => g !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function listChannels(guildId: string): BridgeChannel[] {
    const groups: any = GuildChannelStore?.getChannels?.(guildId) ?? {};
    const out: BridgeChannel[] = [];

    for (const value of Object.values(groups)) {
        if (!Array.isArray(value)) continue;
        for (const entry of value) {
            const channel = toBridgeChannel((entry as any)?.channel ?? entry);
            // Categories and voice channels have nothing to read.
            if (channel && channel.type !== 4 && channel.type !== 2) out.push(channel);
        }
    }

    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parses a discord.com/channels/<guild|@me>/<channel>/<message> link. */
export function parseMessageLink(url: string): { guildId: string | null; channelId: string; messageId: string; } {
    const match = /channels\/(@me|\d+)\/(\d+)\/(\d+)/.exec(url);
    if (!match) {
        throw fail("bad_params", `"${url}" is not a Discord message link.`);
    }
    return {
        guildId: match[1] === "@me" ? null : match[1],
        channelId: match[2],
        messageId: match[3]
    };
}
