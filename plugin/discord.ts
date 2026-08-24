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
    BridgeDm,
    BridgeEmbed,
    BridgeGuild,
    BridgeMessage,
    BridgePoll,
    BridgePollAnswer,
    BridgeReaction,
    BridgeReplyRef,
    BridgeUser,
    RpcError
} from "./protocol";

const DM_CHANNEL_TYPES = new Set([1, 3]);
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

/**
 * Forum (15) and media (16) channels.
 *
 * They hold threads rather than messages, so the id of one is not something
 * `history` can read — which is why the copy-ids menu labels a forum parent
 * differently from a channel parent instead of calling both "channel".
 */
const FORUM_CHANNEL_TYPES = new Set([15, 16]);

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
        isDm,
        // DMs only. This is what the sidecar's `allowDms` list is matched
        // against, and a guild channel has no recipients to match -- see the
        // note on BridgeChannel.recipientIds for why it rides here at all.
        recipientIds: isDm ? recipientIds(channel) : undefined
    };
}

/**
 * The recipient ids on a private channel, as strings.
 *
 * Cached Channel records hold a bare array of ids; a REST channel payload holds
 * whole user objects under the same key. Both are read, for the same reason
 * every other mapper in this file reads two spellings of everything.
 */
function recipientIds(channel: any): string[] {
    const raw: any[] = Array.isArray(channel?.recipients) ? channel.recipients : [];
    return raw
        .map(r => (r !== null && typeof r === "object" ? r.id : r))
        .filter(id => id !== null && id !== undefined)
        .map(id => String(id));
}

/**
 * The people in a private channel, as users.
 *
 * `recipients` is only ids, so the names come from UserStore -- and when it has
 * no record of somebody, from `rawRecipients`, which the channel record carries
 * for exactly that case. A DM with someone you share no server with is the
 * ordinary way to reach that branch, and it is also the DM most worth being
 * able to find by name.
 *
 * Somebody neither store knows keeps their id rather than being dropped. A
 * recipient list one name short is not a partial answer, it is a different
 * channel -- and picking the wrong DM out of this list is the exact failure the
 * `dms` method exists to stop.
 */
export function dmRecipients(channel: any): BridgeUser[] {
    const known = new Map<string, any>();
    const pools: any[][] = [
        Array.isArray(channel?.recipients) ? channel.recipients : [],
        Array.isArray(channel?.rawRecipients) ? channel.rawRecipients : []
    ];
    for (const pool of pools) {
        for (const entry of pool) {
            if (entry !== null && typeof entry === "object" && entry.id != null) {
                known.set(String(entry.id), entry);
            }
        }
    }

    const out: BridgeUser[] = [];
    for (const id of recipientIds(channel)) {
        const raw = UserStore.getUser(id) ?? known.get(id);
        out.push(
            raw
                ? toBridgeUser(raw, null)
                : { id, username: `unknown(${id})`, displayName: `unknown(${id})`, bot: false }
        );
    }
    return out;
}

function dmLabel(channel: any): string {
    const names = dmRecipients(channel).map(u => u.username);
    return names.length ? `dm:${names.join(",")}` : "dm";
}

/** Looks a channel up by id. Uncached ids come back undefined, so this is null-safe both ways. */
export function channelById(id: string | null | undefined): BridgeChannel | null {
    if (!id) return null;
    return toBridgeChannel(ChannelStore.getChannel(id));
}

/** A forum or media channel: a container of threads, with no messages of its own. */
export function isForum(channel: BridgeChannel): boolean {
    return FORUM_CHANNEL_TYPES.has(channel.type);
}

/**
 * The channel a thread hangs off, or null if this isn't a thread.
 *
 * The isThread gate is the entire point of the function. `parent_id` is
 * populated for ordinary guild channels too, where it holds the *category* they
 * are filed under — and a category has nothing in it to read, which is why
 * listChannels already drops type 4. An ungated version would hand back a
 * category id under the label "parent channel", and the only way to find out
 * would be to watch `history` fail on it.
 */
export function parentChannel(channel: BridgeChannel): BridgeChannel | null {
    if (!channel.isThread) return null;
    return channelById(channel.parentId);
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
        emojiId: emoji.id ? String(emoji.id) : null,
        count: Number(raw?.count ?? 0),
        me: Boolean(raw?.me)
    };
}

function toPollAnswer(raw: any, counts: Map<number, { count: number; me: boolean; }>): BridgePollAnswer {
    const id = Number(raw?.answer_id ?? raw?.answerId ?? 0);
    const media = raw?.poll_media ?? raw?.pollMedia ?? {};
    const tally = counts.get(id);
    return {
        id,
        text: media?.text ?? null,
        count: tally ? tally.count : null,
        me: tally ? tally.me : false
    };
}

/**
 * The poll attached to a message, if it is one.
 *
 * Discord ships the tally inline as `results.answer_counts` — but only once it
 * has one to ship. A poll that is still open, or one pulled cold out of history
 * the client never rendered, comes back with the question and the options and
 * no numbers, so an absent tally is carried as null per answer rather than
 * flattened to zero.
 *
 * Both spellings are read for the same reason every other mapper here does:
 * cached MessageRecords and REST payloads disagree about case.
 */
function toPoll(raw: any): BridgePoll | null {
    const poll = raw?.poll;
    if (!poll) return null;

    const results = poll.results ?? {};
    const rawCounts = results.answer_counts ?? results.answerCounts;
    const counts = new Map<number, { count: number; me: boolean; }>();
    if (Array.isArray(rawCounts)) {
        for (const c of rawCounts) {
            counts.set(Number(c?.id ?? 0), {
                count: Number(c?.count ?? 0),
                me: Boolean(c?.me_voted ?? c?.meVoted)
            });
        }
    }

    const answers = (Array.isArray(poll.answers) ? poll.answers : []).map((a: any) =>
        toPollAnswer(a, counts)
    );

    return {
        question: poll.question?.text ?? null,
        answers,
        expiresAt: toIso(poll.expiry),
        allowMultiselect: Boolean(poll.allow_multiselect ?? poll.allowMultiselect),
        finalized: Boolean(results.is_finalized ?? results.isFinalized),
        // Distinguishes "no tally sent" from "a tally that happens to sum to 0".
        totalVotes: counts.size
            ? answers.reduce((n: number, a: BridgePollAnswer) => n + (a.count ?? 0), 0)
            : null
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
    // One id for both fields. They used to disagree — `id` fell back to "0"
    // while the link template interpolated the bare `raw?.id`, so a message
    // without one produced a permalink ending in /undefined.
    const id = String(raw?.id ?? "0");

    return {
        id,
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
        poll: toPoll(raw),
        pinned: Boolean(raw?.pinned),
        link: messageLink(guildId, channelId, id)
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
 * Discord's hard ceiling on `limit` for GET /channels/:id/messages.
 *
 * Asking for more is not clamped server-side, it's a 400 — so anything above
 * this has to be paged rather than requested in one go.
 */
const MAX_PER_REQUEST = 100;

/** One REST page, newest-first, exactly as Discord returns it. */
async function fetchPage(query: HistoryQuery): Promise<any[]> {
    const params: Record<string, string | number> = {
        limit: Math.min(query.limit, MAX_PER_REQUEST)
    };
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

    return Array.isArray(response?.body) ? response.body : [];
}

/** Snowflakes sort chronologically, but they're strings and outgrow Number. */
function snowflakeAsc(a: string, b: string): number {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Goes to the API for history the cache doesn't hold.
 *
 * This rides the client's own authenticated REST layer, so it is the same
 * request the app would make if you scrolled up — no separate token, no bot.
 *
 * Anything over `MAX_PER_REQUEST` is paged, because Discord rejects a bigger
 * `limit` outright rather than returning what it can. Which way we walk depends
 * on the anchor:
 *
 *  - `after`  walks *forward* from the newest id of each page, so "this message
 *    and everything after it" can run past 100.
 *  - everything else walks *backward* from the oldest id, the usual scrollback.
 *  - `around` centres a fixed window, so a second page has no coherent meaning
 *    and it takes Discord's cap as-is.
 *
 * Discord hands back newest-first within a page, and forward paging makes the
 * pages themselves ascend, so the result is sorted at the end rather than
 * reversed — concatenation order isn't monotonic in both modes.
 */
export async function fetchMessages(query: HistoryQuery): Promise<BridgeMessage[]> {
    const channel = toBridgeChannel(ChannelStore.getChannel(query.channelId));

    const forward = Boolean(query.after);
    const pageable = !query.around;

    /**
     * Discord discards `before` when `after` is also present — verified live: it
     * returns messages well past the bound, with no error and no intersection of
     * the two anchors. So the upper bound is enforced here instead of on the
     * wire, which is also what makes "everything between A and B" work at all.
     *
     * Matching Discord's own convention, the bound is exclusive.
     */
    const upperBound = forward && query.before ? BigInt(query.before) : null;

    const collected: any[] = [];
    const seen = new Set<string>();
    // Don't send a parameter the server is going to ignore.
    let before = forward ? undefined : query.before;
    let after = query.after;

    // Pages are capped at MAX_PER_REQUEST, so this can only bite if the cursor
    // stops advancing; it's a backstop against looping on a malformed response.
    const maxPages = Math.ceil(query.limit / MAX_PER_REQUEST) + 1;

    for (let page = 0; page < maxPages; page++) {
        const remaining = query.limit - collected.length;
        if (remaining <= 0) break;

        const batch = await fetchPage({ ...query, limit: remaining, before, after });
        if (!batch.length) break;

        let passedBound = false;
        for (const m of batch) {
            const id = String(m?.id ?? "");
            if (!id || seen.has(id)) continue;
            if (upperBound !== null && BigInt(id) >= upperBound) {
                passedBound = true;
                continue;
            }
            seen.add(id);
            collected.push(m);
        }

        // Walked past the far anchor, so the requested window is complete.
        if (passedBound) break;

        // A short page means we've reached the end of the channel in this direction.
        if (batch.length < Math.min(remaining, MAX_PER_REQUEST)) break;
        if (!pageable) break;

        // Batches arrive newest-first: walk forward off the head, back off the tail.
        const next = forward ? String(batch[0]?.id ?? "") : String(batch[batch.length - 1]?.id ?? "");
        if (!next || next === (forward ? after : before)) break;
        if (forward) after = next;
        else before = next;
    }

    collected.sort((a, b) => snowflakeAsc(String(a?.id ?? "0"), String(b?.id ?? "0")));
    return collected.map(m => toBridgeMessage(m, channel));
}

export interface SearchQuery {
    guildId?: string;
    channelId?: string;
    content?: string;
    authorId?: string;
    mentions?: string;
    has?: string;
    before?: string;
    after?: string;
    limit: number;
    offset: number;
    sortOrder?: "asc" | "desc";
}

/**
 * Discord's own search index, which is the only sane way to answer "where did
 * someone mention this" — paging back through `history` is O(the whole channel).
 *
 * Two things about this endpoint are not obvious and both were confirmed
 * against a live client rather than inferred:
 *
 *  - `SEARCH_CHANNEL` is for DMs only. Point it at a guild text channel and it
 *    returns 400 `Cannot execute action on this channel type` (50024). To scope
 *    a guild search to one channel you pass `channel_id` to `SEARCH_GUILD`.
 *  - `body.messages` is an array *of arrays*. Each group is a hit plus optional
 *    surrounding context, and the hit itself is flagged `hit: true`.
 *
 * Search payloads also carry no `reactions` and no `referenced_message`, so
 * those degrade to empty/unresolved unless the cache happens to have the
 * message. That's honest rather than wrong, but it's why a hit can look
 * thinner than the same message read through `history`.
 */
export async function searchMessages(query: SearchQuery): Promise<{
    hits: { message: BridgeMessage; channel: BridgeChannel | null; }[];
    totalResults: number;
    indexing: boolean;
}> {
    const params: Record<string, string | number> = {
        limit: query.limit,
        offset: query.offset
    };
    if (query.content) params.content = query.content;
    if (query.authorId) params.author_id = query.authorId;
    if (query.mentions) params.mentions = query.mentions;
    if (query.has) params.has = query.has;
    // Discord bounds by snowflake, not date; `before`/`after` are message ids.
    if (query.before) params.max_id = query.before;
    if (query.after) params.min_id = query.after;
    if (query.sortOrder) {
        params.sort_by = "timestamp";
        params.sort_order = query.sortOrder;
    }

    const url = query.guildId
        ? Constants.Endpoints.SEARCH_GUILD(query.guildId)
        : Constants.Endpoints.SEARCH_CHANNEL(query.channelId!);

    // Only meaningful for a guild search; a DM search is already scoped.
    if (query.guildId && query.channelId) params.channel_id = query.channelId;

    let response: any;
    try {
        response = await RestAPI.get({ url, query: params, retries: 1 });
    } catch (err: any) {
        const status = err?.status;
        const code = err?.body?.code;
        if (code === 50024) {
            throw fail(
                "bad_params",
                "Discord refused to search that channel directly. Pass guildId (optionally with channelId) for guild channels — channel-only search is for DMs."
            );
        }
        throw fail(
            status === 403 ? "forbidden" : "discord_error",
            status === 403
                ? "No permission to search there."
                : `Discord rejected the search (${status ?? "unknown"}${code ? `, code ${code}` : ""}).`
        );
    }

    const body = response?.body ?? {};

    // 202 means the index is still being built; Discord returns no messages yet.
    const indexing = response?.status === 202 || Boolean(body.doing_deep_historical_index);

    const groups: any[] = Array.isArray(body.messages) ? body.messages : [];
    const hits = groups
        .map(group => (Array.isArray(group) ? (group.find((m: any) => m?.hit) ?? group[0]) : group))
        .filter(Boolean)
        .map(raw => {
            // Results span channels, so each hit resolves its own.
            const channel = toBridgeChannel(ChannelStore.getChannel(String(raw.channel_id)));
            return { message: toBridgeMessage(raw, channel), channel };
        });

    return { hits, totalResults: Number(body.total_results ?? hits.length), indexing };
}

/** Discord's ceiling on `limit` for the reactions route, same shape as messages. */
const MAX_REACTORS_PER_REQUEST = 100;

/**
 * Who reacted, not just how many.
 *
 * `history` renders `👍 194`, which answers "how popular was this" and cannot
 * answer "was I one of them" or "which of these people also turned up later".
 * Discord pages this 100 at a time, keyed by the emoji rather than an index —
 * and a custom emoji has to be addressed as `name:id`, which is the whole
 * reason BridgeReaction carries the id.
 *
 * The route answers for one *kind* of reaction at a time — `type=0` plain,
 * `type=1` super — while the count on the message adds both together. Ask only
 * for the default and a message super-reacted thirteen times reports thirteen
 * and then hands back nobody, which reads exactly like a message whose reactors
 * are unreadable. So the burst list is fetched too, but only once the plain one
 * has genuinely run out: the ordinary reaction stays one request.
 *
 * A rejection is reported rather than thrown. One unreadable reaction should
 * not lose the five beside it that came back fine, and "Discord refused" has to
 * stay distinguishable from "nobody is there" — those are opposite answers to
 * "who is on this list", and an empty array alone cannot tell them apart.
 */
export async function fetchReactors(
    channelId: string,
    messageId: string,
    reaction: BridgeReaction,
    limit: number
): Promise<{ users: BridgeUser[]; truncated: boolean; burst: number; error: string | null; }> {
    const bare = reaction.emoji.replace(/^:|:$/g, "");
    const key = reaction.emojiId ? `${bare}:${reaction.emojiId}` : reaction.emoji;
    const url = `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(key)}`;
    const guildId = toBridgeChannel(ChannelStore.getChannel(channelId))?.guildId ?? null;

    const users: BridgeUser[] = [];
    const seen = new Set<string>();
    let burst = 0;

    // Pages one type to exhaustion or to the caller's budget, whichever comes
    // first. Returns whether Discord ran out of people, which is what decides
    // if there is any point asking for the other type.
    const collect = async (type: 0 | 1): Promise<boolean> => {
        let after: string | undefined;

        while (users.length < limit) {
            const want = Math.min(limit - users.length, MAX_REACTORS_PER_REQUEST);
            const response = await RestAPI.get({
                url,
                query: after ? { limit: want, type, after } : { limit: want, type },
                retries: 2
            });

            const page: any[] = Array.isArray(response?.body) ? response.body : [];
            for (const u of page) {
                const mapped = toBridgeUser(u, guildId);
                // Nothing says a super-reactor cannot also hold a plain one, and
                // the same name twice would inflate an intersection silently.
                if (seen.has(mapped.id)) continue;
                seen.add(mapped.id);
                users.push(mapped);
                if (type === 1) burst++;
            }

            // A short page is the end of the list — there is no cursor past it.
            if (page.length < want) return true;

            after = page[page.length - 1]?.id;
            if (!after) return true;
        }

        return false;
    };

    let ranOut: boolean;
    try {
        ranOut = await collect(0);
        if (ranOut && users.length < reaction.count && users.length < limit) {
            ranOut = await collect(1);
        }
    } catch (err: any) {
        const status = err?.status ?? err?.body?.code;
        return {
            users,
            burst,
            truncated: false,
            error:
                status === 403
                    ? `no permission to read reactions in channel ${channelId}`
                    : `Discord rejected the request (${status ?? "unknown"})`
        };
    }

    // Stopped on the caller's budget rather than on Discord running out, so say
    // whether anything was actually left behind.
    return { users, burst, error: null, truncated: !ranOut && users.length < reaction.count };
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

/**
 * The account's DMs and group DMs, most recently active first.
 *
 * `listChannels` cannot answer this and never could: it goes through
 * GuildChannelStore, which by construction only knows channels belonging to a
 * guild. So the only route into a DM was `current_view` -- read whichever
 * conversation happens to be on screen -- which is a coin flip that lands on
 * somebody's private messages. That is not a hypothetical; it is why this
 * method exists.
 *
 * Deliberately ChannelStore and not a PrivateChannelStore. Equicord's
 * @webpack/common exports no store by that name (it has PrivateChannelSortStore,
 * which sorts and does not hold), and private channels live on ChannelStore
 * beside every other kind. `getSortedPrivateChannels()` is the client's own DM
 * sidebar order, which is already by last message; `getMutablePrivateChannels()`
 * is the fallback for a client that does not expose the sorted view, and has no
 * order at all.
 *
 * Which is why the result is re-sorted here regardless. A caller promised "most
 * recent first" has to be able to rely on it whichever branch answered, and
 * sorting an already-sorted list of a few hundred entries costs nothing worth
 * measuring.
 */
export function listDms(): BridgeDm[] {
    const store: any = ChannelStore;
    const sorted: any[] = store?.getSortedPrivateChannels?.() ?? [];
    const channels: any[] = sorted.length
        ? sorted
        : Object.values(store?.getMutablePrivateChannels?.() ?? {});

    // Annotated rather than inferred: an empty literal widens to never[] under
    // Equicord's strict config, which the sidecar's tsconfig cannot catch
    // because it never compiles this half.
    const out: BridgeDm[] = [];
    for (const channel of channels) {
        const type = Number(channel?.type ?? -1);
        // A private channel should only ever be a DM or a group DM, but this is
        // Discord's store rather than ours, and the filter is load-bearing: a
        // stray guild channel in here would be served as a DM.
        if (!DM_CHANNEL_TYPES.has(type)) continue;
        out.push({
            id: String(channel.id),
            type,
            recipients: dmRecipients(channel),
            // A one-to-one is never titled, so this is the group DM's name or
            // nothing. Empty string collapses to null rather than rendering as
            // a nameless separator in front of the recipients.
            name: channel.name || null,
            lastMessageId: channel.lastMessageId ? String(channel.lastMessageId) : null
        });
    }

    return out.sort(byRecency);
}

/**
 * Newest last message first, with channels that have none of their own last.
 *
 * Snowflakes sort chronologically but are strings that outgrow Number, so this
 * goes through BigInt -- guarded, because a malformed id would otherwise throw
 * inside a comparator and take the whole listing down with it. Array.sort is
 * stable, so anything unplaceable keeps the store's order among itself.
 */
function byRecency(a: BridgeDm, b: BridgeDm): number {
    const x = asSnowflake(a.lastMessageId);
    const y = asSnowflake(b.lastMessageId);
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    return x > y ? -1 : x < y ? 1 : 0;
}

function asSnowflake(id: string | null): bigint | null {
    if (!id) return null;
    try {
        return BigInt(id);
    } catch {
        return null;
    }
}

/**
 * Builds the permalink Discord's own "Copy Message Link" produces.
 *
 * Sited next to parseMessageLink, which is its inverse, so the two cannot drift:
 * every link this hands out is one `resolve_link` can read straight back.
 */
export function messageLink(guildId: string | null, channelId: string, messageId: string): string {
    return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
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
