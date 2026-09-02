const { Menu, Tray, nativeImage, app } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

/**
 * The menu bar item.
 *
 * This is the part of Guardian that is useful when the studio window is not
 * even on screen: a resident 14B model holding 9GB is invisible from the Dock,
 * and the whole point of a status item is that the machine can tell you about
 * it without being asked.
 *
 * It reads telemetry by importing server/guardian.js directly rather than
 * calling the gateway. The main process is already a Node process, the module
 * has no dependencies beyond node builtins, and going over HTTP would make the
 * menu bar item stop working whenever the gateway is restarted — which is
 * exactly when someone is most likely to look at it.
 *
 * Everything below is guarded. A headless CI run, a Linux session with no
 * status area, or an Electron built without tray support must degrade to "no
 * menu bar item" and never to a crashed main process.
 */

const POLL_INTERVAL_MS = 5000;

/* ── Icon ─────────────────────────────────────────────────────────────────── */

/**
 * A three-bar telemetry mark, rasterised rather than shipped as a file so the
 * tray has no asset to lose in a packaged build.
 *
 * macOS template images use only the alpha channel — the system paints them
 * black on a light menu bar and white on a dark one — so the colour bytes are
 * zero and the shape lives entirely in alpha. That is what makes it correct in
 * both themes without two files and a theme listener.
 */
const BARS = [
  { x: 3, width: 2, top: 9 },
  { x: 7, width: 2, top: 5 },
  { x: 11, width: 2, top: 7 },
];
const GLYPH_SIZE = 16;
const GLYPH_BASELINE = 13;

function rasteriseGlyph(scale) {
  const size = GLYPH_SIZE * scale;
  // BGRA, four bytes per pixel, which is what createFromBuffer expects.
  const buffer = Buffer.alloc(size * size * 4, 0);
  for (const bar of BARS) {
    for (let x = bar.x * scale; x < (bar.x + bar.width) * scale; x += 1) {
      for (let y = bar.top * scale; y < GLYPH_BASELINE * scale; y += 1) {
        buffer[(y * size + x) * 4 + 3] = 255;
      }
    }
  }
  return { buffer, size };
}

function guardianIcon() {
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

/* ── Formatting ───────────────────────────────────────────────────────────── */

function gigabytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const value = bytes / 1024 ** 3;
  return `${value.toFixed(value < 10 ? 1 : 0)} GB`;
}

function duration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const value = Math.max(0, Math.round(seconds));
  if (value < 60) return `${value}s`;
  const minutes = Math.round(value / 60);
  return minutes < 60 ? `${minutes}m` : `${(minutes / 60).toFixed(1)}h`;
}

/* ── Tray ─────────────────────────────────────────────────────────────────── */

/**
 * @param {object} options
 * @param {() => Electron.BrowserWindow | null} options.getWindow
 * @param {() => void} [options.onCreateWindow] Recreate the window when macOS has closed it.
 * @param {(...args: unknown[]) => void} [options.log]
 */
function attachGuardianTray({ getWindow, onCreateWindow, log = () => {} }) {
  let tray = null;
  let timer = null;
  let snapshot = null;
  let unloading = false;
  // Rebuilding a context menu while it is open closes it under the cursor, so
  // refreshes are deferred until it is dismissed.
  let menuOpen = false;
  let pendingRebuild = false;
  let guardian = null;

  try {
    tray = new Tray(guardianIcon());
  } catch (error) {
    log("Guardian tray unavailable:", error && error.message ? error.message : String(error));
    return { destroy() {} };
  }

  tray.setToolTip("Teminali Guardian");
  tray.setTitle("…");

  function revealGuardian() {
    let window = getWindow();
    if (!window || window.isDestroyed()) {
      onCreateWindow?.();
      window = getWindow();
    }
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    // The renderer owns the panel store, so it opens the panel; the tray only
    // asks. That keeps one code path for "open Guardian" everywhere.
    window.webContents.send("menu:open-guardian");
  }

  async function unload(model) {
    if (!guardian || unloading) return;
    unloading = true;
    try {
      await guardian.unloadModel(model);
    } catch (error) {
      log("Guardian tray unload failed:", error && error.message ? error.message : String(error));
    } finally {
      unloading = false;
      await refresh();
    }
  }

  function buildMenu() {
    const items = [{ label: "Teminali Guardian", enabled: false }, { type: "separator" }];

    if (!snapshot) {
      items.push({ label: "Reading the machine…", enabled: false });
    } else {
      const resident = snapshot.ollama?.residentModels ?? [];
      if (!snapshot.ollama?.reachable) {
        items.push({ label: "Ollama is not reachable", enabled: false });
      } else if (resident.length === 0) {
        items.push({ label: "No model resident", enabled: false });
      } else {
        for (const model of resident) {
          items.push({
            label: `${model.name} — ${gigabytes(model.vramBytes)}`,
            submenu: [
              {
                label: `Idle ${model.idleIsLowerBound ? "≥ " : ""}${duration(model.idleSeconds)}`,
                enabled: false,
              },
              {
                label:
                  model.expiresInSeconds !== null
                    ? `Ollama unloads it in ${duration(model.expiresInSeconds)}`
                    : "No expiry reported",
                enabled: false,
              },
              { type: "separator" },
              {
                label: `Unload now — frees ${gigabytes(model.vramBytes)}`,
                enabled: !unloading,
                click: () => void unload(model.name),
              },
            ],
          });
        }
      }

      items.push({ type: "separator" });

      const memory = snapshot.memory ?? {};
      items.push({
        label: `Memory  ${gigabytes(memory.usedBytes)} / ${gigabytes(memory.totalBytes)}${
          memory.usedPercent === null || memory.usedPercent === undefined ? "" : `  (${Math.round(memory.usedPercent)}%)`
        }`,
        enabled: false,
      });
      if (memory.pressure) items.push({ label: `Pressure  ${memory.pressure}`, enabled: false });
      if (snapshot.swap) items.push({ label: `Swap  ${gigabytes(snapshot.swap.usedBytes)}`, enabled: false });
      items.push({
        label: `CPU  ${
          snapshot.cpu && snapshot.cpu.percent !== null ? `${Math.round(snapshot.cpu.percent)}%` : "—"
        }  ·  load ${Number.isFinite(snapshot.load?.[0]) ? snapshot.load[0].toFixed(2) : "—"}`,
        enabled: false,
      });

      // Say what is missing rather than letting the absence read as a zero.
      const first = (snapshot.advice ?? []).find((entry) => entry.severity !== "info");
      if (first) {
        items.push({ type: "separator" }, { label: first.title, enabled: false });
      }
    }

    items.push(
      { type: "separator" },
      { label: "Open Guardian", click: revealGuardian },
      { type: "separator" },
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
      log("Guardian tray menu rebuild failed:", error && error.message ? error.message : String(error));
    }
  }

  /** The title has to survive in a few characters of menu bar, so: count and load. */
  function applyTitle() {
    if (!tray || tray.isDestroyed()) return;
    if (!snapshot) {
      tray.setTitle("…");
      return;
    }
    const used = snapshot.memory?.usedPercent;
    const memory = Number.isFinite(used) ? `${Math.round(used)}%` : "—";
    const count = snapshot.ollama?.reachable ? (snapshot.ollama.residentModels ?? []).length : 0;
    // The count leads only when there is something to count; a standing "0"
    // next to a percentage is noise in a bar that has none to spare.
    tray.setTitle(count > 0 ? `${count} · ${memory}` : memory);

    const lines = [
      `Memory ${gigabytes(snapshot.memory?.usedBytes)} of ${gigabytes(snapshot.memory?.totalBytes)}`,
      snapshot.memory?.pressure ? `Kernel pressure: ${snapshot.memory.pressure}` : null,
      count > 0
        ? `${count} model${count === 1 ? "" : "s"} resident, ${gigabytes(snapshot.ollama.totalVramBytes)} wired`
        : "No model resident",
    ].filter(Boolean);
    tray.setToolTip(`Teminali Guardian\n${lines.join("\n")}`);
  }

  async function refresh() {
    if (!guardian) return;
    try {
      snapshot = await guardian.guardianSnapshot();
      applyTitle();
      applyMenu();
    } catch (error) {
      log("Guardian tray sample failed:", error && error.message ? error.message : String(error));
    }
  }

  // The telemetry module is ESM and this file is CommonJS, so it loads
  // dynamically. A failure here leaves a tray that opens the window and quits —
  // still useful, and far better than no app.
  const modulePath = pathToFileURL(path.join(__dirname, "..", "server", "guardian.js")).href;
  import(modulePath)
    .then((module) => {
      guardian = module;
      void refresh();
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    })
    .catch((error) => {
      log("Guardian telemetry module unavailable:", error && error.message ? error.message : String(error));
      applyMenu();
    });

  tray.on("double-click", revealGuardian);
  applyMenu();

  function destroy() {
    if (timer) clearInterval(timer);
    timer = null;
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  }

  // Without this the interval keeps the process alive past the last window.
  app.on("before-quit", destroy);

  return { destroy, refresh };
}

module.exports = { attachGuardianTray, guardianIcon };
