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
import { GuildStore, Menu, Toasts } from "@webpack/common";

import { BridgeClient, PLUGIN_VERSION } from "./bridge";
import { cachedMessages, currentUser, toBridgeChannel, toBridgeGuild, toBridgeMessage } from "./discord";
import { handlers, snapshotCurrentChannel } from "./handlers";
import { addMark, loadMarks, markCount } from "./marked";
import { drainTokenInbox, settings } from "./settings";

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

const BridgeIcon: IconComponent = ({ height = 20, width = 20, className, children }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className}>
        <path
            fill="currentColor"
            d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 4a1 1 0 0 1-1-1V5Zm4 3.5a1 1 0 0 0 0 2h8a1 1 0 1 0 0-2H8Zm0 3.5a1 1 0 1 0 0 2h5a1 1 0 1 0 0-2H8Z"
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

const GrabChannelButton: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat) return null;

    return (
        <ChatBarButton
            tooltip={`Mark the last ${settings.store.grabCount ?? 50} messages for Claude`}
            onClick={() => void markCurrentChannel()}
        >
            <BridgeIcon />
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

    async start() {
        drainTokenInbox();
        await loadMarks();

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
