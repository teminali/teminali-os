/*
  The recorder dialog's setup surface, and the dialog close control.

  These are source assertions rather than render assertions, in the shape
  `recorder-bridge.test.mjs` already uses: what they guard is that three
  files agree with each other, and each of the three was individually
  correct while the agreement was broken.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts) => readFileSync(join(here, "..", "src", ...parts), "utf8");
const electronFile = (name) => readFileSync(join(here, "..", "electron", name), "utf8");
const recorder = (name) => src("video", "components", "recorder", name);

/* ── The rail is tabbed, and the footer can reach every tab ──────── */

test("the options rail is three tabs, so Live is never scrolled to", () => {
  const options = recorder("CaptureOptions.tsx");
  assert.match(options, /export type RailTab = 'capture' \| 'live' \| 'edit'/);
  for (const label of ["Capture", "Live", "Auto edit"]) {
    assert.match(options, new RegExp(`label="${label}"`));
  }
});

test("the panel owns the rail's tab, because the footer's chips are doors into it", () => {
  const panel = recorder("RecorderPanel.tsx");
  assert.match(panel, /useState<RailTab>\('capture'\)/);
  /* A summon on the way, or the tab it was sent to is behind a closed sheet. */
  assert.match(panel, /const reveal = React\.useCallback[\s\S]{0,220}setOptionsOpen\(true\)/);
  assert.match(panel, /onReveal=\{reveal\}/);
  assert.match(panel, /onClick=\{\(\) => onReveal\('live'\)\}/);
});

/* ── An armed stream with no key never reaches ffmpeg ────────────── */

test("liveReadiness gates the start button rather than letting the take fail", () => {
  const options = recorder("CaptureOptions.tsx");
  assert.match(options, /export function liveReadiness/);
  /* A custom endpoint may carry its key in the path; the presets never do. */
  assert.match(options, /settings\.liveService !== 'custom' && !settings\.liveStreamKey\.trim\(\)/);

  const panel = recorder("RecorderPanel.tsx");
  assert.match(panel, /const live = liveReadiness\(store\.settings\)/);
  assert.match(panel, /disabled=\{!selected \|\| !live\.ok\}/);
});

/* ── One camera stream, on the stage ─────────────────────────────── */

test("the camera is previewed once, where the build will actually put it", () => {
  const stage = recorder("CaptureStage.tsx");
  assert.match(stage, /previewCamera/);
  assert.match(stage, /cameraSizePct/);
  assert.match(stage, /onChange\('cameraCorner', corner\.value\)/);

  /* The rail used to run a second `getUserMedia` on the same device for a
     288px thumbnail that could not answer the question it was asked. */
  const options = recorder("CaptureOptions.tsx");
  assert.doesNotMatch(options, /previewCamera/);
});

test("the source picker is a strip with a filter, not a grid that scrolls", () => {
  const grid = recorder("SourceGrid.tsx");
  assert.match(grid, /overflow-x-auto/);
  assert.match(grid, /Find a window/);
  assert.match(grid, /ArrowRight/);
  assert.match(grid, /ArrowLeft/);
});

/* ── Every dialog closes in the dialect the operator chose ───────── */

test("no dialog hard-codes the macOS close disc", () => {
  const primitives = src("components", "ui", "Primitives.tsx");
  assert.match(primitives, /export const DialogCloseButton/);
  assert.match(primitives, /export const useChromeStyle/);
  /* All three dialects, or the setting only changes two thirds of the app. */
  assert.match(primitives, /dialect === "macos"/);
  assert.match(primitives, /dialect === "windows"/);
  assert.match(primitives, /chrome-gnome-btn/);

  const roots = [
    ["components", "ui", "Modal.tsx"],
    ["components", "github", "GitHubModal.tsx"],
    ["components", "modals", "GeminiKeyModal.tsx"],
    ["components", "diff", "DiffInspectorModal.tsx"],
    ["App.tsx"],
  ];
  for (const parts of roots) {
    const file = src(...parts);
    assert.doesNotMatch(
      file,
      /<MacCloseButton/,
      `${parts.join("/")} still draws a macOS disc regardless of the chrome setting`,
    );
  }
});

test("MacCloseButton is reached only through the dialect switch", () => {
  /* It still exists — it IS the macOS dialect — but a call site that names
     it directly is a call site the setting cannot reach. */
  const uiDir = join(here, "..", "src", "components", "ui");
  const offenders = readdirSync(uiDir)
    .filter((name) => name.endsWith(".tsx") && name !== "Primitives.tsx")
    .filter((name) => /<MacCloseButton/.test(readFileSync(join(uiDir, name), "utf8")));
  assert.deepEqual(offenders, []);
});

/* ── A finished take always finds a surface ──────────────────────── */

/*
  Reported from the running app: record Teminali OS's own window, close
  the dialog (which is supported — the floating bar is the control while
  the main window is hidden), stop from the bar, and the take is "gone,
  not saved anywhere".

  Two independent faults, and neither loses a byte on disk.
*/

test("recorderStore no longer carries a visibility flag nothing reads", () => {
  const store = src("video", "store", "recorderStore.ts");
  /*
    `stop()` used to `set({ isOpen: true })` to bring the recorder back so
    the review could be seen. That worked while the recorder was a
    workspace panel. It became a dialog, visibility moved to
    `store/recorderDialogStore`, and nothing has read this flag since — so
    a take stopped from the bar with the dialog shut finished into a
    `review` phase no mounted component was rendering.
  */
  assert.doesNotMatch(store, /^\s*isOpen: boolean;/m, "the dead flag is back");
  assert.doesNotMatch(store, /set\(\{[^}]*isOpen: true/, "something still writes it");

  const panel = src("video", "components", "recorder", "RecorderPanel.tsx");
  assert.doesNotMatch(panel, /setState\(\{ isOpen: true \}\)/);
});

test("the shell reopens the dialog when a take reaches a phase with something to show", () => {
  const app = src("App.tsx");
  assert.match(app, /useRecorderStore\.subscribe/);
  /* `processing` too, so a slow remux shows its progress bar rather than
     appearing only at the end. */
  assert.match(app, /phase === "processing" \|\| phase === "review" \|\| phase === "error"/);
  assert.match(app, /if \(!useRecorderDialogStore\.getState\(\)\.isOpen\) openRecorder\(\)/);

  /* It lives in the shell rather than in the store because everything
     under `src/video/` is workspace-agnostic and the dialog's store is
     app-side. A reach the other way would be that boundary's first
     exception. */
  const store = src("video", "store", "recorderStore.ts");
  assert.doesNotMatch(
    store,
    /^import .*recorderDialogStore/m,
    "src/video/ must not import the shell's dialog store",
  );
});

/* ── Never hide the window being recorded ───────────────────────── */

test("main tags its own window, because only main can identify it", () => {
  const recorderMain = electronFile("screenRecorder.cjs");
  assert.match(recorderMain, /function mainWindowSourceId/);
  assert.match(recorderMain, /getMediaSourceId/);
  assert.match(recorderMain, /isSelf: Boolean\(selfSourceId\) && source\.id === selfSourceId/);

  const types = src("types", "recorder.ts");
  assert.match(types, /isSelf\?: boolean;/);
});

test("hideWindow cannot hide the subject of the capture", () => {
  /*
    `hideWindow` keeps Teminali OS out of a capture of the DISPLAY. Point
    the recorder at Teminali OS's own window and the same switch hides
    what is being filmed: macOS delivers no frames for an ordered-out
    window, so the take records nothing, the file is empty, and the remux
    fails on it.
  */
  const recorderMain = electronFile("screenRecorder.cjs");
  assert.match(recorderMain, /const recordingOurselves = Boolean\(selfId\) && p\.sourceId === selfId;/);
  assert.match(recorderMain, /if \(p\.hideWindow && !recordingOurselves\)/);

  // Main can only make that comparison if the renderer sends the source.
  const capture = src("video", "engine", "screenCapture.ts");
  assert.match(capture, /sourceId: settings\.sourceId,/);
  const types = src("types", "recorder.ts");
  assert.match(types, /sourceId: string;/);
});

test("the switch says why it cannot apply, rather than doing nothing quietly", () => {
  const options = src("video", "components", "recorder", "CaptureOptions.tsx");
  assert.match(options, /disabled=\{recordingSelf\}/);
  assert.match(options, /Not while Teminali OS is what you are recording/);
  // And it reads as off, not as on-but-ignored.
  assert.match(options, /checked=\{settings\.hideWindow && !recordingSelf\}/);

  // `ToggleRow` is the shared control, so the capability went there.
  const controls = src("video", "components", "ui", "Controls.tsx");
  assert.match(controls, /disabled\?: boolean;/);
  assert.match(controls, /disabled=\{disabled\}/);
});
