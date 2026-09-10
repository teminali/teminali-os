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
