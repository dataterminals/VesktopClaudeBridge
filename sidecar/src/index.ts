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

import { BridgeServer, type Bridge } from "./bridge-server.js";
import { ensureConfigFile, loadConfig } from "./config.js";
import { startHttpApi } from "./http-api.js";
import { log, setLogLevel } from "./log.js";
import { createMcpServer, serveMcpOverStdio } from "./mcp.js";
import { RemoteBridge, describeOwner, findOwner, stopOwner } from "./remote-bridge.js";

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
     * The plugin dials exactly one socket, so exactly one process can own it —
     * but Claude Code and Claude Desktop each spawn their own sidecar. Whoever
     * gets here first owns the Discord connection and serves everyone else;
     * the rest proxy through it rather than dying on the port.
     */
    let bridge: Bridge;
    let owner = false;

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

    if (existing) {
        const remote = new RemoteBridge(cfg);
        await remote.attach();
        bridge = remote;
        log.info(`the bridge on :${cfg.port} is held by ${describeOwner(existing)}; proxying through :${cfg.httpPort}`);
    } else {
        const server = new BridgeServer(cfg, VERSION);
        await server.listen();
        bridge = server;
        owner = true;

        if (cfg.http) startHttpApi(server, cfg);

        server.on("plugin-event", (event: string) => {
            // Marks are pulled, not pushed — MCP has no way to wake the model up.
            // This is just so `--log-level debug` shows you the user clicked.
            log.debug(`plugin event: ${event}`);
        });
    }

    if (args.has("--no-mcp")) {
        /*
         * A proxy with no MCP client has nothing to do: the websocket and the
         * HTTP mirror both belong to whoever got here first, and there is no
         * stdio peer to serve. That is a perfectly good outcome — the bridge is
         * up, just not ours — but exiting 0 in silence reads as a crash to
         * anyone who got here by double-clicking a launcher. Say which it is.
         */
        if (!owner) {
            log.info(`the bridge on :${cfg.port} is already up and being served by ${describeOwner(existing!)}`);
            log.info(
                args.has("--takeover")
                    ? "the takeover did not succeed, so this process is standing down"
                    : "nothing for this process to do — re-run with --takeover to serve it here instead"
            );
            await bridge.close();
            // Distinct from both success and failure: nothing went wrong, but
            // nothing was served either. The launcher branches on this to offer
            // taking over rather than reporting a stop that never started.
            process.exitCode = EXIT_ALREADY_SERVED;
            return;
        }
        log.info("running without MCP (bridge + http only)");
    } else {
        const mcp = createMcpServer(bridge, cfg, VERSION);
        await serveMcpOverStdio(mcp);
    }

    const shutdown = async (signal: string) => {
        log.info(`${signal} — shutting down`);
        await bridge.close();
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(err => {
    log.error("fatal:", err);
    process.exit(1);
});
