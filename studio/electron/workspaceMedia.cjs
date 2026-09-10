/*
  The media protocol: `teminali-media://<nonce>/<workspace-relative path>`.

  Why a protocol and not a gateway URL: every workspace route sits behind the
  gateway's bearer gate (server/gateway.js), and a `<video src>` cannot carry a
  bearer header. The only way to feed a media element from the gateway would
  be the token in a query string, which is the token in every log line. So the
  element loads from a scheme this process owns, and the process — which
  already holds the gateway when packaged — answers from disk directly.

  Why a nonce in the host: the renderer's pages are not only ours. The browser
  pane frames arbitrary sites, and the window runs with `webSecurity: false`,
  so a scheme any page could spell would be a scheme any page could read. The
  nonce is minted per launch and handed only to the preload bridge, which only
  the main frame has. `supportFetchAPI: false` closes the other door: nothing
  can `fetch()` this scheme, our own code included; only media elements load
  it, which is all the pane needs.

  What it serves is decided in server/workspace-media.js, under the same path
  guard and symlink refusal as the JSON reader, with HTTP Range — a `<video>`
  can play a 200 but cannot seek in one. This file wraps that answer in a
  `Response` and finds the root: the in-process gateway's when the app is
  packaged, else the one the renderer announced (validated as an existing
  directory; see `syncWorkspaceMediaRoot` in src/services/workspaceMedia.ts).

  ## The second answer: a live transcode

  Chromium demuxes a handful of containers and decodes a handful of codecs,
  and the workspace lists many more — a `.mkv` holding HEVC, an `.avi`, a
  ProRes `.mov`. Those used to reach the pane as a sentence naming the codec.
  A `?transcode=1` on the URL is the other answer: ffmpeg reads the file and
  writes fragmented MP4 to a pipe, and that pipe is the response body. It is a
  200 with no `Content-Length` and `Accept-Ranges: none`, because there is no
  file to seek in — so seeking is a *new request* at `&start=<seconds>`, which
  is why the pane drives a virtual timeline over `HTMLMediaElement.currentTime`
  rather than letting the element scrub. `server/media-probe.js` decides
  whether a file needs this at all and builds the argument list; this file
  spawns it, and kills the child the moment the element hangs up — a seek in a
  two-hour film would otherwise leave an encoder running for the rest of it.
*/
const { protocol, ipcMain } = require("electron");
const { randomBytes } = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { encoderLine } = require("./encoderProbe.cjs");

const WORKSPACE_MEDIA_SCHEME = "teminali-media";
const nonce = randomBytes(16).toString("hex");

let announcedRoot = null;
let mediaModule = null;
let probeModule = null;

/**
 * The ffmpeg children this process has running, so a window that goes away
 * does not leave encoders behind. Keyed by an id per request.
 */
const encoders = new Map();
let encoderId = 0;

/** Kill every running transcode. Called when the app quits. */
function stopWorkspaceTranscodes() {
  for (const child of encoders.values()) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  encoders.clear();
}

/** Before `app.ready`, or Electron refuses the privileges. */
function registerWorkspaceMediaScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WORKSPACE_MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: false, corsEnabled: false },
    },
  ]);
}

/**
 * After `app.ready`. `getGatewayRoot` returns the live root of an in-process
 * gateway, or null when there is none; `isMainWindow(sender)` says whether an
 * announcement came from the window that may make one.
 */
function initWorkspaceMedia({ getGatewayRoot, isMainWindow, log }) {
  ipcMain.on("workspace-media:origin-sync", (event) => {
    event.returnValue = { scheme: WORKSPACE_MEDIA_SCHEME, nonce };
  });

  // Answered synchronously: the renderer waits for this before it points a
  // media element at the protocol, so that the element cannot arrive first and
  // be served from the previous root — or from none. Every path must set
  // `returnValue`; a `sendSync` with no answer hangs the renderer for good.
  ipcMain.on("workspace-media:root", (event, root) => {
    event.returnValue = false;
    if (!isMainWindow(event.sender)) return;
    if (typeof root !== "string" || !path.isAbsolute(root)) return;
    let stats;
    try {
      stats = fs.statSync(root);
    } catch {
      return;
    }
    if (!stats.isDirectory()) return;
    announcedRoot = root;
    event.returnValue = true;
  });

  protocol.handle(WORKSPACE_MEDIA_SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (url.host !== nonce) return new Response(null, { status: 404 });

    let relativePath;
    try {
      relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    } catch {
      return new Response(null, { status: 400 });
    }

    /*
      A transcode is asked for by the pane, never guessed at here: the pane has
      already asked the gateway what the file holds and what the plan is, so
      this process spawns ffmpeg only when the answer was "it cannot be played
      as it is". `start` is where the new stream begins, which is what a seek
      in a transcoded file means.
    */
    if (url.searchParams.get("transcode") === "1") {
      return transcode({
        root: getGatewayRoot() ?? announcedRoot,
        relativePath,
        start: Number(url.searchParams.get("start")) || 0,
        method: request.method,
        signal: request.signal,
        request,
        log,
      });
    }

    try {
      mediaModule ??= import(require("url").pathToFileURL(path.join(__dirname, "..", "server", "workspace-media.js")).href);
      const { openWorkspaceMedia } = await mediaModule;
      const answer = await openWorkspaceMedia(getGatewayRoot() ?? announcedRoot, relativePath, {
        range: request.headers.get("range"),
        method: request.method,
      });
      if (answer.status >= 400) log(`Media ${answer.status} ${answer.reason}: ${relativePath}`);
      return new Response(answer.stream ? Readable.toWeb(answer.stream) : null, {
        status: answer.status,
        headers: answer.headers,
      });
    } catch (error) {
      log("Media protocol failed:", error?.stack || error?.message || error);
      return new Response(null, { status: 500 });
    }
  });
}

/**
 * One live transcode, as a `Response` whose body is ffmpeg's stdout.
 *
 * The path is resolved by the same guard the byte route uses — imported from
 * `server/workspace-media.js` rather than reimplemented, so there is exactly
 * one answer to "may this path be read". The child is killed on abort, on
 * end, and on error; `encoders` holds it in the meantime so quitting the app
 * does not orphan it.
 */
async function transcode({ root, relativePath, start, method, signal, request, log }) {
  let resolved;
  try {
    mediaModule ??= import(require("url").pathToFileURL(path.join(__dirname, "..", "server", "workspace-media.js")).href);
    probeModule ??= import(require("url").pathToFileURL(path.join(__dirname, "..", "server", "media-probe.js")).href);
    const { resolveMediaPath } = await mediaModule;
    // Awaited: it is async, and an unawaited promise has no `ok`, so every
    // transcode answered 200 with an empty body and the pane said the stream
    // stopped. `status` must be a number here — `{ status: undefined }` is a
    // 200, which is how that failure stayed silent.
    resolved = await resolveMediaPath(root, relativePath);
  } catch (error) {
    log(`Media transcode refused: ${error?.message || error}`);
    return new Response(null, { status: 404 });
  }
  if (!resolved.ok) {
    log(`Media transcode ${resolved.status} ${resolved.reason}: ${relativePath}`);
    return new Response(null, { status: resolved.status });
  }

  const { mediaTools, playbackPlan, probeMedia, transcodeArgs, transcodeHeaders } = await probeModule;
  const tools = await mediaTools();
  if (!tools.ffmpeg) return new Response(null, { status: 503 });
  const probe = await probeMedia(resolved.path, tools);
  const plan = playbackPlan(probe, { ffmpeg: tools.ffmpeg, path: resolved.path });
  if (plan.mode === "unplayable") return new Response(null, { status: 415 });
  /*
    The pane decides this, and it decides it from the same plan — but a stale
    URL (a file replaced under the same name, a panel restored from a session
    where ffprobe was missing) can still arrive here asking to transcode
    something that plays as it is. `transcodeArgs` on a direct plan copies
    nothing and would answer with an empty stream, so the request goes to the
    byte route instead: a 302 the element follows, and it gets ranges back.
  */
  if (plan.mode === "direct") {
    const target = new URL(request.url);
    target.search = "";
    return Response.redirect(target.toString(), 302);
  }

  const headers = transcodeHeaders(plan);
  if (method === "HEAD") return new Response(null, { status: 200, headers });

  const { spawn } = require("child_process");
  /*
    `transcodeArgs` is pure and deliberately knows no encoder names, so the
    line comes from here — probed against the ffmpeg that will actually run it.
    Software, which is what this path has always used: a playback transcode
    that changes character with the GPU is a support case nobody can reproduce.
  */
  const line = plan.video === null || plan.video === "copy"
    ? null
    : encoderLine({
        codec: "h264", ff: tools.ffmpeg, allowHardware: false,
        crf: 23, speed: "veryfast", profile: "high", gop: 48,
      });
  if (plan.video !== null && plan.video !== "copy" && !line) {
    return new Response(null, { status: 503 });
  }
  const args = transcodeArgs({ input: resolved.path, start, plan, videoArgs: line?.args ?? null });
  const child = spawn(tools.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const id = ++encoderId;
  encoders.set(id, child);

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    // Bounded: an encoder that fails per frame would otherwise grow this
    // without limit for as long as it runs.
    if (stderr.length < 4096) stderr += String(chunk);
  });
  const finish = () => {
    encoders.delete(id);
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  child.on("close", (code) => {
    encoders.delete(id);
    if (code !== 0 && code !== null) log(`Media transcode exited ${code}: ${stderr.trim().slice(0, 300)}`);
  });
  child.on("error", (error) => {
    finish();
    log(`Media transcode failed to start: ${error?.message || error}`);
  });
  // The element hanging up — a seek, a closed pane, another episode — must
  // take the encoder with it, or a two-hour film keeps encoding unwatched.
  signal?.addEventListener?.("abort", finish, { once: true });

  log(`Media transcode (${plan.mode}${start > 0 ? `, from ${Math.round(start)}s` : ""}): ${relativePath}`);
  return new Response(Readable.toWeb(child.stdout), { status: 200, headers });
}

module.exports = { WORKSPACE_MEDIA_SCHEME, registerWorkspaceMediaScheme, initWorkspaceMedia, stopWorkspaceTranscodes };
