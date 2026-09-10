/*
  What a preview frame is allowed to cost.

  Every assertion here stands for a measured number rather than a taste.
  The measurements were taken on an M4 Pro through CDP against the
  production build, drawing one preview frame of the shape a screen
  recording produces — backdrop, screen, cursor, camera, grade — and
  sustaining it in a rAF loop:

      2560x1662, motion blur x4      42.9 fps
      2560x1662, blur accumulator off  120.7 fps
      1600x1040, motion blur x4       38.3 fps   (i.e. resolution was NOT the cost)

  An M4 Pro is not the machine the freezing was reported on. The point of
  the numbers is the RATIO: whatever the machine, the accumulator is
  roughly three frames' work for one frame's picture, and on a laptop
  iGPU three of those is the difference between a working editor and a
  black webcam.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts) => readFileSync(join(here, "..", "src", ...parts), "utf8");
const electron = (name) => readFileSync(join(here, "..", "electron", name), "utf8");

/* ── The seek storm ─────────────────────────────────────────────── */

/*
  Reimplemented rather than imported: `videoEngine.ts` is a TypeScript
  module that reaches for `document` at load, and the decision under test
  is deliberately a pure function so it can be reasoned about on its own.
  The constant and the two guards are pinned against the source below, so
  this cannot drift away from the thing it claims to test.
*/
const SCRUB_TOLERANCE_S = 1 / 60;
function shouldScrubSeek({ currentTime, requestedTime, target, seeking }) {
  if (seeking) return false;
  if (!Number.isFinite(target)) return false;
  if (Math.abs(currentTime - target) <= SCRUB_TOLERANCE_S) return false;
  if (requestedTime !== null && Math.abs(requestedTime - target) < SCRUB_TOLERANCE_S) return false;
  return true;
}

test("a paused element that landed where it was asked is left alone", () => {
  assert.equal(
    shouldScrubSeek({ currentTime: 4.1, requestedTime: 4.1, target: 4.1, seeking: false }),
    false,
  );
});

test("a long-GOP source that could not land closer is asked exactly once", () => {
  /*
    THE BUG. A screen recording seeks to the nearest decodable frame. Ask
    for 4.100 on a 2s keyframe interval and the element answers 4.400 —
    300ms away, further than any tolerance worth having. The old code
    compared position against the playhead, found it wrong, and re-seeked
    on every tick forever: the element never left `seeking`, the
    compositor never got a new frame, and the camera clip showed black.
  */
  const first = { currentTime: 0, requestedTime: null, target: 4.1, seeking: false };
  assert.equal(shouldScrubSeek(first), true, "the first ask must happen");

  const landedFarAway = { currentTime: 4.4, requestedTime: 4.1, target: 4.1, seeking: false };
  assert.equal(shouldScrubSeek(landedFarAway), false, "the same ask must not be repeated");
});

test("moving the playhead to a genuinely new position still seeks", () => {
  assert.equal(
    shouldScrubSeek({ currentTime: 4.4, requestedTime: 4.1, target: 9.2, seeking: false }),
    true,
  );
});

test("nothing is asked of an element that is already seeking", () => {
  assert.equal(
    shouldScrubSeek({ currentTime: 0, requestedTime: null, target: 4.1, seeking: true }),
    false,
  );
});

test("the tolerance is at least one frame, which is what it was not", () => {
  // 20ms was the old value and it is shorter than a frame at every rate
  // this editor supports, so every landed seek read as a miss.
  assert.ok(SCRUB_TOLERANCE_S >= 1 / 60, "a tolerance under one frame is a seek storm");

  const engine = src("video", "engine", "videoEngine.ts");
  assert.match(engine, /const SCRUB_TOLERANCE_S = 1 \/ 60;/);
  assert.match(engine, /export function shouldScrubSeek/);
  assert.doesNotMatch(
    engine,
    /Math\.abs\(entry\.el\.currentTime - sourceSeconds\) > 0\.02/,
    "the 20ms scrub tolerance is back",
  );
});

/* ── The frame budget ───────────────────────────────────────────── */

test("the preview draws at draft quality and the export does not", () => {
  const compositor = src("video", "engine", "compositor.ts");
  assert.match(compositor, /export type RenderQuality = 'full' \| 'draft'/);
  // Default `full`, so export and frame capture keep what they had by
  // saying nothing at all.
  assert.match(compositor, /quality: RenderQuality = 'full'/);
  assert.match(compositor, /const mb = quality === 'draft' \? null : clip\.motionBlur;/);

  const loop = src("video", "hooks", "useProgramLoop.ts");
  assert.match(loop, /quality = 'draft'/);

  const exporter = src("video", "engine", "exportPipeline.ts");
  assert.doesNotMatch(exporter, /'draft'/, "export must never render a draft");
  const capture = src("video", "engine", "frameCapture.ts");
  assert.doesNotMatch(capture, /'draft'/, "a captured still must never be a draft");
});

test("the preview canvas is sized to the screen, not to the sequence", () => {
  const player = src("video", "components", "preview", "PreviewPlayer.tsx");
  assert.match(player, /width=\{surface\.width\}/);
  assert.match(player, /height=\{surface\.height\}/);
  /* The property, not the expression: the surface is clamped by the
     sequence's own width, so a 720p take is never upscaled into a 4K
     canvas. Pinning the exact arithmetic just breaks on the next floor
     or cap someone adds to it. */
  assert.match(player, /Math\.min\(project\.width,/);
  assert.match(player, /devicePixelRatio/);

  const loop = src("video", "hooks", "useProgramLoop.ts");
  assert.match(loop, /const surfaceW = canvas\.width;/);
  assert.doesNotMatch(
    loop,
    /renderTimelineFrame\([^)]*project\.width/,
    "the preview is back to compositing at sequence resolution",
  );
});

test("the held frame is a stand-in, not a full-resolution copy", () => {
  const engine = src("video", "engine", "videoEngine.ts");
  assert.match(engine, /const HELD_FRAME_MAX_EDGE = 640;/);
  // `timeupdate` fires ~4x/second per element; the held frame is only
  // ever read while seeking, which `onseeked` already covers.
  assert.doesNotMatch(engine, /el\.ontimeupdate\s*=/);
});

test("the scopes read a downsample, not the whole program canvas", () => {
  const player = src("video", "components", "preview", "PreviewPlayer.tsx");
  assert.match(player, /sctx\.drawImage\(source, 0, 0, SAMPLE_W, SAMPLE_H\)/);
  assert.match(player, /getImageData\(0, 0, SAMPLE_W, SAMPLE_H\)/);
  /* Anchored on the receiver, because the comment above the fixed code
     quotes the old call — an assertion that can be tripped by prose is
     not an assertion about the code. */
  assert.doesNotMatch(
    player,
    /sctx\.getImageData\(0, 0, source\.width, source\.height\)/,
    "17MB of readback per scope tick is back",
  );
  // And the program canvas must never be asked for a read-optimised
  // context, which takes it off the GPU for the life of the page.
  assert.doesNotMatch(player, /canvasRef[\s\S]{0,80}willReadFrequently/);
});

/* ── The take owns the machine ──────────────────────────────────── */

test("the programme loop yields while a take is running", () => {
  /*
    `screenRecorder.cjs` turns background throttling off and hides the
    window for the duration of a take, which the capture needs. Every
    other loop in the renderer inherits that, so the expensive one has to
    stand down explicitly.
  */
  const recorder = electron("screenRecorder.cjs");
  assert.match(recorder, /setBackgroundThrottling\(false\)/);

  const player = src("video", "components", "preview", "PreviewPlayer.tsx");
  assert.match(player, /const isCapturing = recorderPhase === 'countdown'/);
  assert.match(player, /active: !isPlayerOpen && !isExporting && !isCapturing/);
});

test("the live compositor renders at the broadcast rate, not at every vsync", () => {
  const capture = src("video", "engine", "screenCapture.ts");
  // captureStream samples at `targetFps`; rendering faster encodes nothing.
  assert.match(capture, /if \(performance\.now\(\) - lastRenderTime >= intervalMs \* 0\.9\) render\(\);/);
});

test("the live compositor is sized to the bitrate the operator chose", () => {
  const capture = src("video", "engine", "screenCapture.ts");
  assert.match(capture, /function broadcastHeightFor/);
  assert.match(capture, /broadcastHeight: broadcastHeightFor\(settings\.live\?\.bitrateKbps\)/);
  assert.doesNotMatch(
    capture,
    /canvas\.width = screenSettings\.width \|\| 1920;/,
    "the broadcast canvas is back to the display's own resolution",
  );
});

test("a chunk is wrapped on arrival in main, not copied", () => {
  const recorder = electron("screenRecorder.cjs");
  assert.match(recorder, /Buffer\.from\(p\.bytes\.buffer, p\.bytes\.byteOffset, p\.bytes\.byteLength\)/);
});
