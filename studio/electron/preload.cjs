const { contextBridge, ipcRenderer } = require("electron");

/**
 * Deliberately narrow bridge.
 *
 * The renderer gets exactly the window verbs it needs — no generic send/invoke
 * passthrough, which would let any script in the page reach every IPC channel.
 */
contextBridge.exposeInMainWorld("teminali", {
  isElectron: true,
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
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
    /** Overlay window only: what to draw. Returns an unsubscribe function. */
    onOverlay: (listener) => {
      const handler = (_event, state) => listener(state ?? { visible: false });
      ipcRenderer.on("assistant:overlay-state", handler);
      return () => ipcRenderer.removeListener("assistant:overlay-state", handler);
    },
  },
});
