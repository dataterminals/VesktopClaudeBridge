#!/usr/bin/env node
/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Entry point. Three things live in this process:
 *
 *   - a websocket server the Equicord plugin dials into
 *   - an MCP server on stdio, which is how the model gets at any of it
 *   - a small HTTP mirror for curl
 *
 * It is deliberately one process: the plugin holds the only authenticated view
 * of Discord, so everything that wants that view has to share a connection to it.
 */

import { BridgeHolder, bindBridge, type Serve } from "./bridge-holder.js";
import { ensureConfigFile, loadConfig } from "./config.js";
import { startHttpApi } from "./http-api.js";
import { log, setLogLevel } from "./log.js";
import { createMcpServer, serveMcpOverStdio } from "./mcp.js";
import {
    RemoteBridge,
    describeOwner,
    findOwner,
    stopOwner,
    waitForOwner,
    type OwnerInfo
} from "./remote-bridge.js";

const VERSION = "0.1.0";

/** `--no-mcp` ran, found the bridge already served, and did nothing. Not a failure. */
const EXIT_ALREADY_SERVED = 3;

async function main() {
    const args = new Set(process.argv.slice(2));

    const cfg = loadConfig();
    setLogLevel(cfg.logLevel);

    if (args.has("--print-token")) {
        // The one and only thing this program is allowed to put on stdout when
        // it isn't speaking MCP.
        process.stdout.write(cfg.token + "\n");
        return;
    }

    const configPath = ensureConfigFile(cfg);
    log.info(`VesktopClaudeBridge sidecar v${VERSION}`);
    log.info(`config: ${configPath}`);
    log.info(`downloads: ${cfg.downloadDir}`);

    /*
     * Everything between "we hold the socket" and "other processes can find us".
     *
     * Defined once and handed to the holder, because a sidecar that promotes
     * itself has to do exactly this too — and a promoted owner that skipped the
     * HTTP mirror would be invisible to the next session, which would start its
     * own bridge, fail to bind, and break the find-the-owner mechanism outright.
     * Same function, so the startup path and the promotion path cannot drift.
     */
    const serve: Serve = async server => {
        server.on("plugin-event", (event: string) => {
            // Marks are pulled, not pushed — MCP has no way to wake the model up.
            // This is just so `--log-level debug` shows you the user clicked.
            log.debug(`plugin event: ${event}`);
        });

        if (!cfg.http) {
            log.warn(
                "http is disabled, so nothing else can find this bridge — the next Claude session will not be able to start one"
            );
            return;
        }
        try {
            await startHttpApi(server, cfg);
        } catch (err) {
            // Keep the websocket regardless: being an unfindable owner still
            // serves this process's own MCP client, and dropping the socket here
            // would leave nobody serving Discord at all.
            log.error(
                `bound the bridge but could not serve http on :${cfg.httpPort}; no other sidecar will find this one`,
                err
            );
        }
    };

    /*
     * The plugin dials exactly one socket, so exactly one process can own it —
     * but Claude Code and Claude Desktop each spawn their own sidecar. Whoever
     * gets here first owns the Discord connection and serves everyone else;
     * the rest proxy through it rather than dying on the port.
     */
    let existing = await findOwner(cfg);

    /*
     * --takeover exists for the hand-launched case: you opened a window meaning
     * to run the sidecar here, found someone else already had it, and said take
     * it anyway. It is never implied — a session-spawned sidecar that stole the
     * socket from another session would be the worst possible default.
     */
    if (existing && args.has("--takeover")) {
        log.info(`taking the bridge over from ${describeOwner(existing)}`);
        if (await stopOwner(cfg, existing)) existing = null;
        else log.warn("takeover failed; proxying through the existing owner instead");
    }

    /*
     * Becoming a proxy, from either of the two ways you can get here: finding an
     * owner up front, or losing the bind to one that started in the same instant.
     *
     * `gone` is what makes the bridge self-heal. Before it existed, the death of
     * the owner stranded this process for good — every call reported that the
     * owner had stopped answering, and the only fix was restarting every
     * session's sidecar by hand.
     */
    const startProxy = async (owner: OwnerInfo): Promise<BridgeHolder> => {
        const remote = new RemoteBridge(cfg);
        const holder = BridgeHolder.proxying(remote, cfg, VERSION, serve);
        await remote.attach({
            gone: () => void holder.promote(),
            alive: () => holder.ownerAnswered()
        });
        log.info(`the bridge on :${cfg.port} is held by ${describeOwner(owner)}; proxying through :${cfg.httpPort}`);
        return holder;
    };

    let holder: BridgeHolder;

    if (existing) {
        holder = await startProxy(existing);
    } else {
        const server = await bindBridge(cfg, VERSION);
        if (server) {
            holder = BridgeHolder.owning(server, cfg, VERSION, serve);
            await serve(server);
        } else {
            /*
             * We and another sidecar started in the same instant and it won the
             * bind — `findOwner()` ran before either of us was listening. Before
             * this branch existed that rejection reached main().catch and became
             * process.exit(1), which an MCP host renders as "Connection closed":
             * the exact symptom remote-bridge.ts was written to eliminate.
             */
            const winner = await waitForOwner(cfg);
            if (!winner) {
                log.error(
                    `something bound ws://127.0.0.1:${cfg.port} but nothing answers on :${cfg.httpPort}; this process has nothing to serve`
                );
                process.exitCode = 1;
                return;
            }
            holder = await startProxy(winner);
        }
    }

    if (args.has("--no-mcp")) {
        /*
         * A proxy with no MCP client has nothing to do: the websocket and the
         * HTTP mirror both belong to whoever got here first, and there is no
         * stdio peer to serve. That is a perfectly good outcome — the bridge is
         * up, just not ours — but exiting 0 in silence reads as a crash to
         * anyone who got here by double-clicking a launcher. Say which it is.
         */
        if (!holder.isOwner) {
            log.info(`the bridge on :${cfg.port} is already up and being served by ${holder.describe()}`);
            log.info(
                args.has("--takeover")
                    ? "the takeover did not succeed, so this process is standing down"
                    : "nothing for this process to do — re-run with --takeover to serve it here instead"
            );
            await holder.close();
            // Distinct from both success and failure: nothing went wrong, but
            // nothing was served either. The launcher branches on this to offer
            // taking over rather than reporting a stop that never started.
            process.exitCode = EXIT_ALREADY_SERVED;
            return;
        }
        log.info("running without MCP (bridge + http only)");
    } else {
        // The holder, not the bridge inside it: if this process ever promotes
        // itself, every tool has to end up talking to the new BridgeServer
        // without knowing anything happened.
        const mcp = createMcpServer(holder, cfg, VERSION);
        await serveMcpOverStdio(mcp);
    }

    const shutdown = async (signal: string) => {
        log.info(`${signal} — shutting down`);
        await holder.close();
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(err => {
    log.error("fatal:", err);
    process.exit(1);
});
