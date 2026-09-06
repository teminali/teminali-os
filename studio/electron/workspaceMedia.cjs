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
  can play a 200 but cannot seek in one. This file only wraps that answer in a
  `Response` and finds the root: the in-process gateway's when the app is
  packaged, else the one the renderer announced (validated as an existing
  directory; see `syncWorkspaceMediaRoot` in src/services/workspaceMedia.ts).
*/
const { protocol, ipcMain } = require("electron");
const { randomBytes } = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const WORKSPACE_MEDIA_SCHEME = "teminali-media";
const nonce = randomBytes(16).toString("hex");

let announcedRoot = null;
let mediaModule = null;

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

module.exports = { WORKSPACE_MEDIA_SCHEME, registerWorkspaceMediaScheme, initWorkspaceMedia };
