/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A plain localhost HTTP mirror of the MCP tools.
 *
 * MCP is the good path, but it is not always wired up — a subagent with a
 * trimmed toolset, a shell one-liner, a quick sanity check while debugging the
 * bridge itself. This returns the exact same text the MCP tools return, so
 * `curl` and the model see the same thing.
 *
 * Responses are text/plain on purpose: this output is meant to be read, not
 * parsed. Add `?json=1` when you want the underlying objects.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { fetchAttachment } from "./attachments.js";
import { BridgeError, type BridgeServer } from "./bridge-server.js";
import type { Config } from "./config.js";
import {
    Pseudonymizer,
    assertAllowed,
    compactMessages,
    renderSearchResults,
    renderTranscript
} from "./format.js";
import { log } from "./log.js";

export function startHttpApi(bridge: BridgeServer, cfg: Config): Server {
    const pseudo = new Pseudonymizer(cfg.pseudonymize);

    const server = createServer((req, res) => {
        handle(req, res).catch(err => {
            log.error("http handler blew up:", err);
            send(res, 500, `internal: ${err instanceof Error ? err.message : String(err)}`);
        });
    });

    function send(res: ServerResponse, status: number, body: string) {
        const buf = Buffer.from(body, "utf8");
        res.writeHead(status, {
            "content-type": "text/plain; charset=utf-8",
            "content-length": buf.length,
            // Nothing here is for a browser to read cross-origin.
            "access-control-allow-origin": "null",
            "x-content-type-options": "nosniff"
        });
        res.end(buf);
    }

    function sendJson(res: ServerResponse, status: number, value: unknown) {
        const buf = Buffer.from(JSON.stringify(value, null, 2), "utf8");
        res.writeHead(status, {
            "content-type": "application/json; charset=utf-8",
            "content-length": buf.length,
            "x-content-type-options": "nosniff"
        });
        res.end(buf);
    }

    function authorized(req: IncomingMessage): boolean {
        const header = req.headers.authorization ?? "";
        const match = /^Bearer\s+(.+)$/i.exec(header);
        // Deliberately header-only: a token in a query string leaks into shell
        // history, proxy logs and Referer headers.
        return match?.[1]?.trim() === cfg.token;
    }

    async function handle(req: IncomingMessage, res: ServerResponse) {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${cfg.httpPort}`);
        const q = url.searchParams;

        if (!authorized(req)) {
            return send(res, 401, "unauthorized — send: Authorization: Bearer <token from `npm run token`>\n");
        }

        const wantJson = q.get("json") === "1";
        const ids = q.get("ids") === "1";
        const limit = q.has("limit") ? Number.parseInt(q.get("limit")!, 10) : undefined;
        const clamped = Math.max(1, Math.min(limit ?? cfg.defaultLimit, cfg.maxLimit));

        const render = (
            guild: Parameters<typeof renderTranscript>[0],
            channel: Parameters<typeof renderTranscript>[1],
            messages: Parameters<typeof renderTranscript>[2]
        ) =>
            renderTranscript(guild, channel, pseudo.apply(messages), {
                truncateAt: cfg.truncateAt,
                ids
            });

        try {
            switch (url.pathname) {
                case "/":
                case "/status":
                    return sendJson(res, 200, { ...bridge.status(), scope: {
                        allowGuilds: cfg.allowGuilds,
                        denyDms: cfg.denyDms,
                        pseudonymize: cfg.pseudonymize
                    } });

                case "/current-view": {
                    const view = await bridge.call("current_view", { limit: clamped });
                    assertAllowed(cfg, view.channel);
                    return wantJson
                        ? sendJson(res, 200, view)
                        : send(res, 200, render(view.guild, view.channel, view.messages) + "\n");
                }

                case "/marked": {
                    const { items } = await bridge.call("marked.list", { consume: q.get("consume") === "1" });
                    if (wantJson) return sendJson(res, 200, items);
                    if (!items.length) return send(res, 200, "nothing marked\n");
                    const body = items
                        .map(i => {
                            assertAllowed(cfg, i.channel);
                            return `### mark ${i.markId} · ${i.markedAt}\n${render(i.guild, i.channel, i.messages)}`;
                        })
                        .join("\n\n");
                    return send(res, 200, body + "\n");
                }

                case "/history": {
                    const channelId = q.get("channelId");
                    if (!channelId) return send(res, 400, "missing channelId\n");
                    const out = await bridge.call("history", {
                        channelId,
                        limit: clamped,
                        before: q.get("before") ?? undefined,
                        after: q.get("after") ?? undefined,
                        around: q.get("around") ?? undefined
                    });
                    assertAllowed(cfg, out.channel);
                    return wantJson
                        ? sendJson(res, 200, out)
                        : send(res, 200, render(null, out.channel, out.messages) + "\n");
                }

                case "/live": {
                    // The UserPromptSubmit hook curls this on every message the
                    // user sends, so it has to be cheap and it has to stay quiet
                    // when there's nothing to say — a hook that always prints
                    // something is a hook that gets turned off.
                    const out = await bridge.call("third_eye.drain", {
                        notableOnly: q.get("notableOnly") === "1",
                        consume: q.get("consume") !== "0",
                        limit: limit ?? 100
                    });

                    if (wantJson) return sendJson(res, 200, out);
                    if (!out.state.watching && !out.messages.length) return send(res, 200, "");
                    if (!out.messages.length) return send(res, 200, "");

                    assertAllowed(cfg, out.state.channel);

                    const where = out.state.channel ? `#${out.state.channel.name}` : "(unknown)";
                    const gap = out.dropped
                        ? `\n(gap: ${out.dropped} message(s) fell out of the buffer unread)`
                        : "";
                    const body = compactMessages(pseudo.apply(out.messages.map(m => m.message)), {
                        truncateAt: cfg.truncateAt,
                        stamp: "datetime"
                    });
                    return send(
                        res,
                        200,
                        `Third eye · ${where} · ${out.messages.length} new${gap}\n\n${body}\n`
                    );
                }

                case "/third-eye": {
                    const st = await bridge.call("third_eye.state", {});
                    return sendJson(res, 200, st);
                }

                case "/search": {
                    const guildId = q.get("guildId") ?? undefined;
                    const channelId = q.get("channelId") ?? undefined;
                    if (guildId && cfg.allowGuilds.length && !cfg.allowGuilds.includes(guildId)) {
                        return send(res, 403, `forbidden: guild ${guildId} is not allowlisted\n`);
                    }
                    if (!guildId && cfg.denyDms) {
                        return send(
                            res,
                            403,
                            "forbidden: searching without a guildId searches DMs, which are disabled. Pass guildId, or set \"denyDms\": false in the sidecar config.\n"
                        );
                    }

                    const out = await bridge.call("search", {
                        guildId,
                        channelId,
                        content: q.get("content") ?? undefined,
                        authorId: q.get("authorId") ?? undefined,
                        mentions: q.get("mentions") ?? undefined,
                        has: (q.get("has") as any) ?? undefined,
                        before: q.get("before") ?? undefined,
                        after: q.get("after") ?? undefined,
                        limit: Math.max(1, Math.min(limit ?? 25, cfg.maxLimit)),
                        offset: q.has("offset") ? Number.parseInt(q.get("offset")!, 10) : 0,
                        sortOrder: (q.get("sortOrder") as "asc" | "desc" | null) ?? undefined
                    });

                    const allowed = out.hits.filter(h => {
                        try {
                            assertAllowed(cfg, h.channel);
                            return true;
                        } catch {
                            return false;
                        }
                    });

                    return wantJson
                        ? sendJson(res, 200, { ...out, hits: allowed })
                        : send(
                              res,
                              200,
                              renderSearchResults(
                                  {
                                      guild: out.guild,
                                      hits: allowed.map(h => ({ ...h, message: pseudo.apply([h.message])[0]! })),
                                      totalResults: out.totalResults,
                                      offset: out.offset,
                                      indexing: out.indexing
                                  },
                                  { truncateAt: cfg.truncateAt, ids: q.get("ids") !== "0" }
                              ) + "\n"
                          );
                }

                case "/resolve": {
                    const link = q.get("url");
                    if (!link) return send(res, 400, "missing url\n");
                    const out = await bridge.call("resolve_link", {
                        url: link,
                        context: q.has("context") ? Number.parseInt(q.get("context")!, 10) : 10
                    });
                    assertAllowed(cfg, out.channel);
                    return wantJson
                        ? sendJson(res, 200, out)
                        : send(res, 200, render(out.guild, out.channel, out.context) + "\n");
                }

                case "/guilds": {
                    const { guilds } = await bridge.call("guilds", {});
                    const visible = cfg.allowGuilds.length
                        ? guilds.filter(g => cfg.allowGuilds.includes(g.id))
                        : guilds;
                    return wantJson
                        ? sendJson(res, 200, visible)
                        : send(res, 200, visible.map(g => `${g.id}  ${g.name}`).join("\n") + "\n");
                }

                case "/channels": {
                    const guildId = q.get("guildId");
                    if (!guildId) return send(res, 400, "missing guildId\n");
                    const { channels } = await bridge.call("channels", { guildId });
                    return wantJson
                        ? sendJson(res, 200, channels)
                        : send(res, 200, channels.map(c => `${c.id}  #${c.name}`).join("\n") + "\n");
                }

                case "/attachment": {
                    const channelId = q.get("channelId");
                    const messageId = q.get("messageId");
                    if (!channelId || !messageId) return send(res, 400, "missing channelId or messageId\n");
                    const out = await bridge.call("history", { channelId, around: messageId, limit: 3 });
                    assertAllowed(cfg, out.channel);
                    const message = out.messages.find(m => m.id === messageId);
                    const name = q.get("filename");
                    const att = name
                        ? message?.attachments.find(a => a.filename === name)
                        : message?.attachments[0];
                    if (!att) return send(res, 404, "no such attachment\n");
                    const saved = await fetchAttachment(cfg, att, messageId);
                    return wantJson
                        ? sendJson(res, 200, saved)
                        : send(res, 200, `${saved.path}\n`);
                }

                default:
                    return send(res, 404, "unknown route\n");
            }
        } catch (err) {
            if (err instanceof BridgeError) {
                const status = err.rpc.code === "no_client" ? 503 : err.rpc.code === "forbidden" ? 403 : 400;
                return send(res, status, `${err.rpc.code}: ${err.rpc.message}\n`);
            }
            throw err;
        }
    }

    server.listen(cfg.httpPort, "127.0.0.1", () => {
        log.info(`http api listening on http://127.0.0.1:${cfg.httpPort}`);
    });

    return server;
}
