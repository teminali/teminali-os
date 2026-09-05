const { BrowserWindow, screen } = require("electron");

/** How long a bubble may go without a fresh state before it hides itself. */
const STALE_AFTER_MS = 45_000;
/** How often the drawn cursor catches up with the real one. ~60fps. */
const CURSOR_POLL_MS = 16;
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
  /**
   * Whether one of our own windows is in front. The overlay exists to point at
   * *other* applications; drawn over Teminali Code itself it covers the thing
   * the operator is already looking at, so it stands down until they leave.
   */
  let appFocused = false;
  /*
    A turn that ends without a final state — the assistant errored, the CLI died,
    the renderer went away — used to leave the last bubble on screen forever. The
    window is click-through, unfocusable and `closable: false`, so the operator
    has no way to dismiss it: it outlives the editor and survives closing every
    window. Guidance nobody refreshed for this long is stale, and a stale bubble
    is worse than none.
  */
  let expiry = null;
  /** Put away by hand. Survives new messages until it is brought back. */
  let minimized = false;
  /**
   * The timer that follows the pointer.
   *
   * The assistant moves the real mouse, and on a large display a 24-pixel
   * system arrow travelling across it is genuinely hard to follow — the
   * operator watches a control get clicked without ever seeing what clicked
   * it. So the overlay draws its own, much larger cursor on top of the real
   * one.
   *
   * `screen.getCursorScreenPoint()` rather than asking the pointer helper:
   * this runs sixty times a second, and the helper is a process spawn. This is
   * an in-process read of something Electron already knows, and it costs
   * nothing worth measuring.
   *
   * It exists only while the overlay is visible. A timer that polls the mouse
   * for the life of the application would be a battery cost paid for a drawing
   * nobody is looking at.
   */
  let cursorTimer = null;
  let lastCursor = null;

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

    window.setIgnoreMouseEvents(true, { forward: true });
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

  /**
   * Reconcile visibility against the three things that decide it: whether there
   * is anything to draw, whether the operator put it away, and whether they are
   * looking at Teminali Code. Kept in one place so no caller can show the
   * overlay while another reason to stay hidden is still true.
   */
  function clearExpiry() {
    if (expiry) clearTimeout(expiry);
    expiry = null;
  }

  function scheduleExpiry() {
    clearExpiry();
    expiry = setTimeout(() => {
      log("Assistant overlay went stale; hiding it.");
      hide();
    }, STALE_AFTER_MS);
    // Never hold the event loop open on the overlay's behalf.
    if (typeof expiry.unref === "function") expiry.unref();
  }

  function stopFollowingCursor() {
    if (cursorTimer) clearInterval(cursorTimer);
    cursorTimer = null;
    lastCursor = null;
  }

  function followCursor() {
    if (cursorTimer) return;
    cursorTimer = setInterval(() => {
      if (!window || window.isDestroyed() || !window.isVisible()) return;
      let point;
      try {
        point = screen.getCursorScreenPoint();
      } catch {
        return;
      }
      // Only when it actually moved. A still pointer would otherwise send
      // sixty identical messages a second across the context bridge.
      if (lastCursor && lastCursor.x === point.x && lastCursor.y === point.y) return;
      lastCursor = point;
      window.webContents.send("assistant:overlay-cursor", point);
    }, CURSOR_POLL_MS);
    // Never hold the event loop open just to draw a cursor.
    if (typeof cursorTimer.unref === "function") cursorTimer.unref();
  }

  function apply() {
    if (!window || window.isDestroyed()) return;
    const wanted = Boolean(lastState) && !minimized && !appFocused;
    if (wanted) {
      // showInactive, never show: the overlay must not become the key window.
      if (!window.isVisible()) window.showInactive();
      followCursor();
    } else {
      stopFollowingCursor();
      if (window.isVisible()) window.hide();
    }
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
    apply();
    scheduleExpiry();
  }

  function hide() {
    lastState = null;
    clearExpiry();
    stopFollowingCursor();
    if (!window || window.isDestroyed()) return;
    window.webContents.send("assistant:overlay-state", { visible: false });
    window.hide();
  }

  function destroy() {
    clearExpiry();
    stopFollowingCursor();
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
    window = null;
  }

  /** Follow the operator between applications. */
  function setAppFocused(value) {
    const next = Boolean(value);
    if (next === appFocused) return;
    appFocused = next;
    apply();
  }

  /** Put the overlay away, or bring it back. Returns the state it landed in. */
  function setMinimized(value) {
    minimized = Boolean(value);
    apply();
    return minimized;
  }

  function isMinimized() {
    return minimized;
  }

  /** What the overlay page pulls on mount, closing the first-paint race. */
  function getState() {
    return lastState ?? { visible: false };
  }

  function setInteractive(capture) {
    if (!window || window.isDestroyed()) return;
    window.setIgnoreMouseEvents(!capture, { forward: true });
  }

  return { show, hide, destroy, getState, setAppFocused, setMinimized, isMinimized, setInteractive };
}

module.exports = { attachAssistantOverlay };
