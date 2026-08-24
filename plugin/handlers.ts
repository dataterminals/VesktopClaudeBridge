/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The RPC method table. One function per protocol method, nothing else.
 */

import type { RpcHandler } from "./bridge";
import {
    cachedMessages,
    currentUser,
    fail,
    fetchMessages,
    fetchReactors,
    listChannels,
    listDms,
    listGuilds,
    parseMessageLink,
    searchMessages,
    selectedChannel,
    selectedGuild,
    toBridgeChannel,
    toBridgeGuild
} from "./discord";
import { clearMarks, listMarks } from "./marked";
import { drain as drainThirdEye, noteRead, state as thirdEyeState } from "./thirdEye";
import type { ReactorGroup, RpcMethod, RpcParams, RpcResults } from "./protocol";
import { settings } from "./settings";

import { ChannelStore, GuildStore } from "@webpack/common";

const MAX_LIMIT = 200;

function clamp(limit: number | undefined, fallback: number): number {
    return Math.max(1, Math.min(limit ?? fallback, MAX_LIMIT));
}

/**
 * Reactor budget, separate from MAX_LIMIT because the unit is different.
 *
 * A message limit of 200 is a lot of text; 200 usernames is one paragraph, and
 * the interesting posts are the ones with several hundred reactions. Paging is
 * 100 per round trip, so this is five of them at worst.
 */
const MAX_REACTORS = 500;

/**
 * Distinct emoji expanded when the caller names none.
 *
 * A busy announcement can carry twenty reactions, and walking all of them is
 * twenty-plus round trips for a question nobody asked. Whatever this leaves
 * out is reported as `skipped` rather than silently dropped.
 */
const MAX_REACTION_GROUPS = 6;

export const handlers: Record<RpcMethod, RpcHandler> = {
    async ping(): Promise<RpcResults["ping"]> {
        return { pong: true, user: currentUser() };
    },

    async current_view(params: RpcParams["current_view"]): Promise<RpcResults["current_view"]> {
        const channel = selectedChannel();
        if (!channel) {
            throw fail("not_found", "No channel is open — the user may be on the friends list or a settings page.");
        }

        const limit = clamp(params?.limit, 50);
        let messages = cachedMessages(channel.id, limit);
        let fromCache = true;

        // The cache holds only what has actually been rendered, and Discord caps
        // it around 50 per channel, so anything larger than that can never be
        // satisfied from memory. Refetch whenever it came up short rather than
        // only when it's nearly empty — the old threshold silently handed back
        // 50 messages to a caller that asked for 100.
        if (messages.length < limit) {
            messages = await fetchMessages({ channelId: channel.id, limit });
            fromCache = false;
        }

        return {
            guild: selectedGuild(),
            channel,
            messages,
            capturedAt: new Date().toISOString(),
            fromCache
        };
    },

    async history(params: RpcParams["history"]): Promise<RpcResults["history"]> {
        if (!params?.channelId) throw fail("bad_params", "channelId is required");
        const messages = await fetchMessages({
            channelId: params.channelId,
            limit: clamp(params.limit, 50),
            before: params.before,
            after: params.after,
            around: params.around
        });
        return {
            channel: toBridgeChannel(ChannelStore.getChannel(params.channelId)),
            messages
        };
    },

    async search(params: RpcParams["search"]): Promise<RpcResults["search"]> {
        if (!params?.guildId && !params?.channelId) {
            throw fail("bad_params", "search needs a guildId (or a channelId for a DM)");
        }

        // An unfiltered search matches every message in the server — nearly two
        // million on a big one. That is never what the caller meant, and it
        // costs a real API round trip to find out, so refuse it here.
        const hasFilter = Boolean(params.content || params.authorId || params.mentions || params.has);
        if (!hasFilter) {
            throw fail("bad_params", "search needs at least one of: content, authorId, mentions, has");
        }

        const { hits, totalResults, indexing } = await searchMessages({
            guildId: params.guildId,
            channelId: params.channelId,
            content: params.content,
            authorId: params.authorId,
            mentions: params.mentions,
            has: params.has,
            before: params.before,
            after: params.after,
            limit: clamp(params.limit, 25),
            offset: Math.max(0, params.offset ?? 0),
            sortOrder: params.sortOrder
        });

        return {
            guild: params.guildId ? toBridgeGuild(GuildStore.getGuild(params.guildId)) : null,
            totalResults,
            hits,
            offset: Math.max(0, params.offset ?? 0),
            indexing
        };
    },

    async resolve_link(params: RpcParams["resolve_link"]): Promise<RpcResults["resolve_link"]> {
        if (!params?.url) throw fail("bad_params", "url is required");
        const { guildId, channelId, messageId } = parseMessageLink(params.url);

        // `around` needs an odd-ish window to centre properly; ask for the
        // requested context on both sides plus the target itself.
        const span = Math.max(1, Math.min(params.context ?? 10, 100));
        const messages = await fetchMessages({ channelId, limit: span * 2 + 1, around: messageId });

        return {
            guild: guildId ? toBridgeGuild(GuildStore.getGuild(guildId)) : null,
            channel: toBridgeChannel(ChannelStore.getChannel(channelId)),
            target: messages.find(m => m.id === messageId) ?? null,
            context: messages
        };
    },

    async "marked.list"(params: RpcParams["marked.list"]): Promise<RpcResults["marked.list"]> {
        return { items: listMarks(Boolean(params?.consume)) };
    },

    async "marked.clear"(params: RpcParams["marked.clear"]): Promise<RpcResults["marked.clear"]> {
        return { cleared: clearMarks(params?.markId) };
    },

    async "third_eye.state"(): Promise<RpcResults["third_eye.state"]> {
        return thirdEyeState();
    },

    async "third_eye.drain"(params: RpcParams["third_eye.drain"]): Promise<RpcResults["third_eye.drain"]> {
        // Light the icon: a drain is the moment this mode starts costing tokens.
        noteRead();
        return drainThirdEye({
            consume: params?.consume ?? false,
            notableOnly: params?.notableOnly ?? false,
            limit: params?.limit
        });
    },

    async guilds(): Promise<RpcResults["guilds"]> {
        return { guilds: listGuilds() };
    },

    async channels(params: RpcParams["channels"]): Promise<RpcResults["channels"]> {
        if (!params?.guildId) throw fail("bad_params", "guildId is required");
        return { channels: listChannels(params.guildId) };
    },

    // Takes no params: there is one private-channel list per account and nothing
    // to scope it by. Reads the store only -- no REST -- so it is as cheap as
    // `guilds` and can be called speculatively.
    async dms(): Promise<RpcResults["dms"]> {
        return { dms: listDms() };
    },

    async reactors(params: RpcParams["reactors"]): Promise<RpcResults["reactors"]> {
        if (!params?.channelId) throw fail("bad_params", "channelId is required");
        if (!params?.messageId) throw fail("bad_params", "messageId is required");

        // The message has to be fetched first, and not just for display: the
        // REST route is keyed by the emoji, and a custom one needs the id that
        // only the message carries. It also means a wrong id fails here with a
        // reason instead of as an opaque 400 from the reactions route.
        const page = await fetchMessages({
            channelId: params.channelId,
            limit: 1,
            around: params.messageId
        });
        const message = page.find(m => m.id === params.messageId) ?? null;
        if (!message) {
            throw fail(
                "not_found",
                `No message ${params.messageId} in channel ${params.channelId} — it may have been deleted.`
            );
        }

        // `:fire1:`, `fire1` and `👍` all name a reaction the way some surface
        // prints it, so all three resolve.
        const wanted = params.emoji?.replace(/^:|:$/g, "").trim().toLowerCase();
        const matching = wanted
            ? message.reactions.filter(r => r.emoji.replace(/^:|:$/g, "").toLowerCase() === wanted)
            : message.reactions;

        if (wanted && !matching.length) {
            const present = message.reactions.map(r => r.emoji).join(", ");
            throw fail(
                "not_found",
                `No ${params.emoji} reaction on that message. It has: ${present || "(none)"}`
            );
        }

        const expand = matching.slice(0, MAX_REACTION_GROUPS);
        const limit = Math.max(1, Math.min(params.limit ?? 100, MAX_REACTORS));

        // Annotated rather than inferred: an empty literal widens to never[]
        // under Equicord's strict config, which the sidecar's tsconfig does not
        // catch because it never compiles this half.
        const groups: ReactorGroup[] = [];
        for (const reaction of expand) {
            const { users, truncated, burst, error } = await fetchReactors(
                params.channelId,
                params.messageId,
                reaction,
                limit
            );
            groups.push({
                emoji: reaction.emoji,
                emojiId: reaction.emojiId,
                count: reaction.count,
                users,
                truncated,
                burst,
                error
            });
        }

        return {
            channel: toBridgeChannel(ChannelStore.getChannel(params.channelId)),
            message,
            groups,
            skipped: matching.length - expand.length
        };
    }
};

/** Grabs the last N messages of the channel on screen, for the chat-bar button. */
export async function snapshotCurrentChannel() {
    const channel = selectedChannel();
    if (!channel) throw fail("not_found", "no channel open");

    const limit = clamp(settings.store.grabCount, 50);
    let messages = cachedMessages(channel.id, limit);
    // See the note in current_view: the cache tops out around 50, so a larger
    // grabCount has to go to the API or the button quietly under-delivers.
    if (messages.length < limit) {
        messages = await fetchMessages({ channelId: channel.id, limit });
    }

    return { guild: selectedGuild(), channel, messages };
}
