/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The MCP surface — what the model actually sees.
 *
 * Tool descriptions here are load-bearing. They are the only thing telling a
 * model which of these to reach for, so they say when to use each one, not just
 * what it does.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fetchAttachment } from "./attachments.js";
import { BridgeError, type BridgeServer } from "./bridge-server.js";
import type { Config } from "./config.js";
import {
    Pseudonymizer,
    assertAllowed,
    channelTypeName,
    renderTranscript
} from "./format.js";
import { log } from "./log.js";
import type { BridgeMessage } from "./protocol.js";

type TextResult = {
    content: { type: "text"; text: string; }[];
    isError?: boolean;
};

function text(body: string): TextResult {
    return { content: [{ type: "text", text: body }] };
}

function failure(err: unknown): TextResult {
    if (err instanceof BridgeError) {
        return { content: [{ type: "text", text: `${err.rpc.code}: ${err.rpc.message}` }], isError: true };
    }
    log.error("unexpected tool error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `internal: ${message}` }], isError: true };
}

export function createMcpServer(bridge: BridgeServer, cfg: Config, version: string): McpServer {
    const server = new McpServer({ name: "vesktop-claude-bridge", version });
    const pseudo = new Pseudonymizer(cfg.pseudonymize);

    const clamp = (n: number | undefined) =>
        Math.max(1, Math.min(n ?? cfg.defaultLimit, cfg.maxLimit));

    const transcript = (
        guild: Parameters<typeof renderTranscript>[0],
        channel: Parameters<typeof renderTranscript>[1],
        messages: BridgeMessage[],
        ids = false
    ) =>
        renderTranscript(guild, channel, pseudo.apply(messages), {
            truncateAt: cfg.truncateAt,
            ids
        });

    // -----------------------------------------------------------------------

    server.registerTool(
        "discord_status",
        {
            title: "Discord bridge status",
            description:
                "Check whether the Discord client is connected to the bridge, and as whom. Call this first if another discord_* tool reports no_client.",
            inputSchema: {},
            annotations: { readOnlyHint: true }
        },
        async (): Promise<TextResult> => {
            const s = bridge.status();
            return text(
                [
                    `connected: ${s.connected}`,
                    `account:   ${s.user ? `${s.user.displayName} (@${s.user.username})` : "unknown"}`,
                    `plugin:    ${s.pluginVersion ?? "n/a"}`,
                    `since:     ${s.connectedSince ?? "n/a"}`,
                    `port:      ${s.port}`,
                    `scope:     ${cfg.allowGuilds.length ? `${cfg.allowGuilds.length} allowlisted guild(s)` : "all guilds"}, DMs ${cfg.denyDms ? "denied" : "allowed"}`,
                    `pseudonyms: ${cfg.pseudonymize ? "on" : "off"}`
                ].join("\n")
            );
        }
    );

    server.registerTool(
        "discord_current_view",
        {
            title: "Read the channel on screen",
            description:
                "Read the channel the user is looking at right now, newest messages last. This is the right tool for a bare 'read the logs' / 'look at this channel' with no other detail — it needs no ids and no setup.",
            inputSchema: {
                limit: z
                    .number()
                    .int()
                    .optional()
                    .describe(`How many recent messages to return (default ${cfg.defaultLimit}).`),
                ids: z
                    .boolean()
                    .optional()
                    .describe("Tag every message with its id. Off by default; ids are long and the header already carries the range you need to paginate.")
            },
            annotations: { readOnlyHint: true }
        },
        async ({ limit, ids }): Promise<TextResult> => {
            try {
                const view = await bridge.call("current_view", { limit: clamp(limit) });
                assertAllowed(cfg, view.channel);
                const note = view.fromCache ? "" : "\n(fetched from the API, not the client cache)";
                return text(transcript(view.guild, view.channel, view.messages, ids) + note);
            } catch (err) {
                return failure(err);
            }
        }
    );

    server.registerTool(
        "discord_marked",
        {
            title: "Read messages the user marked",
            description:
                "Return whatever the user flagged in Discord via 'Mark for Claude' (right-click a message) or the chat-bar button. Prefer this whenever the user says 'the thing I marked', 'the messages I flagged', or points at something without saying where — it removes the guesswork about which channel they meant.",
            inputSchema: {
                consume: z
                    .boolean()
                    .optional()
                    .describe("Clear the queue after reading it, so the same messages aren't picked up again later."),
                ids: z.boolean().optional().describe("Tag every message with its id.")
            }
        },
        async ({ consume, ids }): Promise<TextResult> => {
            try {
                const { items } = await bridge.call("marked.list", { consume: consume ?? false });
                if (items.length === 0) {
                    return text(
                        "Nothing is marked. Ask the user to right-click a message in Discord and pick \"Mark for Claude\", or use the chat-bar button to grab the last N messages."
                    );
                }
                const blocks = items.map(item => {
                    assertAllowed(cfg, item.channel);
                    const head = `### mark ${item.markId} · ${item.markedAt}${item.note ? ` · note: ${item.note}` : ""}`;
                    return `${head}\n${transcript(item.guild, item.channel, item.messages, ids)}`;
                });
                return text(blocks.join("\n\n"));
            } catch (err) {
                return failure(err);
            }
        }
    );

    server.registerTool(
        "discord_history",
        {
            title: "Read channel history",
            description:
                "Page through a channel's history, going past what the client has cached. Use `before` with the oldest id you have to keep scrolling back, or `around` a specific id to get its neighbourhood.",
            inputSchema: {
                channelId: z.string().describe("Channel or thread id. discord_channels lists them."),
                limit: z.number().int().optional(),
                before: z.string().optional().describe("Return messages older than this message id."),
                after: z.string().optional().describe("Return messages newer than this message id."),
                around: z.string().optional().describe("Centre the window on this message id."),
                ids: z.boolean().optional()
            },
            annotations: { readOnlyHint: true }
        },
        async ({ channelId, limit, before, after, around, ids }): Promise<TextResult> => {
            try {
                const res = await bridge.call("history", {
                    channelId,
                    limit: clamp(limit),
                    before,
                    after,
                    around
                });
                assertAllowed(cfg, res.channel);
                return text(transcript(null, res.channel, res.messages, ids));
            } catch (err) {
                return failure(err);
            }
        }
    );

    server.registerTool(
        "discord_resolve_link",
        {
            title: "Read a message from its link",
            description:
                "Given a discord.com/channels/... message link, return that message plus the messages around it. Use this the moment the user pastes a Discord link — it is exact, and cheaper than making them describe where to look.",
            inputSchema: {
                url: z.string().describe("A discord.com / canary / ptb message link."),
                context: z
                    .number()
                    .int()
                    .optional()
                    .describe("How many messages of surrounding context to include (default 10).")
            },
            annotations: { readOnlyHint: true }
        },
        async ({ url, context }): Promise<TextResult> => {
            try {
                const res = await bridge.call("resolve_link", { url, context: context ?? 10 });
                assertAllowed(cfg, res.channel);
                if (!res.target && res.context.length === 0) {
                    return text("That link resolved to nothing readable — the message may have been deleted.");
                }
                const body = transcript(res.guild, res.channel, res.context, false);
                const marker = res.target ? `\n\n(target message: ${res.target.id} at ${res.target.timestamp})` : "";
                return text(body + marker);
            } catch (err) {
                return failure(err);
            }
        }
    );

    server.registerTool(
        "discord_guilds",
        {
            title: "List servers",
            description:
                "List the servers the account is in, with ids. Use this to turn a name the user said ('the modding server') into an id for discord_channels.",
            inputSchema: {},
            annotations: { readOnlyHint: true }
        },
        async (): Promise<TextResult> => {
            try {
                const { guilds } = await bridge.call("guilds", {});
                const visible = cfg.allowGuilds.length
                    ? guilds.filter(g => cfg.allowGuilds.includes(g.id))
                    : guilds;
                if (!visible.length) return text("No servers visible under the current allowGuilds config.");
                return text(visible.map(g => `${g.id}  ${g.name}`).join("\n"));
            } catch (err) {
                return failure(err);
            }
        }
    );

    server.registerTool(
        "discord_channels",
        {
            title: "List channels in a server",
            description:
                "List a server's channels and threads with ids, so a name the user said can be turned into a channelId for discord_history.",
            inputSchema: {
                guildId: z.string().describe("Server id, from discord_guilds.")
            },
            annotations: { readOnlyHint: true }
        },
        async ({ guildId }): Promise<TextResult> => {
            try {
                if (cfg.allowGuilds.length && !cfg.allowGuilds.includes(guildId)) {
                    return failure(
                        new BridgeError({ code: "forbidden", message: `Guild ${guildId} is not allowlisted.` })
                    );
                }
                const { channels } = await bridge.call("channels", { guildId });
                if (!channels.length) return text("No readable channels in that server.");
                return text(
                    channels
                        .map(c => {
                            const kind = channelTypeName(c.type);
                            const topic = c.topic ? ` — ${c.topic.slice(0, 100)}` : "";
                            return `${c.id}  ${kind.padEnd(12)} #${c.name}${topic}`;
                        })
                        .join("\n")
                );
            } catch (err) {
                return failure(err);
            }
        }
    );

    server.registerTool(
        "discord_fetch_attachment",
        {
            title: "Download an attachment",
            description:
                "Download a file attached to a Discord message onto local disk and return its path, plus a short head preview when it is text. Use this for log files, crash dumps, diffs and configs — do NOT try to fetch Discord CDN urls directly, their signatures expire.",
            inputSchema: {
                messageId: z.string().describe("Id of the message holding the attachment."),
                channelId: z.string().describe("Channel the message is in."),
                filename: z
                    .string()
                    .optional()
                    .describe("Which attachment, when the message has more than one. Defaults to the first.")
            }
        },
        async ({ messageId, channelId, filename }): Promise<TextResult> => {
            try {
                // Re-read the message so the CDN signature is minted fresh.
                const res = await bridge.call("history", { channelId, around: messageId, limit: 3 });
                assertAllowed(cfg, res.channel);

                const message = res.messages.find(m => m.id === messageId);
                if (!message) {
                    return failure(
                        new BridgeError({ code: "not_found", message: `Message ${messageId} was not found in ${channelId}.` })
                    );
                }
                if (!message.attachments.length) {
                    return failure(
                        new BridgeError({ code: "not_found", message: `Message ${messageId} has no attachments.` })
                    );
                }

                const wanted = filename
                    ? message.attachments.find(a => a.filename === filename)
                    : message.attachments[0];
                if (!wanted) {
                    return failure(
                        new BridgeError({
                            code: "not_found",
                            message: `No attachment named ${filename}. Available: ${message.attachments.map(a => a.filename).join(", ")}`
                        })
                    );
                }

                const saved = await fetchAttachment(cfg, wanted, messageId);
                const lines = [
                    `saved: ${saved.path}`,
                    `bytes: ${saved.bytes}`,
                    `type:  ${saved.contentType ?? "unknown"}`
                ];
                if (saved.preview) {
                    lines.push(
                        "",
                        saved.previewTruncated ? "--- first lines (Read the file for the rest) ---" : "--- full contents ---",
                        saved.preview
                    );
                }
                return text(lines.join("\n"));
            } catch (err) {
                return failure(err);
            }
        }
    );

    return server;
}

export async function serveMcpOverStdio(server: McpServer): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("MCP server attached to stdio");
}
