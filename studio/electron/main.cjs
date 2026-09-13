const { app, BrowserWindow, Menu, dialog, globalShortcut, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { attachGuardianTray } = require("./tray.cjs");
const { attachAssistantTray } = require("./assistant-tray.cjs");
const { attachAssistantOverlay } = require("./assistant-overlay.cjs");
const { initVideoToolBridge, setBridgeWindow, videoBridge } = require("./videoToolBridge.cjs");
const { startVideoRpcServer } = require("./videoRpc.cjs");
const { resolveRealPath, processWithFfmpeg, formatAuditLine, findFfmpeg } = require("./mediaAccess.cjs");
const { initScreenRecorder, shutdownScreenRecorder } = require("./screenRecorder.cjs");
const { trashRefusalReason } = require("./projectTrash.cjs");
const { initVideoProjects, shutdownVideoProjects } = require("./videoProjects.cjs");
const { initVideoExport, shutdownVideoExport } = require("./videoExport.cjs");
const { registerWorkspaceMediaScheme, initWorkspaceMedia, stopWorkspaceTranscodes } = require("./workspaceMedia.cjs");
const { initBrowserViews } = require("./browserView.cjs");
const { initMpvView } = require("./mpvView.cjs");
const { configureTouchIdWebAuthn } = require("./webauthn.cjs");
const { attachContextMenu } = require("./contextMenu.cjs");

// The file pane's video and audio come over `teminali-media://`, and Electron
// only grants a scheme its privileges before `app.ready`. Handled after it.
registerWorkspaceMediaScheme();

/* ── Per-platform startup ──────────────────────────────────────────────────
   Everything here has to happen before `app.ready`.
   ───────────────────────────────────────────────────────────────────────── */

// Windows groups taskbar buttons and routes notifications by this id. The NSIS
// installer stamps the same id on the shortcuts it creates, so a pinned
// shortcut and the running window are one button rather than two.
if (process.platform === "win32") app.setAppUserModelId("os.teminali.app");

if (process.platform === "linux") {
  // Screen capture on a Wayland session goes through the PipeWire portal, and
  // Chromium only asks the portal when told to. Without this, desktopCapturer
  // lists nothing on GNOME's default session and the recorder has no sources.
  app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");

  // Ubuntu 24.04 stops unprivileged processes creating user namespaces, which
  // is how Chromium sandboxes its renderers when its setuid helper cannot be
  // used — and inside an AppImage it cannot be, because the image is mounted
  // nosuid. The app then dies before its first window with "Failed to move to
  // new namespace". Only that combination drops the sandbox; a distribution
  // without the restriction, or an unpacked install, keeps it.
  if (process.env.APPIMAGE && apparmorRestrictsUserNamespaces()) {
    app.commandLine.appendSwitch("no-sandbox");
  }
}

function apparmorRestrictsUserNamespaces() {
  try {
    return fs.readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1";
  } catch {
    return false;
  }
}

// One running copy per machine. macOS enforces this for a bundle on its own;
// Windows and Linux start a second process for a second double-click, and each
// would bring up its own gateway. Packaged builds only: a development window
// beside an installed app is a normal thing to want.
const singleInstance = !app.isPackaged || app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const existing = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (!existing) {
      createWindow();
      return;
    }
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  });
}

const logFile = path.join(app.getPath("userData"), "studio-main.log");
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch (e) {}
  console.log(...args);
}

log("Teminali OS main process starting...");
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
  // App root and version MUST always reflect this running process, never
  // an inherited value from a previous instance before an update restart.
  process.env.TEMINALI_APP_ROOT = app.getAppPath();
  process.env.TEMINALI_APP_VERSION = app.getVersion();

  const defaults = {
    FRONTIER_AUDIT_PATH: store("gateway-audit.jsonl"),
    FRONTIER_PROJECTS_STORE: store("recent-projects.json"),
    TEMINALI_BROWSER_STORE: store("browser-data.json"),
    TEMINALI_MEMORY_STORE: store("temi-memory.json"),
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
      instance = await createGateway(
        port === undefined
          ? { config: { appRoot: app.getAppPath() } }
          : { config: { port, appRoot: app.getAppPath() } }
      );
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

/* ── The local speech sidecar ─────────────────────────────────────────────
   voice-runtime/ ships beside the asar as an extra resource — see
   electron-builder.yml — and runs as a child of this process, not inside it:
   it is its own package with its own node_modules, onnxruntime's native
   binding cannot be loaded out of an archive, and its warm-up is minutes of
   CPU on a first run that must not stall the main process.

   It runs under this Electron binary with ELECTRON_RUN_AS_NODE=1, the way the
   MCP shim does, so a packaged app needs no Node on the PATH. An unpackaged
   app never spawns it: `npm run voice:serve` is the development sidecar.

   Nothing else in the app knows it exists. The gateway probes
   TEMINALI_VOICE_URL (127.0.0.1:8321 unless moved) and reads /status, which
   names each model as it becomes ready; a cold sidecar answers `{}` and the
   studio keeps the built-in engine until then. That is the whole status
   surface, and this adds nothing to it.
   ───────────────────────────────────────────────────────────────────────── */

let voiceSidecar = null;

/**
 * One port for both ends. The gateway reads TEMINALI_VOICE_URL for where the
 * sidecar is; the sidecar reads TEMINALI_VOICE_PORT for where to listen. An
 * operator who moves one has moved the other.
 */
function voiceSidecarPort() {
  const url = process.env.TEMINALI_VOICE_URL;
  if (url) {
    try {
      const { port } = new URL(url);
      if (port) return Number(port);
    } catch (error) {
      log("Ignoring an unreadable TEMINALI_VOICE_URL:", error.message);
    }
  }
  const port = Number(process.env.TEMINALI_VOICE_PORT);
  return Number.isInteger(port) && port > 0 ? port : 8321;
}

/** Binds and releases the port, which is the only honest way to ask. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = require("net").createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function startVoiceSidecar() {
  const devRoot = path.join(__dirname, "..", "voice-runtime");
  const packagedRoot = path.join(process.resourcesPath, "voice-runtime");
  const root = fs.existsSync(path.join(devRoot, "cli.js")) ? devRoot : packagedRoot;
  const entry = path.join(root, "cli.js");
  if (!fs.existsSync(entry)) {
    log("No voice sidecar in this build; voice stays on the built-in engine.");
    return;
  }
  const port = voiceSidecarPort();
  if (!(await isPortFree(port))) {
    // A development sidecar, or the previous instance still winding down. The
    // gateway talks to whatever answers there; a second one could only fail
    // to bind.
    log(`Voice sidecar port ${port} is taken; not starting another.`);
    return;
  }

  // transformers.js caches model weights inside its own package by default,
  // which here is inside the application bundle. The weights are a first-run
  // download of a few hundred megabytes and belong in userData, where an
  // update does not throw them away and a write does not touch the signed
  // bundle. voice-runtime/cli.js reads this; an operator's own value wins.
  const cache =
    process.env.TEMINALI_VOICE_CACHE || path.join(app.getPath("userData"), "voice-models");
  fs.mkdirSync(cache, { recursive: true });

  // The sidecar decodes every utterance with ffmpeg and looks for it on PATH,
  // which a Finder- or Start-menu-launched app does not have a useful one of.
  // findFfmpeg() is the same search the video exporter uses, and it knows where
  // each platform's package managers put it; null is passed as an empty string,
  // which the sidecar treats as "not set" and falls back to PATH.
  const ffmpeg = findFfmpeg();
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      TEMINALI_VOICE_PORT: String(port),
      TEMINALI_VOICE_CACHE: cache,
      ...(ffmpeg ? { TEMINALI_FFMPEG: ffmpeg } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  voiceSidecar = child;
  log(`Voice sidecar starting: pid ${child.pid}, port ${port}, models in ${cache}`);

  // The sidecar writes its listen line and each "ready" line to stderr. They
  // land in this log too, so a silent voice can be diagnosed from one file.
  const relay = (stream) => {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) log("Voice sidecar:", line);
      }
    });
  };
  relay(child.stdout);
  relay(child.stderr);

  child.on("error", (error) => log("Voice sidecar could not be spawned:", error.message));
  child.on("exit", (code, signal) => {
    if (voiceSidecar === child) voiceSidecar = null;
    log(`Voice sidecar exited (${signal || `code ${code}`}); the gateway will find no sidecar on its next probe.`);
  });
}


let mainWindow = null;
let videoRpc = null;

let browserViews = null;
/* The player panel's embedded mpv, on the platforms that can hold one. See electron/mpvView.cjs. */
let mpvView = null;

const DEV_URL = "http://localhost:3000";

/** An unpackaged build is a development build unless it asks for the bundle. */
function preferDevServer() {
  return !app.isPackaged && process.env.ELECTRON_DIST !== "1";
}

/*
  Vite and Electron start together, so the first load usually beats the dev
  server to the port. Retrying is what keeps the window off the file:// path,
  which cannot bootstrap a gateway session however the gateway is started.
*/
async function loadDevUrl(window, indexPath, attempts = 20, delayMs = 500) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (window.isDestroyed()) return;
    try {
      await window.loadURL(DEV_URL);
      return;
    } catch (error) {
      if (attempt === attempts) {
        log("Dev server never answered:", error.message);
        log("Falling back to file://, where the gateway session cannot bootstrap.");
        if (!window.isDestroyed()) window.loadFile(indexPath).catch(() => {});
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

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
    title: "Teminali OS",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      // Chromium's PDF viewer is a plugin, and it is off by default. FilePane
      // shows a PDF by pointing an iframe at a blob URL; without this the
      // frame renders blank instead of failing, so the two belong together.
      plugins: true,
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

  // Only a packaged app starts the gateway in-process and hands the renderer a
  // session. An unpackaged file:// page has neither that session nor an Origin
  // the gateway will accept, so it draws and then reports the gateway offline
  // for good: empty explorer, silent Guardian, no voice. An unpackaged build
  // therefore prefers Vite and waits for it rather than racing it. Set
  // ELECTRON_DIST=1 to load the built bundle instead.
  if (preferDevServer()) {
    log(`Loading DEV URL ${DEV_URL}`);
    loadDevUrl(mainWindow, indexPath);
  } else {
    log("Loading production file:", indexPath);
    mainWindow.loadFile(indexPath).catch((err) => {
      log("Failed to load dist/index.html:", err.message);
      mainWindow.loadURL(DEV_URL).catch(() => {});
    });
  }

  /*
    Right-click. Electron ships no context menu at all, so without this the
    editor, the composer and every other field in the shell had none — which
    read as the editor being unfinished rather than as the whole application
    missing something. See electron/contextMenu.cjs.
  */
  /* No Inspect Element on the shell's own menu. The app is not a page the
     operator inspects — a right-click on a chat message offering to open the
     renderer's devtools is a developer's affordance shown to a user, and the
     View menu's ⌥⌘I is still there for the times it is wanted. Inspect belongs
     to the browser panel, where the page really is someone else's. */
  attachContextMenu(mainWindow.webContents, { allowInspect: false });

  // A reload replaces the document but not the views layered over it, and the
  // fresh page has no idea they are there — it would draw under pages it never
  // opened. They belong to the document that asked for them.
  mainWindow.webContents.on("did-start-navigation", (event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    try {
      browserViews?.destroyAllBrowserViews();
      // The video window belongs to the document that asked for it too, and the
      // fresh page has never heard of it — see electron/mpvView.cjs.
      mpvView?.shutdownMpvView();
    } catch (error) {
      log("Browser views could not be cleared on navigation:", error?.message ?? error);
    }
  });

  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    log("did-fail-load:", errorCode, errorDescription);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    log("MainWindow closed");
    // The panel's pages are children of this window's content view; nothing
    // else would take them down, and a view outliving its window is a web
    // contents no one can reach.
    try {
      browserViews?.destroyAllBrowserViews();
      // mpv is a separate process: nothing else would end it, and it would keep
      // a black window over a desktop whose application has closed.
      mpvView?.shutdownMpvView();
    } catch (error) {
      log("Browser views could not be torn down:", error?.message ?? error);
    }
    mainWindow = null;
    // The overlay only shows while the app is unfocused, so closing the last
    // window is exactly the condition that pins it on screen — and macOS keeps
    // the process alive, so nothing else takes it down. It guides the operator
    // around this app; with no window there is nothing left to guide.
    assistantOverlay?.hide();
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

/**
 * The menu bar item's last known preference, cached where this process can read
 * it before any window exists.
 *
 * The renderer owns this preference — it lives in the persisted store with all
 * the others — but the Tray is built at `whenReady`, long before the renderer
 * has mounted and can say what the operator wanted. Without a copy on this side
 * the item appears and then vanishes on every cold start for anyone who turned
 * it off. The renderer is still the authority: its push on mount overrides this
 * file, which only ever records what that push last settled on. It is the first
 * preference this process persists; there is deliberately nothing general here,
 * because one boolean does not need a store.
 */
const menuBarIconCache = () => path.join(app.getPath("userData"), "shell-chrome.json");

function readMenuBarIcon() {
  try {
    const cached = JSON.parse(fs.readFileSync(menuBarIconCache(), "utf8"));
    // Anything but an explicit false means the item is wanted: no file, an
    // unreadable one, or one written by a build that did not know this key.
    return !(cached && cached.menuBarIcon === false);
  } catch {
    return true;
  }
}

/**
 * Records the visibility that actually settled, not the one requested, so this
 * cache and the renderer's preference always hold the same boolean — the
 * renderer writes the settled answer back into its own store for the same
 * reason. A cache that disagreed with the store would be a second opinion.
 */
function writeMenuBarIcon(visible) {
  try {
    fs.writeFileSync(menuBarIconCache(), JSON.stringify({ menuBarIcon: visible }), "utf8");
  } catch (error) {
    log("Menu bar icon preference could not be cached:", error.message);
  }
}

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
  // here would point it at Teminali OS instead of the app the operator was
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

  // Asking again for the shortcut we already hold is not free if it is honoured
  // literally: unregisterAll() drops it, and until register() takes it back the
  // hotkey does nothing. Three callers reach here on a cold start - this file's
  // own startup call, the renderer pushing the operator's setting, and (in dev)
  // StrictMode invoking that effect a second time - so the literal reading tore
  // the shortcut down twice for no change and printed two lines claiming a
  // registration that had already happened, which is exactly the noise that
  // hides a registration that genuinely failed.
  //
  // A failed attempt is still retried rather than remembered: another
  // application may have released the combination since we last asked.
  if (next === assistantHotkey.accelerator && assistantHotkey.registered) return assistantHotkey;

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

// Returns the settled visibility, not the request. A Tray that will not
// construct on this platform must not leave the settings row claiming an item
// the menu bar does not have, so the renderer writes back whatever it is told.
ipcMain.handle("assistant:set-tray-visible", (_event, visible) => {
  const settled = Boolean(assistantTray?.setVisible(visible !== false));
  writeMenuBarIcon(settled);
  return settled;
});

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

ipcMain.handle("assistant:focus-studio", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    app.focus({ steal: true });
    mainWindow.focus();
    return true;
  }
  return false;
});

ipcMain.handle("assistant:overlay-interactive", (_event, capture) => {
  assistantOverlay?.setInteractive(Boolean(capture));
  return true;
});

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

   Windows hands that artifact to the operating system to open, then quits:
   the NSIS installer replaces the files and, by its own finish page, starts
   the new build. Quitting first is what keeps the installer from having to
   kill this process mid-write.

   Linux running as an AppImage is a single file, so the downloaded image is
   written over the running one — the mounted copy keeps its inode until exit,
   which is how AppImageUpdate does it too — and the relaunch names that path.
   An unpacked Linux build cannot be replaced from inside, so it is opened.

   macOS cannot open its artifact at all: Gatekeeper refuses to launch an
   ad-hoc bundle through LaunchServices and offers only Done / Move to Bin. So
   macOS downloads the published .zip and swaps the bundle in this process
   instead — see server/install-macos.js.

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
    // Teminali OS.app/Contents/MacOS/Teminali OS — the bundle is three
    // levels above the executable.
    const bundlePath = path.resolve(app.getPath("exe"), "..", "..", "..");
    const { installMacUpdate } = await loadMacInstaller();
    const result = await installMacUpdate({
      zipPath: filePath,
      bundlePath,
      onProgress: (info) => {
        try {
          _event.sender.send("updates:install-progress", info);
        } catch {
          /* window may have closed */
        }
      },
    });
    if (!result.ok) log("The update was not installed:", result.message);
    return result.ok ? { ok: true } : { ok: false, reason: result.message };
  }

  if (process.platform === "linux") {
    // A download has no execute bit; without one the AppImage is a file the
    // desktop offers to open in an archive manager.
    await fs.promises.chmod(filePath, 0o755);
    const running = process.env.APPIMAGE;
    if (running && app.isPackaged) {
      const staged = `${running}.new`;
      try {
        await fs.promises.copyFile(filePath, staged);
        await fs.promises.chmod(staged, 0o755);
        await fs.promises.rename(staged, running);
      } catch (error) {
        log("Could not replace the running AppImage:", error.message);
        await fs.promises.rm(staged, { force: true }).catch(() => {});
        return { ok: false, reason: `The AppImage at ${running} could not be replaced: ${error.message}` };
      }
      log("Replaced the running AppImage at", running);
      return { ok: true, replaced: true };
    }
  }

  const problem = await shell.openPath(filePath);
  if (problem) {
    log("Could not open the installer:", problem);
    return { ok: false, reason: problem };
  }

  if (process.platform === "win32") {
    // Long enough for the renderer to draw its "closing" state; short enough
    // that the installer's own "is running" check does not get there first.
    setTimeout(() => app.quit(), 1_500);
    return { ok: true, quitting: true };
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
    delete process.env.TEMINALI_APP_VERSION;
    delete process.env.TEMINALI_APP_ROOT;
    // An AppImage's execPath is inside the mount that goes away with this
    // process; the image itself is what to start, and it may just have been
    // replaced with the new build.
    app.relaunch(process.platform === "linux" && process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : undefined);
  } catch (error) {
    log("Relaunch could not be queued:", error.message);
  }
  setTimeout(() => {
    try { app.exit(0); } catch { /* best effort */ }
  }, 150);
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
        {
          /*
            The video editor's own file commands, and the only way to reach
            them: a timeline is not a file in the tree, so ⌘O and ⌘S above —
            which open a folder and save the focused editor buffer — cannot
            serve it.

            Here rather than in the pane's own chrome for the reason the
            recorder's item gives: a native menu owns its accelerator whatever
            has focus, and the video pane hands focus to a canvas, a timeline
            and a dozen numeric fields. The summon bar in `VideoPane` is
            navigation, and it is width-gated away at `sm`.

            ⌥ rather than ⇧, and that is not a taste call: ⇧⌘O and ⇧⌘S are
            already the Codex panel and the side panel in `App.tsx`'s shortcut
            handler. An accelerator the menu takes is one the renderer stops
            hearing, so those two bindings would have gone quiet with no error
            anywhere. ⌥ keeps the letters, which is the whole mnemonic — the
            video editor's ⌘O and ⌘S.
          */
          label: "Open Video Project…",
          accelerator: "Alt+CmdOrCtrl+O",
          click: () => target()?.webContents.send("menu:open-video-project"),
        },
        {
          // Ellipsis because the first save names a folder. Later saves reuse
          // it — `projectDir` on the project store is what remembers.
          label: "Save Video Project…",
          accelerator: "Alt+CmdOrCtrl+S",
          click: () => target()?.webContents.send("menu:save-video-project"),
        },
        {
          // The renderer decides whether an export can start — only it knows
          // whether the sequence has anything in it and whether the media
          // decodes — so this opens the dialog rather than beginning a render.
          label: "Export Video…",
          accelerator: "Alt+CmdOrCtrl+E",
          click: () => target()?.webContents.send("menu:export-video"),
        },
        { type: "separator" },
        {
          // The only way in, now that the recorder is a dialog rather than a
          // workspace panel: there is no tab to click and no add-panel entry.
          // The accelerator lives here rather than in a renderer key handler
          // because a native menu owns it whatever has focus — a terminal, a
          // webview, a text field — and none of those swallow it.
          label: "Record Screen…",
          accelerator: "Shift+CmdOrCtrl+8",
          click: () => target()?.webContents.send("menu:record-screen"),
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

/* ── The sidebar's project actions ────────────────────────────────────────
   Reveal is a courtesy. Trash is the only control in Teminali OS that takes
   something off the operator's disk, so three things are true of it on purpose:

   - The rule that decides what may go lives in `projectTrash.cjs`, pure, and
     is tested. Nothing at or above the home folder is a project.
   - The confirmation is raised *here*, not in the renderer. A confirm the
     renderer draws is a confirm the renderer can decide to skip; this one is
     on the path to `shell.trashItem` and cannot be gone round.
   - It trashes rather than deletes. macOS keeps a Put Back, and the difference
     between a bad click and a lost afternoon is exactly that.
   ────────────────────────────────────────────────────────────────────────── */
ipcMain.handle("projects:reveal", (_event, target) => {
  if (typeof target !== "string" || !target.trim()) return { ok: false, reason: "No project path was given." };
  shell.showItemInFolder(target);
  return { ok: true };
});

ipcMain.handle("projects:move-to-trash", async (event, target) => {
  const refusal = trashRefusalReason(target, { home: app.getPath("home") });
  if (refusal) return { trashed: false, reason: refusal };

  if (!fs.existsSync(target)) {
    // Already gone is not a failure to report as one — the sidebar's next act
    // is to forget the project, which is the right outcome either way.
    return { trashed: true, missing: true };
  }

  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
    type: "warning",
    buttons: ["Move to Trash", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Move “${path.basename(target)}” to the Trash?`,
    detail: `${target}\n\nThe folder and everything inside it goes to the Trash. You can put it back from the Finder.`,
  });
  if (response !== 0) return { trashed: false, cancelled: true };

  try {
    await shell.trashItem(target);
    return { trashed: true };
  } catch (error) {
    return { trashed: false, reason: error?.message || "The Trash refused the folder." };
  }
});

/* ── The media approval gate's half in main ───────────────────────────────
   The gate lives in the renderer and is free of I/O so it stays testable;
   these are the three things it cannot do there, plus ffmpeg. See
   `electron/mediaAccess.cjs` and `src/video/P3-import-gate.md`.
   ────────────────────────────────────────────────────────────────────────── */

// Synchronous, and read once at preload time, because the deny list is
// consulted on the first tool call and an `await` there would mean a window in
// which the policy is not loaded yet and every path looks ungranted.
/**
 * Which application macOS attributes the assistant's screen control to.
 *
 * Accessibility is granted to a bundle, not to a helper: the pointer binary is
 * ad-hoc signed and short-lived, so TCC judges whoever is responsible for it.
 * The name of that bundle is the executable's, which is "Teminali OS" in a
 * packaged run and "Electron" in a development one — and the renderer cannot
 * work either out for itself. `isPackaged` rides along because a development
 * run launched from a terminal is attributed to the terminal, which makes the
 * grant land somewhere the operator would never think to look.
 */
ipcMain.on("assistant:host-sync", (event) => {
  event.returnValue = { name: path.basename(app.getPath("exe")), isPackaged: app.isPackaged };
});

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

ipcMain.handle("window:set-progress-bar", (event, progress) => {
  const target = focusedWindow(event) || mainWindow;
  if (!target || target.isDestroyed()) return false;
  target.setProgressBar(typeof progress === "number" && progress >= 0 ? progress : -1);
  return true;
});

process.on("uncaughtException", (err) => {
  log("UNCAUGHT EXCEPTION:", err.stack || err.message);
});

process.on("unhandledRejection", (reason) => {
  log("UNHANDLED REJECTION:", reason);
});

app.whenReady().then(async () => {
  log("app.whenReady resolved");
  if (!singleInstance) return;

  /*
   * Let the screen assistant see this window's own controls.
   *
   * Chromium builds its accessibility tree lazily: it waits for an assistive
   * technology to announce itself through `AXEnhancedUserInterface` before
   * spending anything on one. The pointer helper reads the tree with raw
   * `AXUIElement` calls instead, which never trips that auto-enable — so
   * `assistant-doctor` reported ten elements for this app (eight menu-bar
   * items, the window, one group) and nothing inside the renderer. The
   * assistant could drive every other application on the Mac except the one it
   * lives in.
   *
   * The cost is real but bounded: an accessibility tree is maintained for the
   * renderer from here on. That is the trade the feature is made of.
   */
  if (process.platform === "darwin") {
    try {
      app.setAccessibilitySupportEnabled(true);
      log("Accessibility support enabled for the renderer");
    } catch (error) {
      log("Accessibility support could not be enabled:", error?.message || error);
    }
  }

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
    // Not awaited: the window does not depend on it, and a first run spends
    // minutes downloading weights that the sidecar reports through /status.
    startVoiceSidecar().catch((error) => {
      log("Voice sidecar could not be started:", error?.stack || error?.message || error);
    });
  }

  // After the gateway, so a packaged app's media protocol reads the live root
  // off the instance this process holds; a development build is told the root
  // by the renderer instead. See electron/workspaceMedia.cjs.
  try {
    initWorkspaceMedia({
      getGatewayRoot: () => gateway?.config?.workspaceRoot ?? null,
      isMainWindow: (sender) => Boolean(mainWindow) && !mainWindow.isDestroyed() && sender === mainWindow.webContents,
      log,
    });
  } catch (error) {
    log("Workspace media protocol could not be registered:", error?.stack || error?.message || error);
  }

  /*
    Touch ID passkeys, before the first page can ask for one.

    Awaited rather than left to finish on its own: until
    `configureWebAuthn` has been called,
    `isUserVerifyingPlatformAuthenticatorAvailable()` answers false, and a page
    that asked a moment too early would be told there is no authenticator by a
    build that has one. It costs one `codesign` read, bounded and only on
    macOS, on a path that has already waited for a gateway. See
    electron/webauthn.cjs.
  */
  try {
    await configureTouchIdWebAuthn({ app, log });
  } catch (error) {
    log("Touch ID passkeys could not be configured:", error?.stack || error?.message || error);
  }

  // The browser panel's pages, which are views layered over the window rather
  // than frames inside it. See electron/browserView.cjs.
  try {
    browserViews = initBrowserViews({ getMainWindow: () => mainWindow, log });
  } catch (error) {
    log("Browser views could not be initialised:", error?.stack || error?.message || error);
  }

  /*
    The player panel's video output, which on Windows and Linux is a window of
    its own that mpv draws into rather than anything in the document. On macOS
    every call answers "not on this platform" — a spawned process cannot be
    embedded there and the Mac's path is a linked libmpv. See
    electron/mpvView.cjs and docs/MEDIA_LICENSING.md.
  */
  try {
    mpvView = initMpvView({ getMainWindow: () => mainWindow, log });
  } catch (error) {
    log("The mpv view could not be initialised:", error?.stack || error?.message || error);
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

  /*
    The recorder's fifteen `recorder:*` handlers, and the window getter they
    hide and restore around a take. Registered after `createWindow` so that
    `initScreenRecorder` finds a live window and can attach its did-finish-load
    reconciliation straight away rather than deferring a tick.

    Nothing else in main requires this module, so until it is called here the
    handlers do not exist — and `window.teminali.recorder` in the preload has
    nothing to invoke.
  */
  try {
    initScreenRecorder(() => mainWindow);
  } catch (error) {
    log("The screen recorder could not be started:", error?.message || error);
  }

  /*
    The video project transport. Same shape and the same reason: without this
    call the `videoProject:*` handlers do not exist, and `window.teminali`'s
    `videoProjects` key has nothing to invoke. `tests/video-project-bridge.test.mjs`
    asserts this call is here, because a complete and correct module that
    nothing required is exactly how the recorder shipped dead.
  */
  try {
    initVideoProjects(() => mainWindow);
  } catch (error) {
    log("The video project transport could not be started:", error?.message || error);
  }

  /*
    The exporter's four `export:*` handlers. Registered here for the same
    reason as the two above and asserted by `tests/video-export.test.mjs`:
    the renderer's export driver is a long loop that only discovers a missing
    handler on the frame after it has already started encoding.
  */
  try {
    initVideoExport();
  } catch (error) {
    log("The video exporter could not be started:", error?.message || error);
  }

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
      // Read before the item is built, so an operator who turned it off gets no
      // cold-start flash of an icon on its way to being destroyed.
      initialVisible: readMenuBarIcon(),
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
      devUrl: preferDevServer() ? DEV_URL : null,
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
  // An ffmpeg started for a live transcode is a child of this process and
  // outlives it if nothing kills it; a paused film would keep encoding.
  try {
    stopWorkspaceTranscodes();
  } catch (error) {
    log("Could not stop media transcodes:", error.message);
  }
  // A global shortcut outlives the process that registered it if it is not
  // released, and the next launch would then find its own hotkey taken.
  try {
    globalShortcut.unregisterAll();
  } catch (error) {
    log("Could not release global shortcuts:", error.message);
  }
  // Releases the recorder's own global shortcuts, closes the floating bar and
  // ends any half-written take file. Its shortcuts are registered per session,
  // so `unregisterAll` above has already taken them; this is for the streams.
  try {
    shutdownScreenRecorder();
  } catch (error) {
    log("Could not shut the screen recorder down:", error.message);
  }
  try {
    shutdownVideoProjects();
  } catch (error) {
    log("Could not shut the video project transport down:", error.message);
  }
  // Kills any ffmpeg still encoding, so it cannot outlive the app.
  try {
    shutdownVideoExport();
  } catch (error) {
    log("Could not shut the video exporter down:", error.message);
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
  // SIGTERM, which cli.js answers by closing its server and exiting. Left
  // alone it would outlive the app, holding the port and the loaded weights.
  try {
    voiceSidecar?.kill();
  } catch (error) {
    log("Could not stop the voice sidecar:", error.message);
  }
});

/* The overlay points at other applications, so it stands down while the
   operator is inside Teminali OS. Focus moving between our own windows fires
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
