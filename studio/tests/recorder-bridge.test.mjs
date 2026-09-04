/*
  The recorder's wiring, asserted end to end across three files.

  This guard exists because every one of those files was correct on its own
  and the feature was still dead: `screenRecorder.cjs` registered fifteen
  `recorder:*` handlers, `src/types/recorder.ts` described them, the panel
  called them — and nothing in `main.cjs` ever required the module, while
  `preload.cjs` never put a `recorder` key on `window.teminali`. The renderer's
  `bridge()` therefore returned undefined in the packaged app exactly as it
  does in a browser, so the recorder fell back to its one synthetic source and
  reported "Displays (1), Windows (0)" on a machine full of windows.

  Nothing that reads a single file can catch that. These tests read all three
  and assert they agree.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const electron = (name) => readFileSync(join(here, "..", "electron", name), "utf8");

const recorderSource = electron("screenRecorder.cjs");
const preloadSource = electron("preload.cjs");
const mainSource = electron("main.cjs");
const src = (...parts) => readFileSync(join(here, "..", "src", ...parts), "utf8");
const captureSource = src("video", "engine", "screenCapture.ts");
const storeSource = src("video", "store", "recorderStore.ts");

const matchAll = (text, pattern) => [...text.matchAll(pattern)].map((m) => m[1]);

/** Channels the main process answers. */
const handled = new Set(matchAll(recorderSource, /ipcMain\.handle\("(recorder:[\w-]+)"/g));
/** Channels the preload calls, and the pushes it subscribes to. */
const invoked = new Set(matchAll(preloadSource, /ipcRenderer\.invoke\("(recorder:[\w-]+)"/g));
const subscribed = new Set(matchAll(preloadSource, /ipcRenderer\.on\("(recorder:[\w-]+)"/g));
/** Channels the main process pushes at a renderer. */
const pushed = new Set(matchAll(recorderSource, /webContents\.send\("(recorder:[\w-]+)"/g));

test("every recorder handler is reachable from the renderer", () => {
  assert.ok(handled.size >= 15, `expected the recorder's handlers, found ${handled.size}`);
  const unreachable = [...handled].filter((channel) => !invoked.has(channel));
  assert.deepEqual(unreachable, [], `no preload verb invokes: ${unreachable.join(", ")}`);
});

test("the preload invokes no channel the main process does not answer", () => {
  const unanswered = [...invoked].filter((channel) => !handled.has(channel));
  assert.deepEqual(unanswered, [], `no handler answers: ${unanswered.join(", ")}`);
});

test("every push the main process makes has a listener", () => {
  assert.ok(pushed.size >= 2, `expected the command and state pushes, found ${pushed.size}`);
  const unheard = [...pushed].filter((channel) => !subscribed.has(channel));
  assert.deepEqual(unheard, [], `nothing in the preload listens for: ${unheard.join(", ")}`);
});

test("main requires the recorder and both starts and stops it", () => {
  assert.match(
    mainSource,
    /require\("\.\/screenRecorder\.cjs"\)/,
    "main.cjs does not require screenRecorder.cjs, so its handlers are never registered",
  );
  assert.match(mainSource, /initScreenRecorder\(/, "main.cjs never calls initScreenRecorder");
  assert.match(mainSource, /shutdownScreenRecorder\(/, "main.cjs never calls shutdownScreenRecorder");
});

test("the preload publishes the recorder on window.teminali", () => {
  // `bridge()` in screenCapture.ts reads exactly this key; without it the
  // renderer cannot tell the packaged app from a browser tab.
  assert.match(preloadSource, /^\s{2}recorder: \{/m, "no `recorder` key is exposed on window.teminali");
});

test("the typed bridge names every verb the preload exposes", () => {
  const contract = readFileSync(join(here, "..", "src", "types", "recorder.ts"), "utf8");
  const body = preloadSource.slice(preloadSource.indexOf("\n  recorder: {"));
  const verbs = new Set(matchAll(body.slice(0, body.indexOf("\n  },")), /^\s{4}(\w+):/gm));
  assert.ok(verbs.size >= 15, `expected the recorder's verbs, found ${verbs.size}`);
  const untyped = [...verbs].filter((verb) => !new RegExp(`^\\s{2}${verb}:`, "m").test(contract));
  assert.deepEqual(untyped, [], `RecorderBridge does not declare: ${untyped.join(", ")}`);
});

/* ── The stop that never returns ──────────────────────────────────── */

/*
  Reported from the running app: the recorder stopped recording at all, and
  every attempt answered "This take is already being finished" on a screen
  headed "The recording did not start". One wedged session explains all of
  it — `stopCapture` marks the session `finishing` before it awaits the
  recorders, and only reaches `session = null` after. Miss that line once
  and `isRecording()` stays true for the life of the page, so the toggle
  routes every later press to stop and start refuses outright.
*/

test("a recorder that never answers stop does not strand the session", () => {
  // No timeout here is the whole bug: `onstop` never fires for a recorder
  // whose source track has already ended.
  assert.match(captureSource, /const STOP_TIMEOUT_MS = \d+;/);
  assert.match(captureSource, /window\.setTimeout\(done, STOP_TIMEOUT_MS\)/);
  assert.match(captureSource, /entry\.recorder\.onstop = done;/);
});

test("a stop that throws is a stop that finished", () => {
  // `stop()` on a recorder the browser already tore down throws, and the
  // throw was inside the promise executor — it rejected the await instead.
  assert.match(captureSource, /try \{\s*\n\s*entry\.recorder\.stop\(\);\s*\n\s*\} catch \{\s*\n\s*done\(\);/);
  assert.match(captureSource, /let settled = false;/);
});

test("a throw out of the stop path gives the session back", () => {
  // The other door onto the same wedge, and `false` keeps the files: a
  // failed finish must not also delete what was recorded.
  assert.match(storeSource, /await cancelCapture\(false\)\.catch/);
});
