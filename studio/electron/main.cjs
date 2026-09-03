const { app, BrowserWindow, Menu, dialog, globalShortcut, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { attachGuardianTray } = require("./tray.cjs");
const { attachAssistantTray } = require("./assistant-tray.cjs");
const { attachAssistantOverlay } = require("./assistant-overlay.cjs");
const { initVideoToolBridge, setBridgeWindow, videoBridge } = require("./videoToolBridge.cjs");
const { startVideoRpcServer } = require("./videoRpc.cjs");
const { resolveRealPath, processWithFfmpeg, formatAuditLine } = require("./mediaAccess.cjs");

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

/* ── The local gateway ────────────────────────────────────────────────────
   `npm start` runs three processes: the gateway, Vite, and Electron. A packaged
   app is one process, and nothing in it ever started the gateway — so 1.1.0 and
   1.1.1 shipped a studio with no backend, and every chat ended at "the local
   gateway session could not be created". This starts it in-process.

   In-process rather than a spawned child: the gateway is ESM inside an asar
   archive, which Node can import but cannot execute as a script, and a child
   would need its own copy of the environment below anyway.

   The token is not fetched, it is held. POST /api/session mints one only for an
   allowed browser origin, and the packaged renderer is a file:// page whose
   requests Chromium sends with no Origin header at all — so that bootstrap
   cannot succeed here however the gateway is started. Every other route already
   accepts a header-less local caller holding a valid bearer token, which is
   exactly what this process is; preload.cjs hands the token to the renderer.
   ───────────────────────────────────────────────────────────────────────── */

let gateway = null;
/** Published to the renderer by preload.cjs. Null until the gateway is up. */
let gatewaySession = null;

/**
 * Everything under server/ that resolves a writable path does it against
 * `process.cwd()`, which for an app launched from Finder is "/". Point them at
 * userData before the config is read; each is only a default, so an operator
 * who exports one of these still wins.
 */
function applyPackagedEnvironment() {
  const userData = app.getPath("userData");
  const store = (name) => path.join(userData, "gateway", name);
  const defaults = {
    FRONTIER_AUDIT_PATH: store("gateway-audit.jsonl"),
    FRONTIER_PROJECTS_STORE: store("recent-projects.json"),
    TEMINALI_PROVIDER_STORE: store("provider-keys.json"),
    TEMINALI_GUARDIAN_STORE: store("guardian-settings.json"),
    TEMINALI_AGENT_MODEL_STORE: store("agent-models.json"),
    TEMINALI_ASSISTANT_FRAMES: store("assistant-frames"),
    TEMINALI_USAGE_LEDGER: store("usage-ledger.jsonl"),
    TEMINALI_ADMIN_STORE: store("admins.json"),
    TEMINALI_ARENA_HISTORY: store("arena-runs.jsonl"),
    // Left to itself this resolves inside the asar, where no project lives.
    FRONTIER_WORKSPACE_ROOT: app.getPath("home"),
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) process.env[key] = value;
  }
  try {
    fs.mkdirSync(path.join(userData, "gateway"), { recursive: true });
  } catch (error) {
    log("Could not create the gateway store directory:", error.message);
  }
}

async function startGateway() {
  applyPackagedEnvironment();
  const gatewayUrl = require("url").pathToFileURL(
    path.join(__dirname, "..", "server", "gateway.js")
  ).href;
  const { createGateway } = await import(gatewayUrl);

  // 4310 is what the studio has always used, and is worth keeping so anything
  // pointed at it by hand still works. It is not worth failing over: a second
  // instance, or a development gateway already holding the port, would take the
  // app down with EADDRINUSE. The renderer is told the port either way.
  for (const port of [undefined, 0]) {
    let instance;
    try {
      instance = await createGateway(port === undefined ? {} : { config: { port } });
      const address = await instance.listen();
      gateway = instance;
      gatewaySession = {
        url: `http://${address.address}:${address.port}`,
        token: instance.sessionToken,
      };
      log(`Gateway listening on ${gatewaySession.url}`);
      return;
    } catch (error) {
      // The instance that failed to bind still holds the audit log open, and
      // the retry opens the same file: two writers would interleave lines.
      await instance?.close().catch(() => {});
      if (error?.code === "EADDRINUSE" && port === undefined) {
        log("Gateway port is taken; falling back to an ephemeral port.");
        continue;
      }
      throw error;
    }
  }
}

// Answered synchronously so the renderer can treat the gateway address as a
// constant instead of something to await before its first request.
ipcMain.on("gateway:session-sync", (event) => {
  event.returnValue = gatewaySession;
});


let mainWindow = null;
let videoRpc = null;

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

  // This is the window an external agent's tool calls are asked of. Set before
  // the page loads, because the renderer announces its bridge as it boots and
  // main must already know which window that announcement can come from.
  setBridgeWindow(mainWindow);

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
    // The bridge now has nothing to ask, and a request against a destroyed
    // window should say so rather than wait out its timeout.
    setBridgeWindow(null);
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
  // Shown without being focused, deliberately. The assistant reads the
  // accessibility tree of whichever application is frontmost, so taking focus
  // here would point it at Teminali Code instead of the app the operator was
  // actually looking at when they pressed the shortcut — the assistant would
  // answer questions about its own window. The tray's "Open" item still brings
  // the app forward for anyone who wants that.
  window.showInactive();
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

ipcMain.handle("assistant:minimise-overlay", (_event, value) => {
  if (!assistantOverlay) return false;
  const next = typeof value === "boolean" ? value : !assistantOverlay.isMinimized();
  const settled = assistantOverlay.setMinimized(next);
  assistantTray?.rebuildMenu();
  return settled;
});

ipcMain.handle("assistant:overlay-minimised", () => Boolean(assistantOverlay?.isMinimized()));

// The overlay page asks for the current drawing when it mounts. A push alone
// races the first paint: the state is sent the moment the window is created,
// which is before React has subscribed to anything.
ipcMain.handle("assistant:overlay-state", () => assistantOverlay?.getState() ?? { visible: false });

let screenRecordingModule = null;
const loadScreenRecording = () =>
  screenRecordingModule
    ?? (screenRecordingModule = import(require("url").pathToFileURL(path.join(__dirname, "..", "server", "screen-recording.js")).href));

/* Screen Recording cannot be granted by asking. macOS has no prompt an app can
   raise for it, so the only working move is to open the list and put the
   bundle the operator has to drag in front of them. See server/screen-recording.js
   for why dragging beats flipping the switch on a rebuilt app. */
ipcMain.handle("assistant:reveal-for-screen-recording", async () => {
  const { revealForScreenRecording } = await loadScreenRecording();
  return revealForScreenRecording({
    execPath: app.getPath("exe"),
    packaged: app.isPackaged,
    platform: process.platform,
    resolvePath: path.resolve,
    openPane: (url) => shell.openExternal(url),
    revealInFinder: (target) => shell.showItemInFolder(target),
  });
});

/* ── Updates ────────────────────────────────────────────────────────────────
   This build is ad-hoc signed, so an update is a whole new artifact rather than
   an in-place patch — Squirrel will not apply an update to a binary it cannot
   verify, and no amount of wiring changes that.

   Windows and Linux hand that artifact to the operating system to open. macOS
   cannot: Gatekeeper refuses to launch an ad-hoc bundle through LaunchServices
   and offers only Done / Move to Bin. So macOS downloads the published .zip and
   swaps the bundle in this process instead — see server/install-macos.js.

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

let macInstallerModule = null;
const loadMacInstaller = () =>
  macInstallerModule
    ?? (macInstallerModule = import(require("url").pathToFileURL(path.join(__dirname, "..", "server", "install-macos.js")).href));

ipcMain.handle("updates:install", async (_event, filePath) => {
  const { isDownloadedInstaller } = await loadUpdates();
  // The renderer names the path, so it is checked against the one directory the
  // downloader writes to. A renderer that could name any path would be a route
  // for opening arbitrary files with the operating system's own handler.
  if (!isDownloadedInstaller(filePath)) {
    log("Refused to open a path that is not a downloaded installer:", filePath);
    return { ok: false, reason: "That file was not downloaded by the updater." };
  }

  if (process.platform === "darwin") {
    // Only a packaged build may do this. Unpackaged, `exe` points into the
    // Electron binary that npm installed, and the bundle three levels above it
    // is Electron.app itself — which this would then overwrite.
    if (!app.isPackaged) {
      return { ok: false, reason: "A development build cannot replace itself." };
    }
    // Teminali Code.app/Contents/MacOS/Teminali Code — the bundle is three
    // levels above the executable.
    const bundlePath = path.resolve(app.getPath("exe"), "..", "..", "..");
    const { installMacUpdate } = await loadMacInstaller();
    const result = await installMacUpdate({ zipPath: filePath, bundlePath });
    if (!result.ok) log("The update was not installed:", result.message);
    return result.ok ? { ok: true } : { ok: false, reason: result.message };
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

/* ── The media approval gate's half in main ───────────────────────────────
   The gate lives in the renderer and is free of I/O so it stays testable;
   these are the three things it cannot do there, plus ffmpeg. See
   `electron/mediaAccess.cjs` and `src/video/P3-import-gate.md`.
   ────────────────────────────────────────────────────────────────────────── */

// Synchronous, and read once at preload time, because the deny list is
// consulted on the first tool call and an `await` there would mean a window in
// which the policy is not loaded yet and every path looks ungranted.
ipcMain.on("media:paths-sync", (event) => {
  event.returnValue = { home: app.getPath("home"), userData: app.getPath("userData") };
});

ipcMain.handle("media:resolve-path", (_event, requested) => resolveRealPath(requested));

// Every decision, in the same log the rest of main writes to.
ipcMain.on("media:audit", (_event, entry) => log(formatAuditLine(entry)));

ipcMain.handle("media:ffmpeg", (_event, options) => processWithFfmpeg(options ?? {}));

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

app.whenReady().then(async () => {
  log("app.whenReady resolved");

  // Before the window: preload.cjs reads the session as the page loads, so the
  // gateway has to be listening by then. A failure here is logged and survived
  // rather than thrown — a studio that opens and reports the gateway offline is
  // more use than one that never draws.
  if (app.isPackaged) {
    try {
      await startGateway();
    } catch (error) {
      log("Gateway could not be started:", error?.stack || error?.message || error);
    }
  }

  /*
    The video panel's MCP bridge, before anything that might use it.

    An agent CLI cannot see this renderer's timeline stores, so it reaches them
    through this: shim → 127.0.0.1 → main → IPC → renderer. Started even when
    the panel has never been opened, because the stores are seeded at module
    load and a tool list that came back empty would leave an agent believing
    there is no editor here at all. Failure is survivable and deliberately not
    thrown — Code with no video bridge is still Code.
  */
  try {
    initVideoToolBridge();
    videoRpc = startVideoRpcServer({ bridge: videoBridge, log });
  } catch (error) {
    log("The video MCP bridge could not be started:", error?.message || error);
  }

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
      isOverlayMinimised: () => Boolean(assistantOverlay?.isMinimized()),
      onToggleOverlayMinimised: () => {
        assistantOverlay?.setMinimized(!assistantOverlay.isMinimized());
      },
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
  // Takes the endpoint file with it, so the next launch's gateway cannot find
  // credentials for a window that no longer exists.
  videoRpc?.close();
  // Best effort, and deliberately not awaited: `will-quit` does not wait for a
  // promise, and the listening socket dies with this process regardless.
  try {
    gateway?.close();
  } catch (error) {
    log("Could not close the gateway:", error.message);
  }
});

/* The overlay points at other applications, so it stands down while the
   operator is inside Teminali Code. Focus moving between our own windows fires
   blur before the next focus, hence the deferred re-read rather than trusting
   the blur on its own. */
app.on("browser-window-focus", () => assistantOverlay?.setAppFocused(true));
app.on("browser-window-blur", () => {
  setImmediate(() => {
    const ours = BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isFocused());
    assistantOverlay?.setAppFocused(ours);
  });
});

app.on("window-all-closed", () => {
  log("window-all-closed");
  if (process.platform !== "darwin") app.quit();
});
