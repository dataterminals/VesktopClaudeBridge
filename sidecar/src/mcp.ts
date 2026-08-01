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
import { BridgeError, type Bridge } from "./bridge-server.js";
import type { Config } from "./config.js";
import {
    Pseudonymizer,
    assertAllowed,
    channelTypeName,
    compactMessages,
    renderSearchResults,
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

export function createMcpServer(bridge: Bridge, cfg: Config, version: string): McpServer {
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
        "discord_live",
        {
            title: "Read what third eye has been watching",
            description:
                "Drain the buffer the user's 'third eye' has been quietly filling from a channel they're watching. Use this when they refer to what's been happening, what someone said while they were working, or ask you to catch up — and whenever a message hints they've had it running. Returns nothing when it isn't on, which is cheap: this is a pull, so DO NOT poll it. Capture costs the user nothing; reading is the only part that spends anything, so read once and act on it rather than checking repeatedly.",
            inputSchema: {
                notableOnly: z
                    .boolean()
                    .optional()
                    .describe("Only messages that mentioned them, replied to them, or matched a term they named. Much cheaper — try this first when catching up after a long gap."),
                consume: z
                    .boolean()
                    .optional()
                    .describe("Clear what you read, so the next call returns only what is new. Prefer true once you've actually acted on it."),
                limit: z.number().int().optional().describe("Cap on messages returned (default 100)."),
                ids: z.boolean().optional().describe("Tag every message with its id.")
            },
            annotations: { readOnlyHint: true }
        },
        async ({ notableOnly, consume, limit, ids }): Promise<TextResult> => {
            try {
                const res = await bridge.call("third_eye.drain", {
                    notableOnly: notableOnly ?? false,
                    consume: consume ?? false,
                    limit: limit ?? 100
                });
                const st = res.state;

                if (!st.watching && !res.messages.length) {
                    return text(
                        "Third eye isn't running. The user turns it on from the chat-bar button in Discord — it captures quietly and costs nothing until this tool reads it."
                    );
                }

                // The plugin already refuses to watch DMs, but the guard is
                // cheap and this is the boundary where content becomes context.
                assertAllowed(cfg, st.channel);

                const where = st.channel ? `#${st.channel.name}` : "(unknown channel)";
                const head = [
                    `── third eye · ${where}${st.guild ? ` · ${st.guild.name}` : ""}`,
                    `── ${res.messages.length} shown · ${st.pending} buffered · ${st.notablePending} for you · ${st.seen} seen, ${st.matched} matched since it started`
                ];
                if (res.dropped) {
                    head.push(`── (gap: ${res.dropped} message(s) fell out of the buffer before anything read them)`);
                }
                if (!st.watching) head.push("── the watch has since stopped");

                if (!res.messages.length) {
                    return text(`${head.join("\n")}\n\nNothing new.`);
                }

                const body = compactMessages(pseudo.apply(res.messages.map(m => m.message)), {
                    truncateAt: cfg.truncateAt,
                    ids: ids ?? false,
                    stamp: "datetime"
                });

                const flagged = res.messages.filter(m => m.notable);
                const why = flagged.length
                    ? `\n\nFor you: ${flagged.map(m => `${m.message.author.displayName} (${m.reason})`).join(", ")}`
                    : "";

                return text(`${head.join("\n")}\n\n${body}${why}`);
            } catch (err) {
                return failure(err);
            }
        }
    );

    server.registerTool(
        "discord_search",
        {
            title: "Search a server's messages",
            description:
                "Search a Discord server through Discord's own search index. This is the right tool for 'find where someone mentioned X', 'did anyone post about Y', or 'what did Z say about this' — anything where you know roughly what was said but not when or in which channel. Do NOT page discord_history backwards to look for something; that reads a channel in order and will run out of context long before it reaches an old message. Needs at least one of content/authorId/mentions/has. Results carry no reactions and usually no reply body (Discord's search payloads omit them) — read a hit with discord_history around=<id> to see it in full context.",
            inputSchema: {
                guildId: z
                    .string()
                    .optional()
                    .describe("Server to search, from discord_guilds. Required unless searching a DM."),
                channelId: z
                    .string()
                    .optional()
                    .describe("Narrow a guild search to one channel, or name the DM channel to search."),
                content: z.string().optional().describe("Text to look for. Discord matches whole words, not substrings."),
                authorId: z.string().optional().describe("Only messages by this user id."),
                mentions: z.string().optional().describe("Only messages mentioning this user id."),
                has: z
                    .enum(["file", "link", "embed", "image", "sound", "video", "poll"])
                    .optional()
                    .describe("Only messages carrying this kind of thing. `file` is the one you want for logs and crash dumps."),
                before: z.string().optional().describe("Only messages older than this message id."),
                after: z.string().optional().describe("Only messages newer than this message id."),
                limit: z.number().int().optional().describe("Hits per page (default 25)."),
                offset: z.number().int().optional().describe("Skip this many hits, for paging. The tool tells you the next offset."),
                sortOrder: z
                    .enum(["asc", "desc"])
                    .optional()
                    .describe("Oldest or newest first. Defaults to newest first."),
                ids: z.boolean().optional().describe("Tag every hit with its id. On by default here — a hit you can't jump to isn't much use.")
            },
            annotations: { readOnlyHint: true }
        },
        async ({ guildId, channelId, content, authorId, mentions, has, before, after, limit, offset, sortOrder, ids }): Promise<TextResult> => {
            try {
                if (guildId && cfg.allowGuilds.length && !cfg.allowGuilds.includes(guildId)) {
                    return failure(
                        new BridgeError({ code: "forbidden", message: `Guild ${guildId} is not allowlisted.` })
                    );
                }
                // A search with no guild is a DM search, which the DM guard owns.
                if (!guildId && cfg.denyDms) {
                    return failure(
                        new BridgeError({
                            code: "forbidden",
                            message:
                                "Searching without a guildId means searching DMs, which are disabled. Pass a guildId, or set \"denyDms\": false in the sidecar config."
                        })
                    );
                }

                const res = await bridge.call("search", {
                    guildId,
                    channelId,
                    content,
                    authorId,
                    mentions,
                    has,
                    before,
                    after,
                    limit: clamp(limit ?? 25),
                    offset: offset ?? 0,
                    sortOrder
                });

                // Hits span channels, so the scope guard runs per hit rather than
                // once up front — one out-of-scope channel shouldn't void the rest.
                const allowed = res.hits.filter(h => {
                    try {
                        assertAllowed(cfg, h.channel);
                        return true;
                    } catch {
                        return false;
                    }
                });
                const dropped = res.hits.length - allowed.length;

                const body = renderSearchResults(
                    {
                        guild: res.guild,
                        hits: allowed.map(h => ({ ...h, message: pseudo.apply([h.message])[0]! })),
                        totalResults: res.totalResults,
                        offset: res.offset,
                        indexing: res.indexing
                    },
                    { truncateAt: cfg.truncateAt, ids: ids ?? true }
                );
                const note = dropped ? `\n\n(${dropped} hit(s) hidden by the sidecar's scope config)` : "";
                return text(body + note);
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
