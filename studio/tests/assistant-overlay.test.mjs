/**
 * The assistant overlay's visibility rules, under plain Node.
 *
 * This module used to be the one part of the shell with no coverage at all, and
 * it is where the undismissable bubble came from: the overlay is deliberately
 * click-through, unfocusable and `closable: false`, so if it decides to stay on
 * screen the operator has no way to argue. Every rule that can pin it there is
 * therefore pinned down here instead.
 *
 * Electron cannot run in the test process, so `require("electron")` is answered
 * with a stand-in that records what the real window would have been told. That
 * is enough: the decisions under test are all made in this module, and the only
 * thing it asks of a window is show, hide and send.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const Module = require_("node:module");
const OVERLAY = "../electron/assistant-overlay.cjs";

/* ── Harness ──────────────────────────────────────────────────────────────── */

function fakeElectron() {
  const display = { bounds: { x: 0, y: 0, width: 1440, height: 900 } };
  const windows = [];

  class FakeWindow {
    constructor(options) {
      this.bounds = {
        x: options.x, y: options.y, width: options.width, height: options.height,
      };
      this.visible = false;
      this.destroyed = false;
      this.sent = [];
      windows.push(this);
      this.webContents = {
        on: () => {},
        send: (channel, payload) => this.sent.push({ channel, payload }),
      };
    }

    isDestroyed() { return this.destroyed; }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    on() {}
    getBounds() { return { ...this.bounds }; }
    setBounds(next) { this.bounds = { ...next }; }
    isVisible() { return this.visible && !this.destroyed; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.visible = false; }

    // The overlay must never become the key window: a heads-up display that
    // takes focus steals the keyboard from whatever it is pointing at.
    show() { throw new Error("show() would focus the overlay; use showInactive()"); }
  }

  return {
    BrowserWindow: FakeWindow,
    screen: {
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: () => display,
    },
    windows,
  };
}

/** Load the module fresh against a stand-in Electron. */
function loadOverlay(electron) {
  const realLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electron;
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    delete require_.cache[require_.resolve(OVERLAY)];
    return require_(OVERLAY).attachAssistantOverlay;
  } finally {
    Module._load = realLoad;
  }
}

function attach() {
  const electron = fakeElectron();
  const overlay = loadOverlay(electron)({ devUrl: null, indexPath: "/dist/index.html" });
  return { overlay, electron, window: () => electron.windows.at(-1) };
}

/** A turn of guidance, shaped the way the assistant sends it. */
function guidance(label = "Click Continue") {
  return { label, target: { frame: { x: 120, y: 240, width: 180, height: 44 } } };
}

/** The bubble is only really on screen when the app is not in front. */
function raise(overlay, state = guidance()) {
  overlay.setAppFocused(false);
  overlay.show(state);
}

/* ── Tests ────────────────────────────────────────────────────────────────── */

test("a bubble nobody refreshed puts itself away", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { overlay, window } = attach();

  raise(overlay);
  assert.equal(window().isVisible(), true, "guidance should be on screen");

  t.mock.timers.tick(44_000);
  assert.equal(window().isVisible(), true, "still fresh enough to trust");

  t.mock.timers.tick(2_000);
  assert.equal(window().isVisible(), false, "45s without a new state is stale");
});

test("an expired bubble does not come back when the operator leaves the app", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { overlay, window } = attach();

  raise(overlay);
  t.mock.timers.tick(46_000);
  assert.equal(window().isVisible(), false);

  // The bug: expiry hid the window but left the state behind, so the next
  // time the operator switched away the overlay decided it had something to
  // draw and showed the same dead bubble again.
  overlay.setAppFocused(true);
  overlay.setAppFocused(false);
  assert.equal(window().isVisible(), false, "nothing left to draw");
  assert.deepEqual(overlay.getState(), { visible: false });
});

test("a fresh state restarts the clock", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { overlay, window } = attach();

  raise(overlay);
  t.mock.timers.tick(30_000);
  overlay.show(guidance("Now click Save"));

  t.mock.timers.tick(30_000);
  assert.equal(window().isVisible(), true, "60s old, but only 30s since the last state");

  t.mock.timers.tick(16_000);
  assert.equal(window().isVisible(), false);
});

test("hiding is total, so closing the editor takes the bubble with it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { overlay, window } = attach();

  raise(overlay);
  // What main.cjs calls from the main window's "closed" handler. macOS keeps
  // the process alive after the last window goes, and an unfocused app is
  // exactly the condition that shows the overlay.
  overlay.hide();

  assert.equal(window().isVisible(), false);
  assert.deepEqual(overlay.getState(), { visible: false });
  assert.deepEqual(
    window().sent.at(-1),
    { channel: "assistant:overlay-state", payload: { visible: false } },
    "the page is told to stop drawing, not just covered up",
  );

  // And no timer survives to reason about a window that is gone.
  t.mock.timers.tick(60_000);
  assert.equal(window().isVisible(), false);
});

test("the overlay stands down while Teminali Code is in front", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { overlay, window } = attach();

  overlay.setAppFocused(true);
  overlay.show(guidance());
  assert.equal(window().isVisible(), false, "never drawn over the app it points away from");

  overlay.setAppFocused(false);
  assert.equal(window().isVisible(), true);
});

test("a bubble put away by hand stays away until it is brought back", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { overlay, window } = attach();

  raise(overlay);
  assert.equal(overlay.setMinimized(true), true);
  assert.equal(window().isVisible(), false);

  overlay.show(guidance("Another step"));
  assert.equal(window().isVisible(), false, "new guidance must not undo a minimise");

  overlay.setMinimized(false);
  assert.equal(window().isVisible(), true);
});
