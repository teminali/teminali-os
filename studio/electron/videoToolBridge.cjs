/* ─────────────────────────────────────────────────────────────────────────────
   Tool bridge — main's half.

   The video panel's editing tools act on Zustand stores, and those stores live
   in the RENDERER. Anything outside that process — the Claude Code CLI, the
   Codex CLI, anything else speaking MCP — therefore cannot call them: it has to
   ask the window to.

   This is the asking. Main keeps a table of in-flight requests, pushes each one
   to the renderer over IPC, and resolves it when the renderer answers. Without
   it an external agent would run the tools against its own fresh, empty store
   and edit a project nobody can see, reporting success the whole way.

   Ported from teminaliCut/electron/toolBridge.ts, which learned all of the
   above the hard way. The Cut's window capture and `debugEval` did not come
   across: they belong to that app's verification apparatus, not to this bridge.
   ───────────────────────────────────────────────────────────────────────────── */

const { ipcMain } = require("electron");

/** id → { resolve, reject, timer }. One entry per call awaiting an answer. */
const pending = new Map();
let seq = 0;
let targetWindow = null;

/**
 * True once the renderer has told us its handlers are installed.
 *
 * Without this a call placed before the page finished booting would sit in
 * `pending` until it timed out, and the operator would read "timed out waiting
 * for the editor" when the honest answer is "the window is still loading".
 * Cleared whenever the page goes away, because a reload takes the listeners
 * with it and the renderer re-announces itself on the way back up.
 */
let rendererReady = false;

/**
 * How long one tool may take before the caller is answered anyway.
 *
 * This is the default for the tools that do not have an entry below: reads of,
 * and synchronous writes to, an in-memory store. They finish in single-digit
 * milliseconds, so a wait this long means the renderer has wedged, not that the
 * work is slow. The Cut runs 60s because its surface includes transcription and
 * export, which load models and render frames; P3's two gated tools are the
 * first arrivals here that needed their own entries, because a per-tool timeout
 * is not inherited by a tool that got slower.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

const SLOW_TOOLS = Object.freeze({
  /*
    P3's two gated tools, and the entries the comment above predicted.

    Neither number is about how long the WORK takes. Both are about the
    human: the call blocks while the approval prompt is on screen, and the
    gate gives the operator 90 seconds (`CONSENT_DEADLINE_MS` in
    `src/services/mediaConsent.ts`) before it settles as "nobody answered".
    A 20s bridge timeout would answer the caller with "the editor wedged"
    while the operator was still reading the question — so each entry is
    that deadline plus room for the work that follows it.

    ffmpeg's own `execFile` timeout is 15 minutes (`mediaAccess.cjs`), and a
    gate deadline is not a work deadline: 16 minutes is the sum, so the
    bridge is never the thing that gives up first.
  */
  import_media_from_path: 120_000,
  ffmpeg_process: 16 * 60_000,
});

function setBridgeWindow(window) {
  targetWindow = window;
  rendererReady = false;

  if (!window) return;
  // A reload replaces the renderer's listeners, so readiness has to be
  // re-earned rather than assumed to survive the navigation.
  window.webContents?.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) rendererReady = false;
  });
}

function initVideoToolBridge() {
  ipcMain.on("video-bridge:ready", (event) => {
    // Only the window we are bridging to. A second BrowserWindow pointed at the
    // same bundle (the assistant overlay is one) must not mark the bridge ready
    // on behalf of a page that is not serving it.
    if (targetWindow && !targetWindow.isDestroyed() && event.sender === targetWindow.webContents) {
      rendererReady = true;
    }
  });

  ipcMain.on("video-bridge:response", (_event, payload) => {
    const entry = pending.get(payload?.id);
    if (!entry) return; // already timed out — its rejection has been delivered
    pending.delete(payload.id);
    clearTimeout(entry.timer);

    if (payload.ok) entry.resolve(payload.data);
    else entry.reject(new Error(payload.error || "The editor tool failed"));
  });
}

/** Ask the renderer to do something, and wait for its reply. */
function ask(channel, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!targetWindow || targetWindow.isDestroyed()) {
      reject(new Error("Teminali OS is not running — open the app and try again."));
      return;
    }
    if (!rendererReady) {
      reject(new Error("The Teminali OS window is still loading. Try again in a moment."));
      return;
    }

    const id = `vreq_${++seq}_${process.pid}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the editor.`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });
    targetWindow.webContents.send(channel, { id, payload });
  });
}

/**
 * What the RPC server is allowed to ask for.
 *
 * The manifest is read from the live registry on every call rather than cached
 * here, so a curated surface that changes in the renderer cannot be advertised
 * from a stale copy in main.
 */
const videoBridge = {
  listTools: () => ask("video-bridge:list-tools", {}),
  callTool: (name, args) =>
    ask("video-bridge:call-tool", { name, args }, SLOW_TOOLS[name] || DEFAULT_TIMEOUT_MS),
  isReady: () => Boolean(targetWindow && !targetWindow.isDestroyed() && rendererReady),
};

module.exports = { initVideoToolBridge, setBridgeWindow, videoBridge };
