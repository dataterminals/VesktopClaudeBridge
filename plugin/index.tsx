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
import { handlers, snapshotCurrentChannel } from "./handlers";
import { addMark, loadMarks, markCount } from "./marked";
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
 */
function markMessage(rawMessage: any, rawChannel: any) {
    const channel = toBridgeChannel(rawChannel);
    if (!channel) return;

    const guild = channel.guildId ? toBridgeGuild(GuildStore.getGuild(channel.guildId)) : null;
    const span = Math.max(0, settings.store.markContext ?? 5);

    const nearby = cachedMessages(channel.id, 200);
    const index = nearby.findIndex(m => m.id === String(rawMessage.id));

    const messages =
        index === -1
            ? [toBridgeMessage(rawMessage, channel)]
            : nearby.slice(Math.max(0, index - span), index + span + 1);

    addMark({ note: null, guild, channel, messages });
    notifyMarked(messages.length);
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
    if (channel.isDm) {
        // The sidecar would refuse this content anyway; refusing here means it
        // never enters the renderer's buffer in the first place.
        toast("Third eye doesn't watch DMs", Toasts.Type.FAILURE);
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
    const channel = props?.channel;
    if (!message || !channel) return;

    const item = (
        <Menu.MenuItem
            id="vcb-mark-for-claude"
            label="Mark for Claude"
            action={() => markMessage(message, channel)}
        />
    );

    // Sit next to Copy Text if it's there, so it lands where a copy action is
    // expected rather than orphaned at the bottom of the menu.
    const group = findGroupChildrenByChildId("copy-text", children);
    if (group) group.push(item);
    else children.push(<Menu.MenuGroup>{item}</Menu.MenuGroup>);
};

/**
 * There is exactly one chat-bar button per plugin — `addChatBarButton` is keyed
 * by plugin name — so grabbing and watching share it via a menu rather than one
 * of them becoming an invisible right-click gesture.
 */
function BridgeMenu() {
    const watching = isWatching();
    const st = thirdEyeState();

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

    const tooltip = !st.watching
        ? `Claude bridge — mark messages, or start third eye`
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
