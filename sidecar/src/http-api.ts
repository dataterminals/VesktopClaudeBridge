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
import { BridgeError, type Bridge } from "./bridge-server.js";
import type { Config } from "./config.js";
import {
    Pseudonymizer,
    assertAllowed,
    compactMessages,
    renderReactors,
    renderSearchResults,
    renderTranscript,
    zoneNote
} from "./format.js";
import { readLive } from "./live.js";
import { log } from "./log.js";
import { readMarks } from "./marks.js";

/*
 * Binding is retried, and the reason is promotion. When a stranded proxy takes
 * the bridge over from a dead owner it starts this mirror on the port that owner
 * held, and the OS is sometimes a few milliseconds behind us in releasing it.
 * Losing this bind is not cosmetic: the mirror is the only way another sidecar
 * can find this one, so a promoted owner without it is invisible, and the next
 * session starts a second bridge that nobody can reach.
 */
const BIND_ATTEMPTS = 5;
const BIND_RETRY_MS = 300;

/** One bind attempt, resolving on `listening` and rejecting on `error`. */
function bindOnce(server: Server, cfg: Config): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
            server.removeListener("listening", onListening);
            reject(err);
        };
        const onListening = () => {
            server.removeListener("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(cfg.httpPort, "127.0.0.1");
    });
}

async function listenWithRetry(server: Server, cfg: Config): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await bindOnce(server, cfg);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= BIND_ATTEMPTS) throw err;
            log.debug(
                `:${cfg.httpPort} is still busy (attempt ${attempt}/${BIND_ATTEMPTS}); the previous owner's socket may still be closing`
            );
            await new Promise(resolve => setTimeout(resolve, BIND_RETRY_MS));
        }
    }
}

export async function startHttpApi(bridge: Bridge, cfg: Config): Promise<Server> {
    const pseudo = new Pseudonymizer(cfg.pseudonymize);

    /*
     * When this process started *serving the bridge*, which for a promoted owner
     * is a very different number from when the process itself came up. `/status`
     * publishes it as `owner.since`, and that field's whole job is to let a human
     * looking at two sidecars tell which one is holding the socket and since when.
     */
    const servingSince = new Date().toISOString();

    const server = createServer((req, res) => {
        handle(req, res).catch(err => {
            log.error("http handler blew up:", err);
            send(res, 500, `internal: ${err instanceof Error ? err.message : String(err)}`);
        });
    });

    function send(res: ServerResponse, status: number, body: string, extra?: Record<string, string>) {
        const buf = Buffer.from(body, "utf8");
        res.writeHead(status, {
            "content-type": "text/plain; charset=utf-8",
            "content-length": buf.length,
            // Nothing here is for a browser to read cross-origin.
            "access-control-allow-origin": "null",
            "x-content-type-options": "nosniff",
            // Merged last so a route can add the one header only it needs. The
            // 405 on /marked/clear is why this exists: a 405 with no `Allow` is
            // the one response where the header is genuinely load-bearing.
            ...extra
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

        /*
         * The transport for client mode: a raw passthrough to the plugin, so a
         * second sidecar can borrow this one's Discord connection instead of
         * dying on the port.
         *
         * Deliberately unrendered and unguarded — scope guards live at the
         * rendering layer, and the caller is another sidecar that will apply
         * them itself from the same config file. Token-gated and loopback-only
         * like everything else here.
         */
        if (url.pathname === "/rpc" && req.method === "POST") {
            const raw = await new Promise<string>(resolve => {
                let buf = "";
                req.on("data", c => (buf += c));
                req.on("end", () => resolve(buf));
            });
            let parsed: any;
            try {
                parsed = JSON.parse(raw);
            } catch {
                return sendJson(res, 400, { ok: false, error: { code: "bad_params", message: "body must be json" } });
            }
            if (!parsed?.method) {
                return sendJson(res, 400, { ok: false, error: { code: "bad_params", message: "method is required" } });
            }
            try {
                const data = await bridge.call(parsed.method, parsed.params ?? {});
                return sendJson(res, 200, { ok: true, data });
            } catch (err) {
                if (err instanceof BridgeError) {
                    return sendJson(res, 200, { ok: false, error: err.rpc });
                }
                throw err;
            }
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
                timezone: cfg.timezone,
                ids
            });

        try {
            switch (url.pathname) {
                case "/":
                case "/status":
                    return sendJson(res, 200, {
                        ...bridge.status(),
                        // Only the owner ever serves HTTP, so this identifies
                        // whoever holds the Discord socket. "Already running"
                        // is a dead end without it — you can't stop, inspect or
                        // take over a process you can't name.
                        owner: { pid: process.pid, since: servingSince },
                        scope: {
                            allowGuilds: cfg.allowGuilds,
                            denyDms: cfg.denyDms,
                            pseudonymize: cfg.pseudonymize
                        }
                    });

                case "/current-view": {
                    const view = await bridge.call("current_view", { limit: clamped });
                    assertAllowed(cfg, view.channel);
                    return wantJson
                        ? sendJson(res, 200, view)
                        : send(res, 200, render(view.guild, view.channel, view.messages) + "\n");
                }

                case "/marked": {
                    /*
                     * Both the rendering and the consuming live in readMarks now,
                     * which is what stops `consume=1` destroying the queue before
                     * the scope guard has had a chance to refuse it. json mode
                     * goes through the same path deliberately: it used to return
                     * items before the guard ran, which meant `?json=1` read DM
                     * content that the text route correctly refused.
                     *
                     * The two paths are equivalent on the *guard*, and on nothing
                     * else — pseudonyms in particular. `out.items` is what the
                     * plugin sent, so `?json=1` carries real usernames even under
                     * `pseudonymize: true`, because that substitution lives
                     * inside renderTranscript and only the text branch below goes
                     * through it. That is true of every json route here
                     * (/current-view, /history, /live, /search) and predates this
                     * route sharing readMarks: `?json=1` means the underlying
                     * objects, and half-rewritten objects would be worse than
                     * plain ones. If it changes it changes for all of them.
                     */
                    const out = await readMarks(bridge, cfg, pseudo, {
                        consume: q.get("consume") === "1",
                        ids
                    });
                    if (wantJson) return sendJson(res, 200, out.items);
                    if (!out.items.length) {
                        return send(
                            res,
                            200,
                            "nothing marked — either nothing has been, or what was here has since gone stale and expired\n"
                        );
                    }
                    return send(res, 200, out.text + "\n");
                }

                case "/marked/clear": {
                    /*
                     * The only route besides /rpc with an opinion about method,
                     * and deliberately so. This mirror gets pasted into shell
                     * history and into scripts, and GET is the verb every
                     * library, proxy and re-run feels free to retry on its own.
                     * Reading marks twice costs nothing; clearing twice loses
                     * whatever arrived in between.
                     *
                     * Nested under the noun it mutates rather than DELETE
                     * /marked, because one path that either reads or destroys
                     * depending on an invisible method flag is a worse trap for a
                     * hand-typed curl than a distinct path is.
                     */
                    if (req.method !== "POST") {
                        return send(
                            res,
                            405,
                            "clearing marks is destructive, so this route only answers POST:\n" +
                                `  curl -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:${cfg.httpPort}/marked/clear\n`,
                            { allow: "POST" }
                        );
                    }

                    let markId: number | undefined;
                    if (q.has("markId")) {
                        const parsed = Number.parseInt(q.get("markId")!, 10);
                        // Never coerced to "clear everything": a typo in the one
                        // parameter that limits the blast radius must not widen it.
                        if (!Number.isFinite(parsed)) {
                            return send(res, 400, "markId must be a number — it is the N in `### mark N`\n");
                        }
                        markId = parsed;
                    }

                    /*
                     * No assertAllowed here, on purpose. The scope guard exists to
                     * stop content crossing this boundary, and `marked.clear`
                     * returns a count and nothing else — destroying is not
                     * disclosing. Guarding it would make a DM mark permanently
                     * unclearable, which is the worse outcome: today a single DM
                     * mark 403s the whole /marked response, leaving the queue both
                     * unreadable and unclearable except through raw /rpc. This is
                     * the escape hatch from that state, and only because it is
                     * unguarded.
                     */
                    const { cleared } = await bridge.call(
                        "marked.clear",
                        markId === undefined ? {} : { markId }
                    );
                    return wantJson
                        ? sendJson(res, 200, { cleared })
                        : send(res, 200, `cleared ${cleared} mark(s)\n`);
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
                    /*
                     * The UserPromptSubmit hook curls this on every message the
                     * user sends, so it has to be cheap and it has to stay quiet
                     * when there's nothing to say — a hook that always prints
                     * something is a hook that gets turned off.
                     *
                     * The guard and the drain both live in readLive now, in that
                     * order. This route used to call `third_eye.drain` inline and
                     * return `sendJson` before ever reaching `assertAllowed`, so
                     * `?json=1` served DM content that plain `/live` refused —
                     * and because `consume` defaults to true here, the refusal on
                     * the text path had already emptied the buffer it was
                     * refusing to show. Both exits go through one guarded call
                     * now, which is the same repair /marked got.
                     */
                    const out = await readLive(bridge, cfg, {
                        notableOnly: q.get("notableOnly") === "1",
                        consume: q.get("consume") !== "0",
                        limit: limit ?? 100
                    });

                    if (wantJson) return sendJson(res, 200, out);
                    if (!out.state.watching && !out.messages.length) return send(res, 200, "");
                    if (!out.messages.length) return send(res, 200, "");

                    const where = out.state.channel ? `#${out.state.channel.name}` : "(unknown)";

                    /*
                     * The anchor rides the header line rather than getting a line
                     * of its own, and carries no instructions with it.
                     *
                     * This runs on every message the user sends, so a sentence
                     * here is a sentence billed hundreds of times to say
                     * something that matters on a handful of them. One snowflake
                     * is enough to make the gap recoverable — it says the buffer
                     * has an upstream edge and where it is, and `discord_live`
                     * spells out what to do about it for the reader who needs to.
                     */
                    const from = out.state.anchorId ? ` · from msg ${out.state.anchorId}` : "";

                    const gaps: string[] = [];
                    if (out.dropped) {
                        gaps.push(`(gap: ${out.dropped} message(s) fell out of the buffer unread)`);
                    }
                    // Prints once and only once: /live consumes by default, which
                    // is what clears the flag in the plugin.
                    if (out.resumed) {
                        gaps.push(
                            `(gap: Discord reloaded at ${out.resumed}; the watch survived, anything unread at that point did not)`
                        );
                    }
                    const gap = gaps.length ? `\n${gaps.join("\n")}` : "";

                    const body = compactMessages(pseudo.apply(out.messages.map(m => m.message)), {
                        truncateAt: cfg.truncateAt,
                        timezone: cfg.timezone,
                        stamp: "datetime"
                    });
                    return send(
                        res,
                        200,
                        `Third eye · ${where} · ${out.messages.length} new · ${zoneNote(cfg.timezone)}${from}${gap}\n\n${body}\n`
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
                                  {
                                      truncateAt: cfg.truncateAt,
                                      timezone: cfg.timezone,
                                      ids: q.get("ids") !== "0"
                                  }
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

                case "/reactors": {
                    const channelId = q.get("channelId");
                    const messageId = q.get("messageId");
                    if (!channelId || !messageId) return send(res, 400, "missing channelId or messageId\n");
                    const out = await bridge.call("reactors", {
                        channelId,
                        messageId,
                        emoji: q.get("emoji") ?? undefined,
                        limit: q.has("limit") ? Number.parseInt(q.get("limit")!, 10) : undefined
                    });
                    assertAllowed(cfg, out.channel);
                    if (!out.message) return send(res, 404, "no such message\n");
                    if (wantJson) return sendJson(res, 200, out);
                    return send(
                        res,
                        200,
                        renderReactors(
                            {
                                channel: out.channel,
                                message: pseudo.apply([out.message])[0]!,
                                groups: out.groups.map(g => ({ ...g, users: pseudo.applyUsers(g.users) })),
                                skipped: out.skipped
                            },
                            { timezone: cfg.timezone, ids: q.has("ids") }
                        ) + "\n"
                    );
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

    await listenWithRetry(server, cfg);
    log.info(`http api listening on http://127.0.0.1:${cfg.httpPort}`);

    // Permanent, and it is a bug fix rather than tidiness: until now `listen()`
    // had no error handler at all, so any error on this server — including a late
    // EADDRINUSE — emitted on an EventEmitter with nothing listening and became
    // an uncaught exception. That is a process crash sitting directly on the
    // promotion path, where a bind against a just-released port is expected.
    server.on("error", err => log.error(`http api error on :${cfg.httpPort}:`, err));

    return server;
}
