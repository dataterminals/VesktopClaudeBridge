/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Which ids a right-clicked message actually has, and what to call each of them.
 *
 * This file exists because Discord conflates threads and channels: a thread IS
 * a channel, so `channel.id` in a thread is the *thread's* id and the channel
 * everyone would call "the channel" is only reachable through `parentId`. The
 * whole risk of the copy-ids menu is a row labelled "Channel ID" that quietly
 * puts a thread id on the clipboard, or a "parent" that is really the category
 * the channel is filed under. So the naming is decided here, once, from one
 * predicate, rather than in the JSX where a branch can escape the check.
 *
 * It takes the raw message rather than a BridgeMessage on purpose. Running it
 * through toBridgeMessage would mean five regex passes of mention resolution
 * and a MessageStore lookup for the reply reference on a path that fires on
 * every single right-click — and every bit of that work would be thrown away,
 * since all this needs is two ids.
 */

import { GuildStore } from "@webpack/common";

import { channelById, isForum, messageLink, parentChannel, toBridgeGuild } from "./discord";
import type { BridgeChannel } from "./protocol";

/**
 * "channel or thread" is the noun for an id we could not look up.
 *
 * It is deliberately the clumsy one. The fallback used to be "channel", which is
 * the exact failure this file exists to prevent: a message's channel_id is a
 * channel or a thread, the id itself says nothing about which, and the only
 * thing that could have told them apart is the cache lookup that just missed.
 * "Channel ID" over a thread id is then a confident label that is wrong with
 * nothing anywhere admitting it. The header is right that fabricating a *name*
 * would be worse, but the noun is a claim too, and this is the one branch with
 * nothing to base it on — so it names the ambiguity instead of resolving it.
 */
export type IdKind = "message" | "channel" | "thread" | "forum" | "channel or thread";

export interface CopyableId {
    kind: IdKind;
    /** True when this is the container the thread hangs off, not the thing you clicked in. */
    parent: boolean;
    id: string;
    /** Display-ready and untruncated: "#general", "dm:alice,bob", a thread title, or null. */
    where: string | null;
}

export interface MessageIds {
    ids: CopyableId[];
    /** Permalink on line one, every id on line two. Paste-ready as it stands. */
    block: string;
}

/** The one place a channel's noun is decided, so no branch can skip the forum check. */
function kindFor(channel: BridgeChannel): IdKind {
    return channel.isThread ? "thread" : isForum(channel) ? "forum" : "channel";
}

/**
 * The `#` sigil means "channel" to every Discord user, so it goes on channels
 * and on nothing else. Putting it on a thread title would reintroduce exactly
 * the thread/channel conflation this file exists to kill, in the one place the
 * user actually reads.
 */
function where(channel: BridgeChannel): string {
    return channel.isDm || channel.isThread ? channel.name : `#${channel.name}`;
}

/** "thread", "parent forum", … — the noun the label and the toast both build on. */
export function noun(entry: CopyableId): string {
    return `${entry.parent ? "parent " : ""}${entry.kind}`;
}

/**
 * Where a message actually lives, which is not always the channel on screen.
 *
 * `raw.channel_id` is authoritative about where this message can be fetched
 * from — search results and the inline thread preview both hand you a message
 * that lives elsewhere. `channel` is null when that id isn't cached, and callers
 * are expected to say so rather than substituting the channel being viewed.
 * That substitution was the tempting version and it is the exact failure this
 * file is written to prevent: somebody else's channel recorded under a confident
 * label, with nothing anywhere admitting it.
 *
 * Exported because markMessage in index.tsx has to answer the same question, and
 * for a while it answered it differently — it used the viewed channel, so one
 * right-click on a search result put the correct ids on the clipboard and the
 * wrong channel in the mark queue, from two rows of the same menu.
 */
export function messageHome(raw: any, view: BridgeChannel): { id: string; channel: BridgeChannel | null; } {
    const id = String(raw?.channel_id ?? view.id);
    return { id, channel: id === view.id ? view : channelById(id) };
}

export function messageIds(raw: any, view: BridgeChannel): MessageIds {
    const messageId = String(raw?.id ?? "");
    const { id: homeId, channel: home } = messageHome(raw, view);

    const ids: CopyableId[] = [];

    // Dedupe by id. It is what collapses the thread-starter case, where the
    // message lives in the parent channel but you are reading it inside the
    // thread.
    //
    // It is also what the React key and the menu id in index.tsx are built from,
    // and that is deliberate. They used to be built from kind + parent, which is
    // not a function of the id: two different channels can both be kind
    // "thread", parent false — exactly what the `view.isThread && view.id !==
    // homeId` branch below constructs, a thread home alongside a different
    // thread on screen. So deduping ids did not dedupe keys, and the comment
    // that claimed it did was wrong. Keyed on the snowflake, it follows from
    // this check instead of from an argument in a comment.
    const push = (entry: CopyableId) => {
        if (!entry.id) return;
        if (ids.some(e => e.id === entry.id)) return;
        ids.push(entry);
    };

    push({ kind: "message", parent: false, id: messageId, where: null });

    if (home) push({ kind: kindFor(home), parent: false, id: home.id, where: where(home) });
    else push({ kind: "channel or thread", parent: false, id: homeId, where: null });

    if (view.isThread && view.id !== homeId) {
        push({ kind: kindFor(view), parent: false, id: view.id, where: where(view) });
    }

    const thread = home?.isThread ? home : view.isThread ? view : null;
    const parent = thread ? parentChannel(thread) : null;
    if (parent) push({ kind: kindFor(parent), parent: true, id: parent.id, where: where(parent) });

    /*
     * A resolved home decides the guild by itself, null included.
     *
     * This was `home?.guildId ?? view.guildId`, and `??` is the wrong operator
     * for this field. A DM's guildId is null because the DM genuinely has no
     * guild, not because the lookup came up short — so `??` reads an answer as
     * an absence and substitutes the viewed channel's guild over it. What comes
     * out is a permalink with a server id in front of a DM channel id, which is
     * a link nobody can open, and a `server …` clause in the block naming a
     * server the message has nothing to do with. resolve_link would repeat it
     * rather than catch it: handlers.ts hands the parsed guild id straight to
     * GuildStore.getGuild without checking it against the channel.
     *
     * The condition that actually warrants a fallback is "we could not resolve
     * home at all", which is `home` being null and nothing else — hence the
     * ternary. Even then view.guildId is only a guess, which is part of why that
     * row goes out under the hedged noun above rather than a confident one.
     */
    const guildId = home ? home.guildId : view.guildId;
    const guild = guildId ? toBridgeGuild(GuildStore.getGuild(guildId)) : null;

    const line = ids.map(e => `${noun(e)} ${e.id}${e.where ? ` (${e.where})` : ""}`).join(" · ");

    // The server id is in the block but never gets a menu row of its own: both
    // `search` and `channels` need a guildId to do anything, so a follow-up
    // question usually wants it — but it isn't one of the three ids anyone
    // right-clicks a message to get, and it is otherwise visible only as an
    // unlabelled path segment of the permalink.
    const server = guild ? ` · server ${guild.id} (${guild.name})` : "";

    return {
        ids,
        block: `${messageLink(guildId, home?.id ?? homeId, messageId)}\n${line}${server}`
    };
}
