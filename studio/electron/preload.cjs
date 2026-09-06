const { contextBridge, ipcRenderer, webUtils } = require("electron");

/**
 * Deliberately narrow bridge.
 *
 * The renderer gets exactly the window verbs it needs — no generic send/invoke
 * passthrough, which would let any script in the page reach every IPC channel.
 */
/**
 * Where the packaged app gets its gateway session.
 *
 * A browser bootstraps one by POSTing /api/session, which the gateway answers
 * only for an allowed browser origin. The packaged renderer is a file:// page
 * and Chromium sends it with no Origin header at all, so that bootstrap can
 * never succeed there — which is why chat failed in 1.1.0 and 1.1.1. The main
 * process starts the gateway itself and therefore already holds the token, so
 * it hands it over directly instead. Every other route accepts a header-less
 * caller that presents a valid bearer token, so nothing about the gateway's
 * origin rule has to be relaxed to make this work.
 *
 * Read once, at preload time: `sendSync` is what lets the renderer treat the
 * address as a constant rather than something to await before its first call.
 * In development this is null and the renderer falls back to the POST.
 */
let gatewaySession = null;
try {
  gatewaySession = ipcRenderer.sendSync("gateway:session-sync") ?? null;
} catch {
  gatewaySession = null;
}

/**
 * The anchors the media deny list is written against.
 *
 * Read here for the same reason the gateway session is: the gate consults the
 * policy on the FIRST tool call, and an async read would leave a window in
 * which there is no home directory to judge `~/.ssh` against.
 */
let mediaPaths = null;
try {
  mediaPaths = ipcRenderer.sendSync("media:paths-sync") ?? null;
} catch {
  mediaPaths = null;
}

/**
 * `{ scheme, nonce }` for the file pane's media player. The nonce is minted per
 * launch by electron/workspaceMedia.cjs and lives only here and in main: it is
 * what stops a page framed by the browser pane from spelling the URL itself.
 */
let workspaceMediaOrigin = null;
try {
  workspaceMediaOrigin = ipcRenderer.sendSync("workspace-media:origin-sync") ?? null;
} catch {
  workspaceMediaOrigin = null;
}

/** The bundle the operator has to name in System Settings. See main.cjs. */
let host = null;
try {
  host = ipcRenderer.sendSync("assistant:host-sync") ?? null;
} catch {
  host = null;
}

contextBridge.exposeInMainWorld("teminali", {
  isElectron: true,
  platform: process.platform,
  /** `{ name, isPackaged }` — which app owns this window, or null outside Electron. */
  host,
  /** `{ url, token }` when the main process runs the gateway, else null. */
  gateway: gatewaySession,
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    setProgressBar: (progress) => ipcRenderer.invoke("window:set-progress-bar", progress),
    /** Subscribe to maximize/unmaximize; returns an unsubscribe function. */
    onMaximizeChange: (listener) => {
      const handler = (_event, isMaximized) => listener(Boolean(isMaximized));
      ipcRenderer.on("window:maximize-changed", handler);
      return () => ipcRenderer.removeListener("window:maximize-changed", handler);
    },
  },
  projects: {
    /** Native folder picker. Resolves to an absolute path, or null if cancelled. */
    chooseFolder: () => ipcRenderer.invoke("dialog:open-folder"),
    /** Keeps the File > Open Recent submenu in step with the app. */
    setRecent: (projects) => ipcRenderer.invoke("menu:set-recent-projects", projects),
  },
  menu: {
    /** Menu commands the renderer must act on. Returns an unsubscribe function. */
    on: (channel, listener) => {
      const allowed = new Set([
        "menu:open-project",
        "menu:clear-recent",
        "menu:new-file",
        "menu:save",
        "menu:toggle-terminal",
        "menu:command-palette",
        "menu:open-guardian",
        "menu:record-screen",
        "menu:open-video-project",
        "menu:save-video-project",
        "menu:export-video",
      ]);
      if (!allowed.has(channel)) return () => {};
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
  /**
   * Updates.
   *
   * Two verbs, both narrow. `install` opens a file the gateway downloaded —
   * main checks it really is one before handing it to the OS. `restart` is the
   * "Close and Reopen" the permission reset makes necessary.
   */
  updates: {
    install: (filePath) => ipcRenderer.invoke("updates:install", filePath),
    restart: () => ipcRenderer.invoke("updates:restart"),
    onInstallProgress: (callback) => {
      const listener = (_event, info) => callback(info);
      ipcRenderer.on("updates:install-progress", listener);
      return () => ipcRenderer.removeListener("updates:install-progress", listener);
    },
  },
  /**
   * The screen recorder.
   *
   * Every verb here answers one `recorder:*` handler in screenRecorder.cjs, and
   * the shape of each is the `RecorderBridge` contract in
   * `src/types/recorder.ts`. Without this key `window.teminali.recorder` is
   * undefined, and the renderer's `bridge()` falls through to the browser path
   * that can enumerate neither displays nor windows — which is exactly what a
   * missing bridge looked like from the outside: "Displays (1), Windows (0)".
   *
   * `onCommand` and `onState` are the only two pushes. The bar window is a
   * second renderer with no recorder of its own, so its buttons arrive here as
   * commands and its labels leave as state.
   */
  recorder: {
    sources: (thumbWidth) => ipcRenderer.invoke("recorder:sources", { thumbWidth }),
    permissions: () => ipcRenderer.invoke("recorder:permissions"),
    requestPermission: (kind) => ipcRenderer.invoke("recorder:requestPermission", { kind }),
    resetScreenPermission: () => ipcRenderer.invoke("recorder:resetScreenPermission"),
    relaunch: () => ipcRenderer.invoke("recorder:relaunch"),

    begin: (options) => ipcRenderer.invoke("recorder:begin", options),
    chunk: (sessionId, stream, bytes) =>
      ipcRenderer.invoke("recorder:chunk", { sessionId, stream, bytes }),
    pause: (sessionId, paused) => ipcRenderer.invoke("recorder:pause", { sessionId, paused }),
    finish: (sessionId, copyable) => ipcRenderer.invoke("recorder:finish", { sessionId, copyable }),
    cancel: (sessionId, discard) => ipcRenderer.invoke("recorder:cancel", { sessionId, discard }),

    writeTakeAsset: (dir, name, bytes) =>
      ipcRenderer.invoke("recorder:writeTakeAsset", { dir, name, bytes }),
    readManifest: (dir) => ipcRenderer.invoke("recorder:readManifest", { dir }),
    reveal: (path) => ipcRenderer.invoke("recorder:reveal", { path }),

    publishState: (state) => ipcRenderer.invoke("recorder:publishState", state),
    barCommand: (action) => ipcRenderer.invoke("recorder:barCommand", { action }),

    /** Stop/pause/mark, from the floating bar or a global shortcut. */
    onCommand: (listener) => {
      const handler = (_event, command) => listener(command);
      ipcRenderer.on("recorder:command", handler);
      return () => ipcRenderer.removeListener("recorder:command", handler);
    },
    /** Bar window only: what the main renderer says the take is doing. */
    onState: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("recorder:state", handler);
      return () => ipcRenderer.removeListener("recorder:state", handler);
    },
    /** How far through the remux, while `finish` is still awaiting. */
    onConvert: (listener) => {
      const handler = (_event, progress) => listener(progress);
      ipcRenderer.on("recorder:convert", handler);
      return () => ipcRenderer.removeListener("recorder:convert", handler);
    },
  },

  /**
   * Saving and opening a video project.
   *
   * Every verb here answers one `videoProject:*` handler in videoProjects.cjs,
   * and the typed shape the renderer programs against is `src/types/videoProjects.ts`.
   * Without this key `window.teminali.videoProjects` is undefined and the
   * editor has no save at all — which is exactly how the recorder shipped
   * dead, so `tests/video-project-bridge.test.mjs` reads all three files and
   * asserts they agree.
   *
   * `json` crosses as a STRING in both directions. The renderer owns the
   * format; main writes bytes. Serialising here would put a second copy of
   * the format on the wrong side of the boundary.
   */
  videoProjects: {
    chooseSaveDir: (suggestedName) =>
      ipcRenderer.invoke("videoProject:chooseSaveDir", { suggestedName }),
    chooseOpenDir: () => ipcRenderer.invoke("videoProject:chooseOpenDir"),
    save: (dir, json) => ipcRenderer.invoke("videoProject:save", { dir, json }),
    read: (dir) => ipcRenderer.invoke("videoProject:read", { dir }),
    reveal: (path) => ipcRenderer.invoke("videoProject:reveal", { path }),
    saveAutoSave: (json, dir) =>
      ipcRenderer.invoke("videoProject:saveAutoSave", { json, dir }),
    getAutoSave: () => ipcRenderer.invoke("videoProject:getAutoSave"),
    clearAutoSave: () => ipcRenderer.invoke("videoProject:clearAutoSave"),
  },
  /**
   * The exporter.
   *
   * A session, then one call per frame, then a finish that returns where the
   * file went. The frame bytes cross as a `Uint8Array` in the structured
   * clone — not base64, not a data URL: a 4K JPEG is around a megabyte and
   * base64 would add a third to that on every one of several thousand frames.
   *
   * `cancel` is deliberately fire-and-forget. It is called from a beforeunload
   * and from an abort the operator has already committed to, neither of which
   * has anywhere to put a rejected promise.
   */
  exporter: {
    choose: (suggestedName, codec) => ipcRenderer.invoke("export:choose", suggestedName, codec),
    start: (options) => ipcRenderer.invoke("export:start", options),
    frame: (sessionId, jpeg, frames) => ipcRenderer.invoke("export:frame", sessionId, jpeg, frames),
    materialize: (sessionId, bytes, extension) =>
      ipcRenderer.invoke("export:material", sessionId, bytes, extension),
    finish: (sessionId, audioClips) => ipcRenderer.invoke("export:finish", sessionId, audioClips),
    cancel: (sessionId) => ipcRenderer.invoke("export:cancel", sessionId),
  },
  /**
   * The video panel's MCP bridge.
   *
   * Four verbs and no passthrough: main pushes a tool call in, the renderer
   * pushes one answer back. Nothing here lets the page choose a channel, and
   * nothing lets it read main's state — the reason it exists at all is that an
   * agent CLI in another process cannot reach the timeline stores in this one.
   */
  videoBridge: {
    onListTools: (listener) => {
      ipcRenderer.on("video-bridge:list-tools", (_event, message) => listener(message?.id));
    },
    onCallTool: (listener) => {
      ipcRenderer.on("video-bridge:call-tool", (_event, message) => {
        listener(message?.id, message?.payload?.name, message?.payload?.args ?? {});
      });
    },
    respond: (payload) => ipcRenderer.send("video-bridge:response", payload),
    /** Announces that the two listeners above are installed. */
    ready: () => ipcRenderer.send("video-bridge:ready"),
  },
  /**
   * Media: the approval gate's window on the filesystem.
   *
   * Four verbs, none of which reads or writes a file the renderer names
   * freely. `getPathForFile` exists because `File.path` was removed from
   * Electron and a blob URL is not a path — without it there is no absolute
   * path for a human gesture to grant consent from, which is the gate's own
   * foundation. `ffmpeg` takes named options and a filter string, never argv.
   */
  media: {
    /** `{ home, userData }` — what the deny list is anchored to. */
    paths: mediaPaths,
    /**
     * The absolute path behind a dropped or picked `File`.
     *
     * `File.path` is gone in Electron 44 (and in the Cut's 34), and the old
     * fallback — `URL.createObjectURL(file)` — previews but is not a path, so
     * ffmpeg and export cannot use it and it dies on reload.
     */
    getPathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || null;
      } catch {
        return null;
      }
    },
    /** `..` collapsed and symlinks followed, in a process that has `fs`. */
    resolvePath: (requested) => ipcRenderer.invoke("media:resolve-path", requested),
    /** One line per decision, in main's log. */
    audit: (entry) => ipcRenderer.send("media:audit", entry),
    ffmpeg: (options) => ipcRenderer.invoke("media:ffmpeg", options),
  },
  /**
   * The file pane's video and audio, streamed by main over `teminali-media://`
   * with HTTP Range — a `<video>` cannot carry the gateway's bearer token, so
   * it cannot load from a gateway URL. See electron/workspaceMedia.cjs.
   */
  workspaceMedia: {
    /** A playable URL for a workspace-relative path whose segments are already percent-encoded. */
    url: (encodedPath) =>
      workspaceMediaOrigin ? `${workspaceMediaOrigin.scheme}://${workspaceMediaOrigin.nonce}/${encodedPath}` : null,
    /**
     * The same file through ffmpeg, for a container or codec Chromium cannot
     * play as it is. There is no file behind this URL, so there is nothing to
     * seek in: a seek is a new stream, which is what `start` (in seconds) is
     * for. The pane asks the gateway for the plan before it uses this.
     */
    transcodeUrl: (encodedPath, start = 0) =>
      workspaceMediaOrigin
        ? `${workspaceMediaOrigin.scheme}://${workspaceMediaOrigin.nonce}/${encodedPath}?transcode=1&start=${Math.max(0, Math.floor(Number(start) || 0))}`
        : null,
    /**
     * Tells main which project is open, and does not return until it knows.
     *
     * Synchronous on purpose: the very next thing the pane does is point a
     * `<video>` at the protocol, and a media request does not travel the IPC
     * pipe — it goes through Chromium's loader, so an asynchronous `send` is
     * not ordered against it and the element can reach main first, before the
     * root it needs. Blocking the renderer for one hop is cheaper than a video
     * that is dead until the file is reopened. A packaged app ignores the root
     * and reads its own gateway's, but still answers.
     *
     * @returns whether main accepted it as an existing directory.
     */
    announceRoot: (root) => ipcRenderer.sendSync("workspace-media:root", root) === true,
  },
  /**
   * The browser panel's page, which is not in this document at all.
   *
   * It is a `WebContentsView` — a separate web contents with its own session,
   * layered over the window by main — so the pane's job here is to say where
   * it is and when it may be seen, and to ask for navigation rather than to
   * perform it. See electron/browserView.cjs for why it is not an iframe.
   */
  browserView: {
    /**
     * Load an http(s) address into the view for this panel, creating it on
     * first use. `options.private` is read only when a view has to be made:
     * which session a tab is on is settled when it opens, never later.
     */
    navigate: (id, url, options) => ipcRenderer.invoke("browser-view:navigate", id, url, options),
    /** The view for this panel, at `url` if it has to be made — an existing one is left where it is. */
    ensure: (id, url, options) => ipcRenderer.invoke("browser-view:ensure", id, url, options),
    /** Where the viewport is, in CSS pixels of this document, and whether it may be drawn. */
    setBounds: (id, bounds, visible) => ipcRenderer.send("browser-view:bounds", id, bounds, visible),
    /** "back" | "forward" | "reload" | "stop" — the page's own history, not one we keep. */
    command: (id, command) => ipcRenderer.send("browser-view:command", id, command),
    /** The panel is closed for good. */
    destroy: (id) => ipcRenderer.send("browser-view:destroy", id),
    /** Every view, for a document that is about to be replaced. */
    destroyAll: () => ipcRenderer.send("browser-view:destroy-all"),
    /** Navigation state for the toolbar: url, title, loading, canGoBack/Forward, or an error. */
    onState: (handler) => {
      const listener = (_event, state) => handler(state);
      ipcRenderer.on("browser-view:state", listener);
      return () => ipcRenderer.removeListener("browser-view:state", listener);
    },
    /**
     * A file arriving, byte by byte.
     *
     * Progress is IPC and stops here: only the end of a download is written to
     * the gateway, because a large file updates several thousand times and a
     * POST per tick would be a store that spent its life being rewritten.
     */
    onDownload: (handler) => {
      const listener = (_event, download) => handler(download);
      ipcRenderer.on("browser-view:download", listener);
      return () => ipcRenderer.removeListener("browser-view:download", listener);
    },
    /**
     * Show a finished download in the Finder.
     *
     * Reveal, never open — the file came from a page. Main answers false for
     * any path it did not itself watch the save dialog write, so this is not a
     * way to ask whether an arbitrary path exists.
     */
    revealDownload: (filePath) => ipcRenderer.invoke("browser-view:reveal-download", filePath),
    /** Hand an http(s) address to the operator's real browser. */
    openExternal: (url) => ipcRenderer.invoke("browser-view:open-external", url),
    /**
     * Which engine "Search … for" means in the right-click menu.
     *
     * The preference lives in the renderer and the menu is built in main, so
     * it is published rather than read. Main validates it.
     */
    setSearchEngine: (engine) => ipcRenderer.send("browser-view:search-engine", engine),
  },
  /**
   * The screen assistant.
   *
   * Two directions and nothing else. Commands come *in* from the global
   * shortcut and the menu bar item; settings and overlay state go *out* so the
   * menu bar item and the drawing layer can reflect what the renderer decided.
   * There is deliberately no verb here that moves the pointer: that is the
   * gateway's job, behind a check that the element being aimed at was actually
   * observed, and a bridge that could bypass it would make that check optional.
   */
  assistant: {
    /** Hotkey, tray, or double-click. Returns an unsubscribe function. */
    onCommand: (listener) => {
      const handler = (_event, payload) => listener(payload ?? {});
      ipcRenderer.on("assistant:command", handler);
      return () => ipcRenderer.removeListener("assistant:command", handler);
    },
    /** Mirror the settings into the menu bar item. */
    setState: (state) => ipcRenderer.invoke("assistant:set-state", state),
    setHotkey: (accelerator) => ipcRenderer.invoke("assistant:set-hotkey", accelerator),
    hotkeyStatus: () => ipcRenderer.invoke("assistant:hotkey-status"),
    showOverlay: (state) => ipcRenderer.invoke("assistant:show-overlay", state),
    hideOverlay: () => ipcRenderer.invoke("assistant:hide-overlay"),
    /** Overlay window only: the current drawing, pulled on mount. */
    overlayState: () => ipcRenderer.invoke("assistant:overlay-state"),
    revealForScreenRecording: () => ipcRenderer.invoke("assistant:reveal-for-screen-recording"),
    focusStudio: () => ipcRenderer.invoke("assistant:focus-studio"),
    setOverlayInteractive: (interactive) => ipcRenderer.invoke("assistant:overlay-interactive", interactive),
    /** Overlay window only: what to draw. Returns an unsubscribe function. */
    onOverlay: (listener) => {
      const handler = (_event, state) => listener(state ?? { visible: false });
      ipcRenderer.on("assistant:overlay-state", handler);
      return () => ipcRenderer.removeListener("assistant:overlay-state", handler);
    },
    /** Where the real mouse is, ~60fps, only while the overlay is drawn. */
    onOverlayCursor: (fn) => {
      const handler = (_event, point) => fn(point);
      ipcRenderer.on("assistant:overlay-cursor", handler);
      return () => ipcRenderer.removeListener("assistant:overlay-cursor", handler);
    },
  },
});
