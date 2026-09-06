/* ═══════════════════════════════════════════════════════════════════
   Real clicks, scrolls and keystrokes — the ones that happen in OTHER
   applications while a take is running.

   Electron cannot see them. `screen.getCursorScreenPoint()` reports
   where the pointer is and nothing about what the user did with it, so
   the recorder's baseline signal is a cursor track and an inference:
   the pointer travelled, then it stopped, so something there mattered.
   That inference is good enough to place a zoom and it is not a click.

   `uiohook-napi` — a prebuilt N-API binding over libuiohook — can see
   the real thing. It is an OPTIONAL dependency and is deliberately not
   in this app's dependency list yet, so this module's normal answer is
   "not installed" and the recorder falls back to cursor-only. Adding it
   is one `npm install` away and nothing else here changes.

   Three things worth stating plainly:

   1. **`require`, in a try, at call time.** This is the one dependency
      whose absence has to be survivable at runtime. A machine where the
      prebuilt binary will not load throws here and nowhere else.

   2. **It does NOT use the hook's coordinates.** libuiohook reports
      screen coordinates in its own space, which on a Retina Mac with
      mixed scale factors is not the space the cursor track is in. The
      hook is asked only WHEN and WHAT; WHERE always comes from
      `getCursorScreenPoint()` against the captured display's bounds, so
      a click and the cursor sample it is merged with cannot disagree.

   3. **`mousedown`, not `click`.** The moment a zoom should be arriving
      at is when the button goes down — that is when the thing being
      clicked matters. A click event fires on release, which on a drag
      is somewhere else entirely.
   ═══════════════════════════════════════════════════════════════════ */

const { screen } = require("electron");

/**
 * @typedef {'click'|'rightclick'|'scroll'|'key'} InputKind
 *
 * @typedef {object} InputEvent
 * @property {number} tMs   Milliseconds into the recording, paused time removed.
 * @property {InputKind} kind
 * @property {number} x     Normalised against the captured display — the cursor track's space.
 * @property {number} y
 *
 * @typedef {object} InputCaptureStatus
 * @property {boolean} ok
 * @property {'events'|'cursor-only'} source
 * @property {'ready'|'not-installed'|'needs-accessibility'|'failed'} reason
 * @property {string} message  One sentence, written for the person reading the panel.
 */

/* ── Loading the module ─────────────────────────────────────────── */

let cached;

function load() {
  if (cached !== undefined) return cached;
  try {
    const mod = require("uiohook-napi");
    cached = mod.uIOhook ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Whether the binding is present at all, without starting it. */
function inputCaptureAvailable() {
  return load() !== null;
}

/* ── Capture ────────────────────────────────────────────────────── */

let running = false;

const READY = {
  ok: true,
  source: "events",
  reason: "ready",
  message: "Zooms are placed on real clicks, scrolls and typing.",
};

const UNAVAILABLE = {
  ok: false,
  source: "cursor-only",
  reason: "not-installed",
  message:
    "Real click capture is not available in this build, so zooms are placed from where the "
    + "pointer travelled to and stopped.",
};

const NEEDS_ACCESSIBILITY = {
  ok: false,
  source: "cursor-only",
  reason: "needs-accessibility",
  message:
    "macOS has not allowed Teminali OS to see input from other apps, so zooms are placed from "
    + "where the pointer travelled to and stopped. Turn Teminali OS on under Privacy & Security, "
    + "Accessibility, then relaunch it for zooms on real clicks.",
};

/**
 * Start listening, and hand back a stop function whatever happens.
 *
 * `now()` is supplied by the caller rather than read here, because the
 * only correct clock is the recording's — the one the cursor track is
 * already stamped with, with paused time removed. Two clocks would put
 * clicks and cursor positions on different timelines, and the zoom
 * would land next to the thing it was aimed at.
 *
 * @param {() => number} now
 * @param {() => Electron.Rectangle | null} bounds
 * @param {(event: InputEvent) => void} push
 * @returns {{status: InputCaptureStatus, stop: () => void}}
 */
function startInputCapture(now, bounds, push) {
  const hook = load();
  if (!hook) return { status: UNAVAILABLE, stop: () => undefined };

  const locate = () => {
    const area = bounds();
    if (!area) return null;
    const point = screen.getCursorScreenPoint();
    return {
      x: (point.x - area.x) / area.width,
      y: (point.y - area.y) / area.height,
    };
  };

  const record = (kind) => {
    const at = locate();
    if (!at) return;
    push({ tMs: now(), kind, x: at.x, y: at.y });
  };

  hook.on("mousedown", (event) => record(event.button === 1 ? "click" : "rightclick"));
  hook.on("wheel", () => record("scroll"));
  hook.on("keydown", () => record("key"));

  try {
    hook.start();
    running = true;
  } catch (err) {
    hook.removeAllListeners();
    const code = err && err.code;
    return {
      status:
        code === "UIOHOOK_ERROR_AXAPI_DISABLED"
          ? NEEDS_ACCESSIBILITY
          : {
            ok: false,
            source: "cursor-only",
            reason: "failed",
            message:
                "Input capture could not start, so zooms are placed from where the pointer "
                + `travelled to and stopped. (${(err && err.message) || "unknown error"})`,
          },
      stop: () => undefined,
    };
  }

  return {
    status: READY,
    stop: () => {
      if (!running) return;
      running = false;
      try {
        hook.stop();
      } catch {
        /* already stopped */
      }
      hook.removeAllListeners();
    },
  };
}

/**
 * What the recorder can promise BEFORE a take starts.
 *
 * Deliberately does not start the hook to find out. On macOS starting it
 * without permission is what triggers the system's own prompt, and a
 * prompt that appears when somebody opens a settings panel — rather than
 * when they press record — is the kind of thing people click Deny on.
 *
 * @returns {InputCaptureStatus}
 */
function probeInputCapture() {
  if (!load()) return UNAVAILABLE;
  if (process.platform !== "darwin") return READY;
  // `isTrustedAccessibilityClient(false)` answers without prompting,
  // which is exactly what is wanted here.
  const { systemPreferences } = require("electron");
  return systemPreferences.isTrustedAccessibilityClient(false) ? READY : NEEDS_ACCESSIBILITY;
}

/** Never leave a system-wide hook running past a quit. */
function shutdownInputCapture() {
  if (!running) return;
  running = false;
  const hook = load();
  try {
    if (hook) hook.stop();
  } catch {
    /* nothing to stop */
  }
  if (hook) hook.removeAllListeners();
}

module.exports = {
  inputCaptureAvailable,
  startInputCapture,
  probeInputCapture,
  shutdownInputCapture,
};
