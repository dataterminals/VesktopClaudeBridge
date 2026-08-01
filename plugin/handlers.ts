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
    listChannels,
    listGuilds,
    parseMessageLink,
    searchMessages,
    selectedChannel,
    selectedGuild,
    toBridgeChannel,
    toBridgeGuild
} from "./discord";
import { clearMarks, listMarks } from "./marked";
import type { RpcMethod, RpcParams, RpcResults } from "./protocol";
import { settings } from "./settings";

import { ChannelStore, GuildStore } from "@webpack/common";

const MAX_LIMIT = 200;

function clamp(limit: number | undefined, fallback: number): number {
    return Math.max(1, Math.min(limit ?? fallback, MAX_LIMIT));
}

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

        // The cache holds only what has actually been rendered, so a channel the
        // user just opened can come back nearly empty. Fall back to the API.
        if (messages.length < Math.min(limit, 10)) {
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

    async guilds(): Promise<RpcResults["guilds"]> {
        return { guilds: listGuilds() };
    },

    async channels(params: RpcParams["channels"]): Promise<RpcResults["channels"]> {
        if (!params?.guildId) throw fail("bad_params", "guildId is required");
        return { channels: listChannels(params.guildId) };
    }
};

/** Grabs the last N messages of the channel on screen, for the chat-bar button. */
export async function snapshotCurrentChannel() {
    const channel = selectedChannel();
    if (!channel) throw fail("not_found", "no channel open");

    const limit = clamp(settings.store.grabCount, 50);
    let messages = cachedMessages(channel.id, limit);
    if (messages.length < Math.min(limit, 10)) {
        messages = await fetchMessages({ channelId: channel.id, limit });
    }

    return { guild: selectedGuild(), channel, messages };
}
