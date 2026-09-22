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
    dmAllowed,
    renderDms,
    renderMembers,
    renderPollVoters,
    renderReactors,
    renderRoles,
    renderSearchResults,
    renderTranscript,
    zoneNote
} from "./format.js";
import { readLive } from "./live.js";
import { log } from "./log.js";
import { readMarks } from "./marks.js";
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
            timezone: cfg.timezone,
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
                    // Which process holds the socket. Since a stranded sidecar
                    // can now take the bridge over on its own, "I own it and
                    // Discord is down" and "I am proxying to a corpse" are two
                    // different states that otherwise look identical from here.
                    `held by:   ${bridge.describe()}`,
                    `account:   ${s.user ? `${s.user.displayName} (@${s.user.username})` : "unknown"}`,
                    `plugin:    ${s.pluginVersion ?? "n/a"}`,
                    `since:     ${s.connectedSince ?? "n/a"}`,
                    `port:      ${s.port}`,
                    // The DM half spells out `allowDms` rather than just
                    // "allowed", because a scoped setup and an open one differ
                    // in exactly the way that makes discord_dms come back short.
                    `scope:     ${cfg.allowGuilds.length ? `${cfg.allowGuilds.length} allowlisted guild(s)` : "all guilds"}, DMs ${cfg.denyDms ? "denied" : cfg.allowDms.length ? `allowed for ${cfg.allowDms.length} allowlisted recipient(s)` : "allowed"}`,
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
                    .describe("Clear the queue after reading it, so the same messages aren't picked up again later. Prefer true once you have actually acted on them."),
                ids: z.boolean().optional().describe("Tag every message with its id.")
            }
        },
        async ({ consume, ids }): Promise<TextResult> => {
            try {
                const out = await readMarks(bridge, cfg, pseudo, {
                    consume: consume ?? false,
                    ids: ids ?? false
                });
                if (out.items.length === 0) {
                    // "Nothing is marked" can no longer distinguish never-marked
                    // from expired, so it hedges rather than claiming either: the
                    // plugin drops stale marks on its own and nothing here can
                    // tell whether it did.
                    return text(
                        "Nothing is marked. Ask the user to right-click a message in Discord and pick \"Mark for Claude\", or use the chat-bar button to grab the last N messages. Marks also drop out on their own once they go stale, so something marked a while ago may already have expired."
                    );
                }
                return text(out.text);
            } catch (err) {
                return failure(err);
            }
        }
    );

    server.registerTool(
        "discord_clear_marks",
        {
            title: "Empty the mark queue",
            description:
                "Throw away what the user marked in Discord. Use it when they say they are done with what they marked, when they ask you to clear the queue, or after you have acted on marks and do not want them coming back on the next read. Pass `markId` to drop a single mark and leave the rest. This deletes nothing in Discord — it only empties the queue the bridge keeps.",
            inputSchema: {
                markId: z
                    .number()
                    .int()
                    .optional()
                    .describe("Drop just this one mark — the number in its `### mark N` header. Omit to empty the whole queue.")
            },
            // Spelled out because this is the first tool here that changes the
            // user's state rather than reading it.
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
        },
        async ({ markId }): Promise<TextResult> => {
            try {
                // Deliberately not scope-guarded: clearing returns a count and no
                // content, so destroying is not disclosing — and guarding it would
                // make a DM mark permanently unclearable under denyDms, which is
                // exactly the dead end this tool exists to open up.
                const { cleared } = await bridge.call(
                    "marked.clear",
                    markId === undefined ? {} : { markId }
                );
                if (markId === undefined) {
                    return text(
                        cleared
                            ? `Cleared ${cleared} mark${cleared === 1 ? "" : "s"}. The queue is empty.`
                            : "The mark queue was already empty."
                    );
                }
                return text(
                    cleared
                        ? `Cleared mark ${markId}.`
                        : `No mark ${markId} in the queue — it may already have been read with consume=true, cleared, or expired.`
                );
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
                "Drain the buffer the user's 'third eye' has been quietly filling from a channel they're watching. Use this when they refer to what's been happening, what someone said while they were working, or ask you to catch up — and whenever a message hints they've had it running. Returns nothing when it isn't on, which is cheap: this is a pull, so DO NOT poll it. Capture costs the user nothing; reading is the only part that spends anything, so read once and act on it rather than checking repeatedly. The buffer starts empty when they arm it, so it never contains what led up to its first message: the header names that anchor, and discord_history with before=<anchor> reads the run-up when the conversation doesn't stand on its own.",
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
                /*
                 * Guarded before the drain rather than after it — see live.ts.
                 * This tool defaults `consume` to false, so it never had the
                 * HTTP mirror's default data loss, but `consume: true` on an
                 * out-of-scope channel emptied the buffer and *then* refused to
                 * show it, which is the same defect wearing an opt-in.
                 */
                const res = await readLive(bridge, cfg, {
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

                const where = st.channel ? `#${st.channel.name}` : "(unknown channel)";
                const head = [
                    `── third eye · ${where}${st.guild ? ` · ${st.guild.name}` : ""}`,
                    `── ${res.messages.length} shown · ${st.pending} buffered · ${st.notablePending} for you · ${st.seen} seen, ${st.matched} matched since it started`
                ];

                /*
                 * The buffer's upstream edge, named so it can be crossed.
                 *
                 * Nothing in a drained transcript reveals that it starts where
                 * the user pressed the button rather than where the conversation
                 * did, so arming this mid-argument hands over the second half
                 * with no sign there was a first. This is the one line that makes
                 * the run-up recoverable, and it stays a pointer rather than a
                 * fetch: whether the earlier context is worth a round trip is the
                 * reader's call, not this renderer's.
                 */
                if (st.anchorId && st.channel) {
                    head.push(
                        `── buffered from msg ${st.anchorId} onward — nothing before it was captured; ` +
                            `discord_history channelId=${st.channel.id} before=${st.anchorId} reads the run-up`
                    );
                }
                if (res.dropped) {
                    head.push(`── (gap: ${res.dropped} message(s) fell out of the buffer before anything read them)`);
                }
                if (res.resumed) {
                    head.push(
                        `── (gap: Discord reloaded at ${res.resumed}; the watch survived but anything buffered and unread at that point did not)`
                    );
                }
                if (!st.watching) head.push("── the watch has since stopped");

                if (!res.messages.length) {
                    return text(`${head.join("\n")}\n\nNothing new.`);
                }

                // Only once there are stamps for it to govern.
                head.push(`── ${zoneNote(cfg.timezone)}`);

                const body = compactMessages(pseudo.apply(res.messages.map(m => m.message)), {
                    truncateAt: cfg.truncateAt,
                    timezone: cfg.timezone,
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
                    { truncateAt: cfg.truncateAt, timezone: cfg.timezone, ids: ids ?? true }
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
        "discord_dms",
        {
            title: "List direct messages",
            description:
                "List the account's DMs and group DMs with the people in each, most recently active first. This is how you turn \"the DM with Avery\" into a channelId for discord_history or discord_search — discord_channels only knows a server's channels, so there is no other way to find one. Reach for it the moment the user names a person rather than a place. Do NOT go looking for a DM with discord_current_view: that reads whichever conversation happens to be on screen, which is how you end up reading a private one nobody asked about.",
            inputSchema: {
                ids: z
                    .boolean()
                    .optional()
                    .describe("Tag every recipient with their account id, which is what discord_search authorId= wants.")
            },
            annotations: { readOnlyHint: true }
        },
        async ({ ids }): Promise<TextResult> => {
            try {
                /*
                 * Guarded by hand rather than through assertAllowed, because
                 * there is no channel here to guard — only a list of them. Both
                 * halves still come from the same place: `denyDms` refuses
                 * outright and `dmAllowed` filters, so this surface cannot
                 * disagree with the read that follows it about any one channel.
                 *
                 * The refusal is not pedantry about content. This listing *is*
                 * the disclosure: names, account ids and who the user talks to
                 * most, without a single message body in it. Serving it under
                 * denyDms would hand over the address book while claiming the
                 * letters were private.
                 */
                if (cfg.denyDms) {
                    return failure(
                        new BridgeError({
                            code: "forbidden",
                            message:
                                "DMs are disabled, and listing them would disclose who the account talks to. Set \"denyDms\": false in the sidecar config to allow them."
                        })
                    );
                }

                const { dms } = await bridge.call("dms", {});
                // Filtered on the real ids, before the Pseudonymizer rewrites
                // them — an alias would match nothing in allowDms and every DM
                // would vanish under `pseudonymize: true`.
                const visible = dms.filter(d => dmAllowed(cfg, d.recipients.map(u => u.id)));

                if (!visible.length && !dms.length) {
                    return text(
                        "The client reports no DM channels at all. If the user is sure they have some, the plugin may have connected before Discord finished loading its stores — discord_status says whether it is connected."
                    );
                }

                return text(
                    renderDms(
                        {
                            dms: visible.map(d => ({ ...d, recipients: pseudo.applyUsers(d.recipients) })),
                            hidden: dms.length - visible.length
                        },
                        { ids: ids ?? false }
                    )
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
                // A forward carries its attachments inside `forwarded`, not
                // `attachments` — the message itself is usually empty besides it.
                const pool = message.attachments.concat(message.forwarded?.attachments ?? []);
                if (!pool.length) {
                    return failure(
                        new BridgeError({ code: "not_found", message: `Message ${messageId} has no attachments.` })
                    );
                }

                const wanted = filename ? pool.find(a => a.filename === filename) : pool[0];
                if (!wanted) {
                    return failure(
                        new BridgeError({
                            code: "not_found",
                            message: `No attachment named ${filename}. Available: ${pool.map(a => a.filename).join(", ")}`
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

    server.registerTool(
        "discord_reactors",
        {
            title: "List who reacted to a message",
            description:
                "Expand a reaction into the actual list of people behind it. `discord_history` reports a reaction as a bare count — this says which accounts make it up. Reach for it whenever the question is who rather than how many: who signed up via a 👍 sign-up post, whether the user themselves reacted, or which people appear on two different messages. Names a single reaction with `emoji`, or expands every reaction on the message when that is omitted. Discord pages these 100 at a time, so a very popular message needs a higher `limit`.",
            inputSchema: {
                channelId: z.string().describe("Channel the message is in."),
                messageId: z.string().describe("Id of the message. discord_history with ids=true prints these."),
                emoji: z
                    .string()
                    .optional()
                    .describe("Which reaction, written the way history prints it — \"👍\" for a unicode emoji, \":fire1:\" or \"fire1\" for a custom one. Omit to expand every reaction on the message."),
                limit: z
                    .number()
                    .optional()
                    .describe("Users to collect per reaction (default 100, max 500). Anything short of the reported count is flagged in the output."),
                ids: z.boolean().optional().describe("Tag every user with their account id, for cross-referencing.")
            },
            annotations: { readOnlyHint: true }
        },
        async ({ channelId, messageId, emoji, limit, ids }): Promise<TextResult> => {
            try {
                const res = await bridge.call("reactors", { channelId, messageId, emoji, limit });
                assertAllowed(cfg, res.channel);

                if (!res.message) {
                    return failure(
                        new BridgeError({ code: "not_found", message: `Message ${messageId} was not found in ${channelId}.` })
                    );
                }

                return text(
                    renderReactors(
                        {
                            channel: res.channel,
                            // Pseudonymised through the same map the transcripts
                            // use, so an alias means the same person in both.
                            message: pseudo.apply([res.message])[0]!,
                            groups: res.groups.map(g => ({ ...g, users: pseudo.applyUsers(g.users) })),
                            skipped: res.skipped
                        },
                        { timezone: cfg.timezone, ids: ids ?? false }
                    )
                );
            } catch (err) {
                return failure(err);
            }
        }
    );

    server.registerTool(
        "discord_poll_voters",
        {
            title: "List who voted for a poll answer",
            description:
                "Expand a poll answer into the accounts that picked it. `discord_history` reports each answer as a bare count — this says which accounts make it up. Names a single answer with `answerId` (discord_history prints each answer's id), or expands every answer on the poll when that is omitted. Discord pages these 100 at a time, so a heavily-voted answer needs a higher `limit`.",
            inputSchema: {
                channelId: z.string().describe("Channel the message is in."),
                messageId: z.string().describe("Id of the message that has the poll."),
                answerId: z
                    .number()
                    .optional()
                    .describe("Which answer, by its numeric id. Omit to expand every answer on the poll."),
                limit: z
                    .number()
                    .optional()
                    .describe("Voters to collect per answer (default 100, max 500). Anything short of the reported count is flagged in the output."),
                ids: z.boolean().optional().describe("Tag every user with their account id, for cross-referencing.")
            },
            annotations: { readOnlyHint: true }
        },
        async ({ channelId, messageId, answerId, limit, ids }): Promise<TextResult> => {
            try {
                const res = await bridge.call("pollVoters", { channelId, messageId, answerId, limit });
                assertAllowed(cfg, res.channel);

                if (!res.message) {
                    return failure(
                        new BridgeError({ code: "not_found", message: `Message ${messageId} was not found in ${channelId}.` })
                    );
                }

                return text(
                    renderPollVoters(
                        {
                            channel: res.channel,
                            message: pseudo.apply([res.message])[0]!,
                            answers: res.answers.map(a => ({ ...a, users: pseudo.applyUsers(a.users) })),
                            skipped: res.skipped
                        },
                        { timezone: cfg.timezone, ids: ids ?? false }
                    )
                );
            } catch (err) {
                return failure(err);
            }
        }
    );

    server.registerTool(
        "discord_members",
        {
            title: "List guild members currently loaded in the client",
            description:
                "List members of a guild from whatever the client already has cached — NOT a full roster. Discord only streams online members to a normal account once a guild passes roughly 1,000 people, so on a large server this is a partial, online-skewed slice, and the output says so. Filter with `roleId` (see discord_roles) or `query` (matches username or nickname) to narrow it.",
            inputSchema: {
                guildId: z.string().describe("Server id, from discord_guilds."),
                roleId: z.string().optional().describe("Only members holding this role id — discord_roles lists them."),
                query: z.string().optional().describe("Case-insensitive substring match against username or nickname."),
                limit: z.number().optional().describe("Members to return (default 200, max 500)."),
                ids: z.boolean().optional().describe("Tag every member with their account id, for cross-referencing.")
            },
            annotations: { readOnlyHint: true }
        },
        async ({ guildId, roleId, query, limit, ids }): Promise<TextResult> => {
            try {
                if (cfg.allowGuilds.length && !cfg.allowGuilds.includes(guildId)) {
                    return failure(
                        new BridgeError({ code: "forbidden", message: `Guild ${guildId} is not allowlisted.` })
                    );
                }

                const res = await bridge.call("members", { guildId, roleId, query, limit });
                const members = res.members.map(m => ({
                    ...m,
                    ...pseudo.applyUsers([{ id: m.id, username: m.username, displayName: m.displayName, bot: m.bot }])[0]!
                }));

                return text(renderMembers({ ...res, members }, { ids: ids ?? false }));
            } catch (err) {
                return failure(err);
            }
        }
    );

    server.registerTool(
        "discord_roles",
        {
            title: "List a guild's roles",
            description:
                "List every role in a guild with its id, name and colour. Use the id with discord_members' `roleId` filter to find who holds a given role.",
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

                const res = await bridge.call("roles", { guildId });
                return text(renderRoles(res));
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
