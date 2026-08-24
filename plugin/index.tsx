/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Lets a local MCP sidecar read the Discord this client is already logged into,
 * so "read the logs" stops meaning "take a screenshot and squint".
 *
 * Read-only by design. There is no send path here, and that is deliberate —
 * see the note in the repo README about automating a user account.
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { copyToClipboard } from "@utils/clipboard";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { ContextMenuApi, GuildStore, Menu, Toasts } from "@webpack/common";

import { BridgeClient, PLUGIN_VERSION } from "./bridge";
import {
    cachedMessages,
    currentUser,
    selectedChannel,
    toBridgeChannel,
    toBridgeGuild,
    toBridgeMessage
} from "./discord";
import { loadDmLedger } from "./dmLedger";
import { handlers, snapshotCurrentChannel } from "./handlers";
import { type CopyableId, messageHome, messageIds, noun } from "./ids";
import { addMark, clearMarks, loadMarks, markCount } from "./marked";
import type { BridgeChannel } from "./protocol";
import { drainTokenInbox, settings } from "./settings";
import {
    isReading,
    isWatching,
    loadThirdEye,
    onMessageCreate,
    onMessageDelete,
    refreshTerms,
    setCallbacks,
    start as startThirdEye,
    state as thirdEyeState,
    stop as stopThirdEye
} from "./thirdEye";

let client: BridgeClient | null = null;

/** `Toasts.Type` members are strings, not the numeric enum you'd expect. */
function toast(message: string, type: string) {
    if (!settings.store.showToasts) return;
    Toasts.show({ message, id: Toasts.genId(), type });
}

function notifyMarked(count: number) {
    toast(
        `Marked ${count} message${count === 1 ? "" : "s"} for Claude (${markCount()} in queue)`,
        Toasts.Type.SUCCESS
    );
    client?.notify("marked", { queued: markCount() });
}

// ---------------------------------------------------------------------------
// Marking
// ---------------------------------------------------------------------------

/**
 * Marks a message together with the conversation around it.
 *
 * The surrounding messages matter: a single line lifted out of a thread is
 * usually unreadable without the two or three that set it up, and the user
 * shouldn't have to mark each one by hand.
 *
 * Which conversation, though, is the message's own — not the one on screen.
 * This used to take both from `view`, and on a message that lives elsewhere (a
 * search hit, the inline thread preview) that went wrong twice. The lookup found
 * nothing, because a message from channel B is not in channel A's cache, so the
 * mark silently degraded to the single message with no context at all. And what
 * it recorded around that message — the mark's channel, its guild, the guildId
 * stamped on the BridgeMessage — all described the channel you happened to be
 * looking at. The sidecar then filed somebody's search hit under a channel it
 * was never in. Meanwhile the Copy IDs row directly beneath it in the same menu
 * resolved the same message correctly, so one context menu gave two answers.
 *
 * Both go through messageHome now, which is why it is exported. Pointing the
 * cache lookup at the message's own channel also fixes the context for free: it
 * is the channel whose cache can actually contain the neighbours.
 */
function markMessage(rawMessage: any, view: BridgeChannel) {
    const home = messageHome(rawMessage, view);

    // Null when `raw.channel_id` isn't cached. Recording no channel is the
    // honest answer there — the messages still carry their own channelId and
    // permalink — and it beats reinstating the substitution above.
    const channel = home.channel;
    const guild = channel?.guildId ? toBridgeGuild(GuildStore.getGuild(channel.guildId)) : null;
    const span = Math.max(0, settings.store.markContext ?? 5);

    const nearby = cachedMessages(home.id, 200);
    const index = nearby.findIndex(m => m.id === String(rawMessage.id));

    const messages =
        index === -1
            ? [toBridgeMessage(rawMessage, channel)]
            : nearby.slice(Math.max(0, index - span), index + span + 1);

    addMark({ note: null, guild, channel, messages });
    notifyMarked(messages.length);
}

/**
 * Empties the queue from inside Discord.
 *
 * The count is already in the menu label, so "what am I about to lose" is
 * answered before the click and there is no confirmation modal — it would be
 * the only modal in the plugin, and a mark costs one right-click to remake.
 */
function clearQueue() {
    const cleared = clearMarks();
    toast(
        cleared ? `Cleared ${cleared} mark${cleared === 1 ? "" : "s"}` : "Nothing to clear",
        cleared ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE
    );
    client?.notify("marked", { queued: markCount(), cleared });
}

// ---------------------------------------------------------------------------
// Copying ids
// ---------------------------------------------------------------------------

/**
 * Where a channel name gets cut off in a menu row. This number is a guess.
 *
 * Saying so rather than implying a measurement: Discord's context-menu CSS ships
 * inside Discord's own bundle, and nothing in the Equicord tree styles a menu
 * item, so there was no stylesheet here to measure it against and 28 is just
 * what looked right against a handful of real channel names. What would settle
 * it is opening a real menu in devtools and reading the computed width and font
 * of the label element — and the answer might well be to delete this, since if
 * the label already elides in CSS then truncating here only makes it happen
 * twice, earlier and with a worse breakpoint.
 */
const MAX_WHERE = 28;

/**
 * The try/catch is load-bearing, not decorative.
 *
 * This plugin ships as `dist/equibop` (scripts/install-plugin.ps1 points Vesktop
 * at it), and every equibop bundle is built with IS_DISCORD_DESKTOP false
 * (Equicord scripts/build/build.mjs:209) — so `copyToClipboard` resolves to
 * `navigator.clipboard.writeText`, which genuinely rejects when the document
 * isn't focused. That is a thing that happens to a context menu.
 *
 * It is awaited rather than `.then()`ed because the same source built as
 * `dist/desktop` takes the other branch, `DiscordNative.clipboard.copy`, which
 * is synchronous and returns undefined while being declared `Promise<void>` —
 * `DiscordNative` is typed `any` (Equicord src/globals.d.ts:62), so nothing
 * would flag a `.then()` chain that throws there at runtime.
 *
 * The failure goes to the console unconditionally and to the user only if they
 * asked for toasts, which is the same bargain markCurrentChannel already makes.
 */
async function copyForClaude(text: string, said: string) {
    try {
        await copyToClipboard(text);
    } catch (err: any) {
        console.error("[VesktopClaudeBridge] clipboard write failed:", err);
        toast(`Could not copy that: ${err?.message ?? err}`, Toasts.Type.FAILURE);
        return;
    }
    toast(said, Toasts.Type.SUCCESS);
}

function idLabel(entry: CopyableId): string {
    const kind = noun(entry);
    const head = `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ID`;
    if (!entry.where) return head;
    const where =
        entry.where.length > MAX_WHERE ? `${entry.where.slice(0, MAX_WHERE - 1)}…` : entry.where;
    return `${head} — ${where}`;
}

/** `#general` is already unambiguous; a thread or DM title needs quoting to read as a name. */
function copiedToast(entry: CopyableId): string {
    const kind = noun(entry);
    if (!entry.where) return `Copied the ${kind} ID`;
    return `Copied the ${kind} ID for ${entry.where.startsWith("#") ? entry.where : `"${entry.where}"`}`;
}

/**
 * A submenu rather than four rows shoved into the copy group.
 *
 * The parent deliberately has no `action`: clicking it should open the list, not
 * silently overwrite the clipboard with whichever id we guessed you meant. Same
 * shape as Equicord's own gifCollections menu
 * (src/equicordplugins/gifCollections/components/contextMenus.tsx:26), which is
 * an action-less parent wrapping mapped items plus a separator.
 */
function CopyIdsItem(rawMessage: any, channel: BridgeChannel) {
    const { ids, block } = messageIds(rawMessage, channel);

    return (
        <Menu.MenuItem id="vcb-copy-ids" key="vcb-copy-ids" label="Copy IDs for Claude">
            <Menu.MenuItem
                id="vcb-copy-ids-block"
                key="vcb-copy-ids-block"
                label="Link and IDs"
                action={() => void copyForClaude(block, "Copied the message link and its IDs")}
            />
            <Menu.MenuSeparator />
            {ids.map(entry => {
                // Keyed on the snowflake because push() in ids.ts dedupes on it,
                // so this is unique by construction. It used to be kind + parent,
                // which two different channels can share — a thread home next to
                // a different thread on screen gives two rows that are both kind
                // "thread", parent false, and that is two React children with
                // one key and two menu items with one id.
                const id = `vcb-copy-${entry.id}`;
                return (
                    <Menu.MenuItem
                        id={id}
                        key={id}
                        label={idLabel(entry)}
                        action={() => void copyForClaude(entry.id, copiedToast(entry))}
                    />
                );
            })}
        </Menu.MenuItem>
    );
}

// ---------------------------------------------------------------------------
// Third eye
// ---------------------------------------------------------------------------

async function toggleThirdEye() {
    if (isWatching()) {
        const st = stopThirdEye();
        toast(`Third eye off — ${st.pending} unread discarded`, Toasts.Type.MESSAGE);
        return;
    }

    const channel = selectedChannel();
    if (!channel) {
        toast("Open a channel first", Toasts.Type.FAILURE);
        return;
    }
    if (channel.isDm && !settings.store.thirdEyeWatchDms) {
        // Refusing here rather than at the drain means DM content never enters
        // the renderer's buffer at all, which is the stronger guarantee.
        toast("Third eye doesn't watch DMs — turn it on in plugin settings", Toasts.Type.FAILURE);
        return;
    }

    startThirdEye(channel.id);
    client?.notify("third-eye", { watching: true, channelId: channel.id });

    // Honest about the two-switch reality: the buffer fills immediately, but
    // nothing reads it until you next say something to Claude.
    toast(
        `Third eye on — #${channel.name} · Claude picks this up on your next message`,
        Toasts.Type.SUCCESS
    );
}

async function markCurrentChannel() {
    try {
        const snapshot = await snapshotCurrentChannel();
        addMark({ note: `last ${snapshot.messages.length}`, ...snapshot });
        notifyMarked(snapshot.messages.length);
    } catch (err: any) {
        console.error("[VesktopClaudeBridge] grab failed:", err);
        toast(`Could not grab this channel: ${err?.message ?? err}`, Toasts.Type.FAILURE);
    }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/**
 * Three eyes: a large one above a pair.
 *
 * The proportions are load-bearing, not decorative. At the 20px the chat bar
 * renders, one viewBox unit is 0.833 CSS px, and anything under ~1.2 units
 * anti-aliases away — so the burst is anisotropic (spending its spoke length on
 * the axis where the lens is wide) and the lower pupils are punched out with
 * `fill-rule="evenodd"` rather than stroked. A stroked pupil at this size turns
 * to grey mush; a hole survives.
 *
 * `currentColor` throughout, so it inherits Discord's foreground and inverts
 * with the theme. Don't hardcode a colour — it would go invisible on light.
 *
 * The burst is only drawn while a session is actually reading, which makes it
 * the visible signal that compute is being spent.
 */
const BridgeIcon: IconComponent = ({ height = 20, width = 20, className, children }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="none">
        <path
            d="M3.6 8.25C6.6 0.6 17.4 0.6 20.4 8.25C17.4 15.9 6.6 15.9 3.6 8.25Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
        />
        <path
            d="M18.3 8.25L14.34 7.32L15.15 4.86L12 6.38L8.85 4.86L9.66 7.32L5.7 8.25L9.66 9.18L8.85 11.64L12 10.12L15.15 11.64L14.34 9.18Z"
            fill="currentColor"
        />
        <path
            fill="currentColor"
            fillRule="evenodd"
            d="M1.7 19.35 Q5.7 14.9 9.7 19.35 Q5.7 23.8 1.7 19.35 Z M4.2 19.35 a1.5 1.5 0 1 0 3 0 a1.5 1.5 0 1 0 -3 0 Z M14.3 19.35 Q18.3 14.9 22.3 19.35 Q18.3 23.8 14.3 19.35 Z M16.8 19.35 a1.5 1.5 0 1 0 3 0 a1.5 1.5 0 1 0 -3 0 Z"
        />
        {children}
    </svg>
);

/** Same glyph with the burst reduced to a plain pupil, for the non-reading states. */
const BridgeIconIdle: IconComponent = ({ height = 20, width = 20, className, children }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="none">
        <path
            d="M3.6 8.25C6.6 0.6 17.4 0.6 20.4 8.25C17.4 15.9 6.6 15.9 3.6 8.25Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
        />
        <path d="M9.9 8.25 a2.1 2.1 0 1 0 4.2 0 a2.1 2.1 0 1 0 -4.2 0 Z" fill="currentColor" />
        <path
            fill="currentColor"
            fillRule="evenodd"
            d="M1.7 19.35 Q5.7 14.9 9.7 19.35 Q5.7 23.8 1.7 19.35 Z M4.2 19.35 a1.5 1.5 0 1 0 3 0 a1.5 1.5 0 1 0 -3 0 Z M14.3 19.35 Q18.3 14.9 22.3 19.35 Q18.3 23.8 14.3 19.35 Z M16.8 19.35 a1.5 1.5 0 1 0 3 0 a1.5 1.5 0 1 0 -3 0 Z"
        />
        {children}
    </svg>
);

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props: any) => {
    const message = props?.message;
    // Normalised once, here, so both items reason about the same channel — and
    // so nothing downstream has to guess whether it was handed a raw record.
    const channel = toBridgeChannel(props?.channel);
    if (!message || !channel) return;

    const items = [
        <Menu.MenuItem
            id="vcb-mark-for-claude"
            key="vcb-mark-for-claude"
            label="Mark for Claude"
            action={() => markMessage(message, channel)}
        />,
        CopyIdsItem(message, channel)
    ];

    // Sit next to Copy Text if it's there, so they land where a copy action is
    // expected rather than orphaned at the bottom of the menu.
    const group = findGroupChildrenByChildId("copy-text", children);
    if (group) group.push(...items);
    else children.push(<Menu.MenuGroup>{items}</Menu.MenuGroup>);
};

/**
 * There is exactly one chat-bar button per plugin — `addChatBarButton` is keyed
 * by plugin name — so grabbing and watching share it via a menu rather than one
 * of them becoming an invisible right-click gesture.
 */
function BridgeMenu() {
    const watching = isWatching();
    const st = thirdEyeState();
    const queued = markCount();

    return (
        <Menu.Menu
            navId="vcb-menu"
            onClose={() => ContextMenuApi.closeContextMenu()}
            aria-label="Claude bridge"
        >
            <Menu.MenuItem
                id="vcb-grab"
                label={`Mark the last ${settings.store.grabCount ?? 50} messages`}
                action={() => void markCurrentChannel()}
            />
            {/*
              * Hidden at zero rather than disabled. The disabled precedent below
              * is a *status* line, which is worth stating even when it reads
              * nothing; "Clear the queue (0 marked)" is just a dead control in a
              * four-item menu, and the count is the label's whole job.
              *
              * It sits with the marking item, above the separator, so mark
              * actions are one group and third eye stays its own.
              */}
            {queued > 0 && (
                <Menu.MenuItem
                    id="vcb-clear-marks"
                    label={`Clear the queue (${queued} marked)`}
                    color="danger"
                    action={() => clearQueue()}
                />
            )}
            <Menu.MenuSeparator />
            <Menu.MenuCheckboxItem
                id="vcb-third-eye"
                label={watching ? "Third eye: watching this channel" : "Third eye: watch this channel"}
                checked={watching}
                action={() => void toggleThirdEye()}
            />
            {watching && (
                <Menu.MenuItem
                    id="vcb-third-eye-status"
                    label={`${st.pending} buffered · ${st.notablePending} for you`}
                    disabled={true}
                    action={() => {}}
                />
            )}
        </Menu.Menu>
    );
}

const GrabChannelButton: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat) return null;

    const st = thirdEyeState();
    const here = st.watching && st.channel?.id === selectedChannel()?.id;

    // The burst only appears while a session is actually draining the buffer, so
    // the icon itself distinguishes "capturing, costing nothing" from "being read".
    const Icon = isReading() ? BridgeIcon : BridgeIconIdle;

    // The queue count only shows up on the idle branch: the watching branches
    // already spend the tooltip on buffer numbers, and a third counter there
    // reads as noise rather than as information.
    const queued = markCount();

    const tooltip = !st.watching
        ? queued > 0
            ? `Claude bridge — ${queued} marked · mark more, or start third eye`
            : "Claude bridge — mark messages, or start third eye"
        : here
          ? `Third eye: armed · ${st.pending} buffered · ${st.notablePending} for you`
          : `Third eye: armed on #${st.channel?.name ?? "?"} · ${st.pending} buffered`;

    return (
        <ChatBarButton tooltip={tooltip} onClick={e => ContextMenuApi.openContextMenu(e, () => <BridgeMenu />)}>
            <Icon />
        </ChatBarButton>
    );
};

// ---------------------------------------------------------------------------

export default definePlugin({
    name: "VesktopClaudeBridge",
    description:
        "Exposes this Discord client to a local MCP sidecar so Claude Code can read channels, threads and attachments. Read-only.",
    authors: [{ name: "dataterminals", id: 0n }],
    dependencies: ["ChatInputButtonAPI", "ContextMenuAPI"],
    tags: ["Utility"],
    settings,

    contextMenus: {
        message: messageContextMenuPatch
    },

    chatBarButton: {
        icon: BridgeIcon,
        render: GrabChannelButton
    },

    /**
     * Subscribed when the dispatcher is found, which is BEFORE start() runs — so
     * these fire against possibly-null module state and gate on the watch inside
     * themselves. The object is read once at subscribe time; mutating it later
     * does nothing, which is why toggling can't add or remove handlers.
     */
    flux: {
        MESSAGE_CREATE: onMessageCreate,
        MESSAGE_DELETE: onMessageDelete
    },

    async start() {
        drainTokenInbox();
        await loadMarks();
        await loadThirdEye();
        // Before the socket is dialled below, or the first RPC through the door
        // could be gated against an allowlist that had not finished loading --
        // which fails closed, so it would prompt for something already allowed.
        await loadDmLedger();
        refreshTerms();

        setCallbacks(
            entry => {
                client?.notify("third-eye", {
                    notable: true,
                    reason: entry.reason,
                    author: entry.message.author.displayName,
                    channelId: entry.message.channelId
                });
            },
            channel => {
                // Loud, not silent: believing you're covered when you aren't is
                // the worse failure.
                toast(
                    `Third eye lapsed after 4h${channel ? ` on #${channel.name}` : ""} — turn it back on if you still want it`,
                    Toasts.Type.MESSAGE
                );
            }
        );

        client = new BridgeClient(handlers, currentUser, (connected, detail) => {
            if (connected) {
                console.log(`[VesktopClaudeBridge] connected — ${detail ?? ""}`);
                toast("Claude bridge connected", Toasts.Type.SUCCESS);
            } else {
                console.debug(`[VesktopClaudeBridge] disconnected — ${detail ?? ""}`);
            }
        });

        client.start();
        console.log(`[VesktopClaudeBridge] v${PLUGIN_VERSION} started`);
    },

    stop() {
        client?.stop();
        client = null;
    },

    // Exposed for the settings UI and for poking at from devtools.
    get connected() {
        return client?.connected ?? false;
    }
});
