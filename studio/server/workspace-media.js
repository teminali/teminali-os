import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

import { isStreamableWorkspaceFile, resolveWorkspacePath, workspaceMimeType } from "./workspace.js";

/**
 * Video and audio, served as bytes with HTTP Range — the half of the workspace
 * reader that a JSON API cannot be.
 *
 * `readWorkspaceFile` returns a file as one JSON document under an 8 MB cap.
 * A media file is neither small nor read once: Chromium's `<video>` asks for
 * `bytes=0-` first, and every seek is a fresh request for a byte range. So
 * this module speaks the two-line protocol the element expects — 206 with a
 * `Content-Range` for a satisfiable range, 416 for one past the end, 200 for
 * no range at all — and streams from disk instead of buffering.
 *
 * It is a pure function of (root, path, request) so it can be tested under
 * node; `electron/workspaceMedia.cjs` wraps the answer in a `Response` for the
 * `teminali-media://` protocol handler. It does NOT know about the gateway's
 * bearer token, which is the whole point: a `<video src>` cannot carry a
 * bearer header, and putting the token in a query string would leave it in
 * every log the URL passes through. The guard that matters is the same one
 * the JSON reader uses — `resolveWorkspacePath` — and the same lstat refusal
 * of symlinks and folders, so the media route cannot reach a byte the reader
 * could not.
 */

/**
 * One satisfiable `Range: bytes=…` header, or the reason there is none.
 *
 * Accepts the three single-range forms — `bytes=a-b`, `bytes=a-`, `bytes=-n`
 * — and treats anything else (a multi-range, another unit, garbage) as no
 * range, which the spec allows and which Chromium never sends for media. Only
 * a range whose start is past the end is unsatisfiable; an end past the end
 * is clamped, as the spec says.
 */
export function parseByteRange(header, size) {
  if (typeof header !== "string") return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "none" };
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return { kind: "none" };

  if (startText === "") {
    // `bytes=-n`: the last n bytes.
    const suffix = Number(endText);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, size - suffix);
    return { kind: "range", start, end: size - 1 };
  }

  const start = Number(startText);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (end < start) return { kind: "unsatisfiable" };
  return { kind: "range", start, end };
}

const NO_STORE = { "Cache-Control": "no-store", "Accept-Ranges": "bytes" };

/**
 * The answer to one request for a media file.
 *
 * @returns {Promise<{status:number, headers:Record<string,string>, stream?:import("node:stream").Readable, reason?:string}>}
 *   `stream` is present on a 200/206 GET; a HEAD gets the same headers and no
 *   stream. Every refusal carries a `reason` code in the vocabulary of
 *   `server/workspace.js`.
 */
export async function resolveMediaPath(root, requestedPath) {
  if (typeof root !== "string" || root === "") {
    return { ok: false, status: 503, reason: "WORKSPACE_ROOT_UNKNOWN" };
  }

  let absolutePath;
  try {
    absolutePath = resolveWorkspacePath(root, requestedPath);
  } catch {
    // An escape and a malformed path get the same answer as a missing file:
    // the protocol is reachable by any page the renderer frames, and "that
    // exists but you may not" is a fact worth withholding.
    return { ok: false, status: 404, reason: "WORKSPACE_PATH_NOT_FOUND" };
  }

  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch {
    return { ok: false, status: 404, reason: "WORKSPACE_PATH_NOT_FOUND" };
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { ok: false, status: 404, reason: "WORKSPACE_FILE_REQUIRED" };
  }
  if (!isStreamableWorkspaceFile(absolutePath)) {
    // Text, pictures and PDFs have a reader already; this route serves only
    // what that reader refuses, so the two can never disagree about a file.
    return { ok: false, status: 415, reason: "WORKSPACE_FILE_UNSUPPORTED" };
  }
  return { ok: true, path: absolutePath, size: stats.size };
}

export async function openWorkspaceMedia(root, requestedPath, request = {}) {
  const { range = null, method = "GET" } = request;

  const resolved = await resolveMediaPath(root, requestedPath);
  if (!resolved.ok) return { status: resolved.status, headers: {}, reason: resolved.reason };
  const absolutePath = resolved.path;
  const stats = { size: resolved.size };

  const contentType = workspaceMimeType(absolutePath) || "application/octet-stream";
  const parsed = parseByteRange(range, stats.size);

  if (parsed.kind === "unsatisfiable") {
    return {
      status: 416,
      headers: { ...NO_STORE, "Content-Range": `bytes */${stats.size}` },
      reason: "RANGE_NOT_SATISFIABLE",
    };
  }

  const start = parsed.kind === "range" ? parsed.start : 0;
  const end = parsed.kind === "range" ? parsed.end : stats.size - 1;
  const headers = {
    ...NO_STORE,
    "Content-Type": contentType,
    "Content-Length": String(stats.size === 0 ? 0 : end - start + 1),
  };
  if (parsed.kind === "range") headers["Content-Range"] = `bytes ${start}-${end}/${stats.size}`;

  const status = parsed.kind === "range" ? 206 : 200;
  if (method === "HEAD") return { status, headers };
  const stream = stats.size === 0 ? createReadStream(absolutePath) : createReadStream(absolutePath, { start, end });
  return { status, headers, stream };
}
