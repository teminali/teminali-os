const { Menu, Tray, nativeImage, app } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

/**
 * The assistant's own menu bar item.
 *
 * A second Tray beside Guardian's, deliberately — they answer different
 * questions. Guardian's title tells you what the machine is holding; this one
 * tells you whether the assistant can see your screen and what it will do when
 * you talk to it. Folding them into one item would mean the answer to either
 * question was a submenu away.
 *
 * The permission rows read the pointer helper directly rather than going
 * through the gateway, for the same reason Guardian's tray imports its
 * telemetry module: the main process is already Node, and a status item that
 * stops working whenever the gateway restarts is broken exactly when someone is
 * most likely to look at it.
 */

const POLL_INTERVAL_MS = 20_000;

/* ── Icon ─────────────────────────────────────────────────────────────────── */

/**
 * A microphone: a rounded capsule over a shallow arc, rasterised rather than
 * shipped as a file so the tray has no asset to lose in a packaged build.
 *
 * As with Guardian's mark, only the alpha channel carries the shape — macOS
 * paints a template image black on a light menu bar and white on a dark one, so
 * one buffer is correct in both themes without a theme listener.
 */
const GLYPH_SIZE = 16;

function rasteriseGlyph(scale) {
  const size = GLYPH_SIZE * scale;
  const buffer = Buffer.alloc(size * size * 4, 0);
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    buffer[(y * size + x) * 4 + 3] = 255;
  };

  const capsuleTop = 3 * scale;
  const capsuleBottom = 9.5 * scale;
  const capsuleRadius = 2.2 * scale;
  const centreX = 8 * scale;

  // Capsule body, with rounded caps.
  for (let y = capsuleTop; y < capsuleBottom; y += 1) {
    let halfWidth = capsuleRadius;
    const fromTop = y - capsuleTop;
    const fromBottom = capsuleBottom - 1 - y;
    const nearest = Math.min(fromTop, fromBottom);
    if (nearest < capsuleRadius) {
      halfWidth = Math.sqrt(Math.max(0, capsuleRadius * capsuleRadius - (capsuleRadius - nearest) ** 2));
    }
    for (let x = Math.round(centreX - halfWidth); x < Math.round(centreX + halfWidth); x += 1) set(x, y);
  }

  // The cradle arc under it, and the stand.
  const arcRadius = 4.4 * scale;
  const arcCentreY = 8 * scale;
  const thickness = Math.max(1, Math.round(0.9 * scale));
  for (let angle = 0; angle <= 180; angle += 1) {
    const radians = (angle * Math.PI) / 180;
    const x = centreX - Math.cos(radians) * arcRadius;
    const y = arcCentreY + Math.sin(radians) * arcRadius;
    for (let offset = 0; offset < thickness; offset += 1) set(Math.round(x), Math.round(y) + offset);
  }
  for (let y = arcCentreY + arcRadius; y < 14 * scale; y += 1) {
    for (let offset = 0; offset < thickness; offset += 1) set(Math.round(centreX) + offset, Math.round(y));
  }

  return { buffer, size };
}

function assistantIcon() {
  const at1x = rasteriseGlyph(1);
  const image = nativeImage.createFromBuffer(at1x.buffer, {
    width: at1x.size,
    height: at1x.size,
    scaleFactor: 1,
  });
  const at2x = rasteriseGlyph(2);
  image.addRepresentation({ scaleFactor: 2, width: at2x.size, height: at2x.size, buffer: at2x.buffer });
  image.setTemplateImage(true);
  return image;
}

/* ── Menu ─────────────────────────────────────────────────────────────────── */

const MODES = [
  { id: "dictate", label: "Dictate into the composer" },
  { id: "talk", label: "Talk — explain and point" },
  { id: "agent", label: "Agent — act on my screen" },
];

const AUTONOMY = [
  { id: "guide", label: "Guide only — never touch anything" },
  { id: "confirm", label: "Ask me before each action" },
  { id: "auto", label: "Run the whole plan" },
];

const ENGINES = [
  { id: "frontier", label: "Frontier" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

const FRONTIER_MODES = [
  { id: "flash", label: "Flash" },
  { id: "auto", label: "Auto" },
  { id: "max", label: "Max" },
];

/** "CommandOrControl+Shift+Space" → "⌘⇧Space", for a menu bar that has no room. */
function prettyAccelerator(accelerator) {
  if (typeof accelerator !== "string" || !accelerator) return "";
  if (process.platform !== "darwin") return accelerator;
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/gi, "⌘")
    .replace(/Control|Ctrl/gi, "⌃")
    .replace(/Alt|Option/gi, "⌥")
    .replace(/Shift/gi, "⇧")
    .replace(/\+/g, "");
}

/**
 * @param {object} options
 * @param {() => Electron.BrowserWindow | null} options.getWindow
 * @param {() => void} [options.onCreateWindow]
 * @param {(command: object) => void} options.onCommand Sent to the renderer.
 * @param {() => object} options.getHotkeyStatus
 * @param {(...args: unknown[]) => void} [options.log]
 */
function attachAssistantTray({ getWindow, onCreateWindow, onCommand, getHotkeyStatus, log = () => {} }) {
  let tray = null;
  let timer = null;
  let permissions = null;
  let pointer = null;
  // Rebuilding an open context menu closes it under the cursor.
  let menuOpen = false;
  let pendingRebuild = false;

  /** Mirrored from the renderer, which owns the settings. */
  let state = {
    mode: "talk",
    autonomy: "confirm",
    engine: "frontier",
    frontierMode: "auto",
    speak: true,
    overlay: true,
    phase: "idle",
  };

  try {
    tray = new Tray(assistantIcon());
  } catch (error) {
    log("Assistant tray unavailable:", error && error.message ? error.message : String(error));
    return { destroy() {}, setState() {}, refresh() {} };
  }

  tray.setToolTip("Teminali Assistant");

  /**
   * Brings the window back, and decides whether to take focus doing it.
   *
   * Focus is not cosmetic here: the assistant reads the accessibility tree of
   * the frontmost application, so raising Teminali Code in front of the app the
   * operator is asking about makes it observe itself. Anything that starts an
   * assistant turn shows the window without activating; only "Open Teminali
   * Code", where the window *is* what was asked for, takes focus.
   */
  function reveal(payload, { focus = true } = {}) {
    let window = getWindow();
    if (!window || window.isDestroyed()) {
      onCreateWindow?.();
      window = getWindow();
    }
    if (!window || window.isDestroyed()) return null;
    if (window.isMinimized()) window.restore();
    if (focus) {
      window.show();
      window.focus();
    } else {
      window.showInactive();
    }
    if (payload) window.webContents.send("assistant:command", payload);
    return window;
  }

  function send(command) {
    onCommand?.(command);
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("assistant:command", command);
  }

  function radioGroup(options, selected, key) {
    return options.map((option) => ({
      label: option.label,
      type: "radio",
      checked: selected === option.id,
      click: () => send({ [key]: option.id }),
    }));
  }

  /**
   * Both permissions, always named individually.
   *
   * "Grant access" would not say which switch, and the two lose different
   * things: without Screen Recording the assistant cannot see the screen at
   * all; without Accessibility it can see it but cannot point at or touch any
   * control on it.
   */
  function permissionItems() {
    if (!permissions) return [{ label: "Checking screen access…", enabled: false }];
    if (!permissions.supported) return [{ label: permissions.detail || "Screen control is macOS-only.", enabled: false }];
    if (!permissions.helperBuilt) {
      return [
        { label: "Pointer helper not built", enabled: false },
        { label: "Run: npm run build:pointer", enabled: false },
      ];
    }

    const items = [
      {
        label: `Screen Recording  ${permissions.screenRecordingGranted ? "granted" : "not granted"}`,
        enabled: false,
      },
      {
        label: `Accessibility  ${permissions.accessibilityTrusted ? "granted" : "not granted"}`,
        enabled: false,
      },
    ];
    if (!permissions.accessibilityTrusted) {
      items.push({
        label: "Ask macOS for Accessibility…",
        click: () => void requestAccessibility(),
      });
    }
    if (!permissions.screenRecordingGranted || !permissions.accessibilityTrusted) {
      items.push({
        label: "Open Privacy & Security…",
        click: () => {
          const { shell } = require("electron");
          void shell.openExternal(
            permissions.screenRecordingGranted
              ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
              : "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
          );
        },
      });
    }
    return items;
  }

  function buildMenu() {
    const hotkey = getHotkeyStatus?.() ?? { accelerator: "", registered: false };
    const items = [
      { label: "Teminali Assistant", enabled: false },
      { type: "separator" },
      {
        label: "Talk to the assistant",
        accelerator: hotkey.registered ? hotkey.accelerator : undefined,
        click: () => reveal({ activate: true }, { focus: false }),
      },
    ];

    // A hotkey another application already owns is a hotkey that does nothing.
    // Saying so is the difference between a broken feature and a known one.
    if (!hotkey.registered) {
      items.push({
        label: hotkey.accelerator
          ? `${prettyAccelerator(hotkey.accelerator)} is taken by another app`
          : "No shortcut is set",
        enabled: false,
      });
    }

    items.push(
      { type: "separator" },
      { label: "Mode", enabled: false },
      ...radioGroup(MODES, state.mode, "mode"),
      { type: "separator" },
      { label: "When acting", enabled: false },
      ...radioGroup(AUTONOMY, state.autonomy, "autonomy"),
      { type: "separator" },
      {
        label: "Engine",
        submenu: [
          ...radioGroup(ENGINES, state.engine, "engine"),
          { type: "separator" },
          { label: "Frontier model", enabled: false },
          ...radioGroup(FRONTIER_MODES, state.frontierMode, "frontierMode").map((item) => ({
            ...item,
            enabled: state.engine === "frontier",
          })),
        ],
      },
      {
        label: "Speak answers aloud",
        type: "checkbox",
        checked: Boolean(state.speak),
        click: () => send({ speak: !state.speak }),
      },
      {
        label: "Draw on screen",
        type: "checkbox",
        checked: Boolean(state.overlay),
        click: () => send({ overlay: !state.overlay }),
      },
      { type: "separator" },
      ...permissionItems(),
      { type: "separator" },
      { label: "Open Teminali Code", click: () => reveal(null) },
      { label: "Quit Teminali Code", role: "quit" },
    );

    const menu = Menu.buildFromTemplate(items);
    menu.on("menu-will-show", () => {
      menuOpen = true;
    });
    menu.on("menu-will-close", () => {
      menuOpen = false;
      if (pendingRebuild) {
        pendingRebuild = false;
        applyMenu();
      }
    });
    return menu;
  }

  function applyMenu() {
    if (!tray || tray.isDestroyed()) return;
    if (menuOpen) {
      pendingRebuild = true;
      return;
    }
    try {
      tray.setContextMenu(buildMenu());
    } catch (error) {
      log("Assistant tray menu rebuild failed:", error && error.message ? error.message : String(error));
    }
  }

  /**
   * The menu bar has no room for a sentence, so the title is the one thing
   * worth knowing at a glance: whether the assistant is currently doing
   * something, and whether it is allowed to act when it does.
   */
  function applyTitle() {
    if (!tray || tray.isDestroyed()) return;
    const working = state.phase && state.phase !== "idle";
    tray.setTitle(working ? "●" : "");

    const lines = ["Teminali Assistant"];
    lines.push(
      state.mode === "dictate"
        ? "Dictates into the composer"
        : state.mode === "talk"
          ? "Explains and points; never acts"
          : state.autonomy === "guide"
            ? "Agent mode, guidance only"
            : state.autonomy === "confirm"
              ? "Agent mode, asks before each action"
              : "Agent mode, runs the whole plan",
    );
    if (permissions && permissions.supported && permissions.helperBuilt) {
      if (!permissions.screenRecordingGranted) lines.push("Screen Recording is off");
      if (!permissions.accessibilityTrusted) lines.push("Accessibility is off");
    }
    tray.setToolTip(lines.join("\n"));
  }

  let assistantModule = null;

  async function refresh() {
    if (!pointer) return;
    try {
      permissions = await pointer.pointerPermissions();
      applyTitle();
      applyMenu();
    } catch (error) {
      log("Assistant tray permission check failed:", error && error.message ? error.message : String(error));
    }
  }

  async function requestAccessibility() {
    if (!assistantModule) return;
    try {
      permissions = await assistantModule.requestAccessibility();
    } catch (error) {
      log("Accessibility prompt failed:", error && error.message ? error.message : String(error));
    }
    applyTitle();
    applyMenu();
  }

  // Both modules are ESM and this file is CommonJS, so they load dynamically. A
  // failure leaves a tray that can still open the studio and change the mode —
  // less useful, and far better than no menu bar item.
  Promise.all([
    import(pathToFileURL(path.join(__dirname, "..", "server", "pointer.js")).href),
    import(pathToFileURL(path.join(__dirname, "..", "server", "assistant.js")).href),
  ])
    .then(([pointerModule, assistant]) => {
      pointer = pointerModule;
      assistantModule = assistant;
      void refresh();
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    })
    .catch((error) => {
      log("Pointer module unavailable:", error && error.message ? error.message : String(error));
      applyMenu();
    });

  tray.on("double-click", () => reveal({ activate: true }, { focus: false }));
  applyTitle();
  applyMenu();

  function destroy() {
    if (timer) clearInterval(timer);
    timer = null;
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  }

  app.on("before-quit", destroy);

  return {
    destroy,
    refresh,
    /** The renderer owns the settings; the tray mirrors them. */
    setState(next) {
      state = { ...state, ...next };
      applyTitle();
      applyMenu();
    },
    rebuild: applyMenu,
  };
}

module.exports = { attachAssistantTray, assistantIcon };
