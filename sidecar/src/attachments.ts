/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Pulling attachments onto local disk.
 *
 * This exists because "read the logs" usually means a .log file someone dragged
 * into a channel, and Discord CDN urls now carry expiring signatures (`ex`,
 * `is`, `hm`). By the time a url has been copied through a couple of hops it is
 * often already dead, so we resolve it fresh from the client and download it
 * immediately rather than handing the url onward.
 */

import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Config } from "./config.js";
import { BridgeError } from "./bridge-server.js";
import { log } from "./log.js";
import type { BridgeAttachment } from "./protocol.js";

/** Refuse to spend the disk (or the wait) on something enormous. */
const MAX_BYTES = 25 * 1024 * 1024;

const PREVIEW_LINES = 40;
const PREVIEW_MAX_BYTES = 512 * 1024;

export interface FetchedAttachment {
    filename: string;
    path: string;
    bytes: number;
    contentType: string | null;
    /** First few lines, when the file looks like text worth peeking at. */
    preview: string | null;
    previewTruncated: boolean;
}

/** Strips anything that could escape the download directory. */
function safeName(filename: string): string {
    const base = filename.split(/[\\/]/).pop() ?? "attachment";
    const cleaned = base.replace(/[^\w.\-+ ()\[\]]/g, "_").replace(/^\.+/, "");
    return cleaned.slice(0, 120) || "attachment";
}

export async function fetchAttachment(
    cfg: Config,
    attachment: Pick<BridgeAttachment, "filename" | "url" | "size" | "contentType" | "likelyText">,
    messageId: string
): Promise<FetchedAttachment> {
    if (attachment.size > MAX_BYTES) {
        throw new BridgeError({
            code: "bad_params",
            message: `${attachment.filename} is ${attachment.size} bytes, over the ${MAX_BYTES} byte cap`
        });
    }

    await mkdir(cfg.downloadDir, { recursive: true });

    // Message id prefix keeps same-named logs from different people apart.
    const target = join(cfg.downloadDir, `${messageId.slice(-6)}-${safeName(attachment.filename)}`);

    const res = await fetch(attachment.url, { redirect: "follow" });
    if (!res.ok) {
        throw new BridgeError({
            code: "discord_error",
            message:
                res.status === 403 || res.status === 404
                    ? `CDN returned ${res.status} — the signed url has probably expired. Re-read the channel to get a fresh one.`
                    : `CDN returned ${res.status} ${res.statusText}`
        });
    }
    if (!res.body) {
        throw new BridgeError({ code: "internal", message: "CDN response had no body" });
    }

    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(target));

    const written = await stat(target);
    log.info(`saved ${attachment.filename} (${written.size} bytes) -> ${target}`);

    let preview: string | null = null;
    let previewTruncated = false;

    if (attachment.likelyText && written.size <= PREVIEW_MAX_BYTES) {
        try {
            const { readFile } = await import("node:fs/promises");
            const text = await readFile(target, "utf8");
            const lines = text.split(/\r?\n/);
            previewTruncated = lines.length > PREVIEW_LINES;
            preview = lines.slice(0, PREVIEW_LINES).join("\n");
        } catch (err) {
            log.debug("preview failed, not fatal:", err);
        }
    }

    return {
        filename: attachment.filename,
        path: target,
        bytes: written.size,
        contentType: attachment.contentType,
        preview,
        previewTruncated
    };
}
