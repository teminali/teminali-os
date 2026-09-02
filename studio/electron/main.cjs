const { app, BrowserWindow, Menu, dialog, globalShortcut, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { attachGuardianTray } = require("./tray.cjs");
const { attachAssistantTray } = require("./assistant-tray.cjs");
const { attachAssistantOverlay } = require("./assistant-overlay.cjs");

const logFile = path.join(app.getPath("userData"), "studio-main.log");
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch (e) {}
  console.log(...args);
}

log("Teminali Code main process starting...");
log("App path:", app.getAppPath());
log("UserData path:", app.getPath("userData"));
log("IsPackaged:", app.isPackaged);

let mainWindow = null;

function createWindow() {
  log("Creating BrowserWindow...");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    // Frameless: the app draws its own window controls, so macOS must not also
    // render native traffic lights. "hiddenInset" keeps them; only frame:false
    // removes them entirely.
    frame: false,
    backgroundColor: "#08090E",
    title: "Teminali Code",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.once("ready-to-show", () => {
    log("Window ready to show, displaying mainWindow");
    mainWindow.show();
  });

  const indexPath = path.join(__dirname, "../dist/index.html");
  log("Computed indexPath:", indexPath, "exists:", fs.existsSync(indexPath));

  if (!app.isPackaged && process.env.ELECTRON_DEV) {
    log("Loading DEV URL http://localhost:3000");
    mainWindow.loadURL("http://localhost:3000").catch((err) => {
      log("Failed to load dev URL, falling back to file:", err.message);
      mainWindow.loadFile(indexPath);
    });
  } else {
    log("Loading production file:", indexPath);
    mainWindow.loadFile(indexPath).catch((err) => {
      log("Failed to load dist/index.html:", err.message);
      mainWindow.loadURL("http://localhost:3000").catch(() => {});
    });
  }

  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    log("did-fail-load:", errorCode, errorDescription);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    log("MainWindow closed");
    mainWindow = null;
  });

  // Keep the renderer's maximize/restore icon truthful even when the window is
  // resized by a gesture rather than by our own button.
  const broadcastMaximize = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window:maximize-changed", mainWindow.isMaximized());
    }
  };
  mainWindow.on("maximize", broadcastMaximize);
  mainWindow.on("unmaximize", broadcastMaximize);
  mainWindow.on("enter-full-screen", broadcastMaximize);
  mainWindow.on("leave-full-screen", broadcastMaximize);
}

/* ── Screen assistant ───────────────────────────────────────────────────────
   The assistant has three doors — a global shortcut, its own menu bar item,
   and the microphone in the composer — and all three end at the same place:
   an "assistant:command" message to the renderer, which owns the one session.
   The main process holds no assistant state of its own beyond the shortcut it
   registered, because two places holding the same state is two places that can
   disagree about what mode you are in.
   ────────────────────────────────────────────────────────────────────────── */

let assistantTray = null;
let assistantOverlay = null;
const DEFAULT_ASSISTANT_HOTKEY = "CommandOrControl+Shift+Space";
let assistantHotkey = { accelerator: DEFAULT_ASSISTANT_HOTKEY, registered: false, reason: null };

function activateAssistant() {
  let window = mainWindow;
  if (!window || window.isDestroyed()) {
    createWindow();
    window = mainWindow;
  }
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send("assistant:command", { activate: true });
}

/**
 * Registers the global shortcut, and reports honestly when it could not.
 *
 * Electron's register() returns false when another application already owns the
 * combination, and a shortcut that silently does nothing is the worst outcome
 * available here — the operator presses it, nothing happens, and there is
 * nowhere to find out why. The result is kept so the tray can say so.
 */
function registerAssistantHotkey(accelerator) {
  const next = typeof accelerator === "string" && accelerator.trim() ? accelerator.trim() : DEFAULT_ASSISTANT_HOTKEY;
  try {
    globalShortcut.unregisterAll();
  } catch (error) {
    log("Could not clear global shortcuts:", error.message);
  }
  let registered = false;
  let reason = null;
  try {
    registered = globalShortcut.register(next, activateAssistant);
    if (!registered) reason = "Another application already uses that shortcut.";
  } catch (error) {
    reason = error.message;
  }
  assistantHotkey = { accelerator: next, registered, reason };
  log("Assistant hotkey", next, registered ? "registered" : `not registered: ${reason}`);
  assistantTray?.rebuild();
  return assistantHotkey;
}

// The renderer owns the settings and mirrors them here so the menu bar item can
// show them; nothing in the main process reads them to make a decision.
ipcMain.handle("assistant:set-state", (_event, state) => {
  assistantTray?.setState(state && typeof state === "object" ? state : {});
  return true;
});

ipcMain.handle("assistant:set-hotkey", (_event, accelerator) => registerAssistantHotkey(accelerator));

ipcMain.handle("assistant:hotkey-status", () => assistantHotkey);

ipcMain.handle("assistant:show-overlay", (_event, state) => {
  if (!assistantOverlay || !state || typeof state !== "object") return false;
  assistantOverlay.show(state);
  return true;
});

ipcMain.handle("assistant:hide-overlay", () => {
  assistantOverlay?.hide();
  return true;
});

// The overlay page asks for the current drawing when it mounts. A push alone
// races the first paint: the state is sent the moment the window is created,
// which is before React has subscribed to anything.
ipcMain.handle("assistant:overlay-state", () => assistantOverlay?.getState() ?? { visible: false });

/* ── Updates ────────────────────────────────────────────────────────────────
   This build is ad-hoc signed, so an update is a whole new .dmg / .exe /
   .AppImage rather than an in-place patch — Squirrel will not apply an update
   to a binary it cannot verify, and no amount of wiring changes that.

   The consequence handled here is the restart. Each ad-hoc build carries a
   different signature, and macOS keys Screen Recording, Accessibility and
   Microphone to the signature; after an update the system therefore treats this
   as a different application and the grants are gone. Relaunching is what makes
   the new bundle the running one and gets the permission prompts asked again.
   ────────────────────────────────────────────────────────────────────────── */

let updatesModule = null;
const loadUpdates = () =>
  updatesModule
    ?? (updatesModule = import(require("url").pathToFileURL(path.join(__dirname, "..", "server", "updates.js")).href));

ipcMain.handle("updates:install", async (_event, filePath) => {
  const { isDownloadedInstaller } = await loadUpdates();
  // The renderer names the path, so it is checked against the one directory the
  // downloader writes to. A renderer that could name any path would be a route
  // for opening arbitrary files with the operating system's own handler.
  if (!isDownloadedInstaller(filePath)) {
    log("Refused to open a path that is not a downloaded installer:", filePath);
    return { ok: false, reason: "That file was not downloaded by the updater." };
  }
  const problem = await shell.openPath(filePath);
  if (problem) {
    log("Could not open the installer:", problem);
    return { ok: false, reason: problem };
  }
  return { ok: true };
});

/**
 * "Close and Reopen".
 *
 * The label says both because it does both: relaunch is queued and then the app
 * quits. If the relaunch does not take — a freshly replaced bundle that macOS
 * has not yet cleared, most likely — the app has still closed, which is the
 * half the operator was told to expect and can finish by opening it themselves.
 * That is the reason for the wording: it never leaves someone waiting for a
 * window that is not coming.
 */
ipcMain.handle("updates:restart", () => {
  try {
    app.relaunch();
  } catch (error) {
    log("Relaunch could not be queued:", error.message);
  }
  app.quit();
  return true;
});

function focusedWindow(event) {
  return BrowserWindow.fromWebContents(event.sender);
}


/* ── Application menu ──────────────────────────────────────────────────────
   Building a custom menu replaces Electron's default one entirely, so the
   standard roles (edit, window, view) must be re-declared or the app silently
   loses copy/paste, undo, and minimise.
   ───────────────────────────────────────────────────────────────────────── */

let recentProjects = [];

async function chooseProjectFolder(targetWindow) {
  const result = await dialog.showOpenDialog(targetWindow, {
    title: "Open Project Folder",
    buttonLabel: "Open",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

function sendOpenProject(targetWindow, projectPath) {
  if (!projectPath || !targetWindow || targetWindow.isDestroyed()) return;
  // The renderer owns the actual switch so the menu and the in-app picker
  // travel the same, already-tested code path.
  targetWindow.webContents.send("menu:open-project", projectPath);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const target = () => BrowserWindow.getFocusedWindow() || mainWindow;

  const recentItems = recentProjects.length > 0
    ? recentProjects.slice(0, 10).map((project) => ({
        label: project.name || project.path,
        toolTip: project.path,
        click: () => sendOpenProject(target(), project.path),
      }))
    : [{ label: "No Recent Projects", enabled: false }];

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const win = target();
            const chosen = await chooseProjectFolder(win);
            sendOpenProject(win, chosen);
          },
        },
        {
          label: "Open Recent",
          submenu: [
            ...recentItems,
            { type: "separator" },
            { label: "Clear Recent", click: () => target()?.webContents.send("menu:clear-recent") },
          ],
        },
        { type: "separator" },
        {
          label: "New File",
          accelerator: "CmdOrCtrl+N",
          click: () => target()?.webContents.send("menu:new-file"),
        },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => target()?.webContents.send("menu:save"),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          label: "Toggle Terminal",
          accelerator: "CmdOrCtrl+J",
          click: () => target()?.webContents.send("menu:toggle-terminal"),
        },
        {
          label: "Command Palette",
          accelerator: "CmdOrCtrl+K",
          click: () => target()?.webContents.send("menu:command-palette"),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// The renderer is the source of truth for the recent list, so it pushes
// updates and the menu is rebuilt to match.
ipcMain.handle("menu:set-recent-projects", (_event, projects) => {
  recentProjects = Array.isArray(projects) ? projects : [];
  buildMenu();
});

ipcMain.handle("dialog:open-folder", async (event) => {
  return chooseProjectFolder(BrowserWindow.fromWebContents(event.sender));
});

ipcMain.handle("window:minimize", (event) => {
  focusedWindow(event)?.minimize();
});

ipcMain.handle("window:toggle-maximize", (event) => {
  const target = focusedWindow(event);
  if (!target) return false;
  if (target.isMaximized()) target.unmaximize();
  else target.maximize();
  return target.isMaximized();
});

ipcMain.handle("window:close", (event) => {
  focusedWindow(event)?.close();
});

ipcMain.handle("window:is-maximized", (event) => Boolean(focusedWindow(event)?.isMaximized()));

process.on("uncaughtException", (err) => {
  log("UNCAUGHT EXCEPTION:", err.stack || err.message);
});

process.on("unhandledRejection", (reason) => {
  log("UNHANDLED REJECTION:", reason);
});

app.whenReady().then(() => {
  log("app.whenReady resolved");
  buildMenu();
  createWindow();

  // The status item is a nice-to-have, not a dependency: a platform without a
  // tray must still get a window, so its own failure never reaches this far.
  try {
    attachGuardianTray({
      getWindow: () => mainWindow,
      onCreateWindow: createWindow,
      log,
    });
  } catch (error) {
    log("Guardian tray could not be attached:", error.message);
  }

  // A second Tray beside Guardian's, not a submenu inside it: the two answer
  // different questions, and folding them together would put the answer to
  // either one a submenu away.
  try {
    assistantTray = attachAssistantTray({
      getWindow: () => mainWindow,
      onCreateWindow: createWindow,
      onCommand: () => {},
      getHotkeyStatus: () => assistantHotkey,
      log,
    });
  } catch (error) {
    log("Assistant tray could not be attached:", error.message);
  }

  try {
    assistantOverlay = attachAssistantOverlay({
      devUrl: !app.isPackaged && process.env.ELECTRON_DEV ? "http://localhost:3000" : null,
      indexPath: path.join(__dirname, "../dist/index.html"),
      log,
    });
  } catch (error) {
    log("Assistant overlay could not be created:", error.message);
  }

  registerAssistantHotkey(DEFAULT_ASSISTANT_HOTKEY);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => {
  // A global shortcut outlives the process that registered it if it is not
  // released, and the next launch would then find its own hotkey taken.
  try {
    globalShortcut.unregisterAll();
  } catch (error) {
    log("Could not release global shortcuts:", error.message);
  }
  assistantOverlay?.destroy();
});

app.on("window-all-closed", () => {
  log("window-all-closed");
  if (process.platform !== "darwin") app.quit();
});
