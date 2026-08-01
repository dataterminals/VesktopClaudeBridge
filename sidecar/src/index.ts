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

import { BridgeServer } from "./bridge-server.js";
import { ensureConfigFile, loadConfig } from "./config.js";
import { startHttpApi } from "./http-api.js";
import { log, setLogLevel } from "./log.js";
import { createMcpServer, serveMcpOverStdio } from "./mcp.js";

const VERSION = "0.1.0";

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

    const bridge = new BridgeServer(cfg, VERSION);
    await bridge.listen();

    if (cfg.http) startHttpApi(bridge, cfg);

    bridge.on("plugin-event", (event: string) => {
        // Marks are pulled, not pushed — MCP has no way to wake the model up.
        // This is just so `--log-level debug` shows you the user clicked.
        log.debug(`plugin event: ${event}`);
    });

    if (args.has("--no-mcp")) {
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
