const { BrowserWindow, screen } = require("electron");
const path = require("path");

/**
 * The transparent layer the assistant draws on.
 *
 * A window rather than anything drawn inside the studio, because the whole
 * point is to point at something in another application. It covers a display,
 * ignores every mouse event, never takes focus, and floats above full-screen
 * windows — four properties that together make it a heads-up display rather
 * than a window that gets in the way.
 *
 * It loads the same bundle as the studio with `?surface=overlay`, so the thing
 * being drawn is ordinary React using the ordinary token sheet. A hand-written
 * HTML file here would have needed its own copy of every colour, and a copy of
 * the token sheet is a copy that drifts.
 *
 * Everything is guarded: a platform that cannot do transparent windows must
 * lose the drawing and keep the assistant, never the other way round.
 */

function overlayUrl(devUrl, indexPath) {
  if (devUrl) return `${devUrl}?surface=overlay`;
  return { path: indexPath, query: { surface: "overlay" } };
}

function attachAssistantOverlay({ devUrl, indexPath, log = () => {} }) {
  let window = null;
  /** The display the window currently covers, so frames can be made relative. */
  let origin = { x: 0, y: 0 };
  let lastState = null;

  function targetDisplay(point) {
    try {
      return point ? screen.getDisplayNearestPoint(point) : screen.getPrimaryDisplay();
    } catch {
      return null;
    }
  }

  function ensure(display) {
    if (window && !window.isDestroyed()) return window;
    try {
      window = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        transparent: true,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: false,
        skipTaskbar: true,
        // Never takes the keyboard. The operator is talking to the assistant,
        // not to this window, and stealing focus would break whatever they were
        // in the middle of.
        focusable: false,
        // A macOS panel floats above full-screen applications; an ordinary
        // window does not, which would put the guidance behind the thing it is
        // pointing at exactly when it matters most.
        type: process.platform === "darwin" ? "panel" : undefined,
        show: false,
        // macOS clamps a window's bounds to the visible frame — below the menu
        // bar — unless this is set. Without it the overlay starts 34 px down
        // and every ring is drawn 34 px below the control it is pointing at.
        enableLargerThanScreen: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
    } catch (error) {
      log("Assistant overlay unavailable:", error && error.message ? error.message : String(error));
      window = null;
      return null;
    }

    window.setIgnoreMouseEvents(true, { forward: false });
    window.setAlwaysOnTop(true, "screen-saver");
    try {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* Not every platform has spaces. */
    }

    const target = overlayUrl(devUrl, indexPath);
    const load = typeof target === "string"
      ? window.loadURL(target)
      : window.loadFile(target.path, { query: target.query });
    load.catch((error) => log("Assistant overlay failed to load:", error.message));

    // The page pulls the state on mount (see `getState` below), so this is a
    // second chance rather than the only one: it covers a reload, where the
    // window already exists and nothing new is being pushed.
    window.webContents.on("did-finish-load", () => {
      if (lastState) window.webContents.send("assistant:overlay-state", lastState);
    });

    window.on("closed", () => {
      window = null;
    });
    return window;
  }

  function show(state) {
    const display = targetDisplay(
      state && state.target
        ? { x: Math.round(state.target.frame.x), y: Math.round(state.target.frame.y) }
        : null,
    );
    if (!display) return;

    const overlay = ensure(display);
    if (!overlay) return;

    // Follow the element onto whichever display it is on.
    const current = overlay.getBounds();
    if (
      current.x !== display.bounds.x
      || current.y !== display.bounds.y
      || current.width !== display.bounds.width
      || current.height !== display.bounds.height
    ) {
      overlay.setBounds(display.bounds);
    }

    // Read the origin back from the window rather than assuming the display's.
    // If the platform clamped the bounds anyway, the drawing is still correct —
    // it is offset by whatever the window actually got, not by what we asked
    // for. A ring in the wrong place is worse than no ring.
    origin = { x: overlay.getBounds().x, y: overlay.getBounds().y };

    lastState = { ...state, visible: true, origin };
    overlay.webContents.send("assistant:overlay-state", lastState);
    // showInactive, never show: the overlay must not become the key window.
    if (!overlay.isVisible()) overlay.showInactive();
  }

  function hide() {
    lastState = null;
    if (!window || window.isDestroyed()) return;
    window.webContents.send("assistant:overlay-state", { visible: false });
    window.hide();
  }

  function destroy() {
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
    window = null;
  }

  /** What the overlay page pulls on mount, closing the first-paint race. */
  function getState() {
    return lastState ?? { visible: false };
  }

  return { show, hide, destroy, getState };
}

module.exports = { attachAssistantOverlay };
