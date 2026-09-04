/*
  The camera choreography, exercised rather than read.

  Every other recorder test in this directory asserts on SOURCE TEXT,
  because the engine is TypeScript and the runner is `node --test` over
  `.mjs`. That is no longer a constraint: Node strips types on import,
  and `cameraChoreography.ts` was deliberately written to be importable
  under that rule — it pulls in nothing but a type, so importing it does
  not drag the timeline store or the DOM in behind it.

  So these are behaviour tests. They matter more than usual here: both
  detectors are heuristics over noisy input, and a heuristic that is
  only checked by reading it is a heuristic nobody has checked.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts) => join(here, "..", "src", ...parts);

const {
  CAMERA_SHAPES, DEFAULT_DODGE, DEFAULT_EXPLAIN,
  cameraDodges, cameraShapeMask, explainingStretches,
} = await import(src("video", "engine", "cameraChoreography.ts"));

/* ── The shape of the window ────────────────────────────────────── */

test("full leaves the camera uncropped, and says so by disabling the mask", () => {
  const mask = cameraShapeMask("full", { width: 1920, height: 1080 }, 24);
  assert.equal(mask["mask.enabled"], false);
  assert.equal(mask["mask.type"], undefined, "a disabled mask should not also carry a shape");
});

test("a circle over a 16:9 camera is a circle, not an oval", () => {
  const mask = cameraShapeMask("circle", { width: 1920, height: 1080 }, 24);
  assert.equal(mask["mask.type"], "ellipse");
  assert.equal(mask["mask.sizeY"], 100);
  /*
    The whole point. 1080/1920 is 56.25%, so the mask is 56.25% of the
    layer wide and 100% of it tall — which over a 16:9 layer is a square
    region, and an ellipse in a square is a circle. Left at 100/100 this
    renders the oval that every naive circular-webcam implementation
    ships.
  */
  assert.equal(Math.round(mask["mask.sizeX"] * 100) / 100, 56.25);
});

test("a circle over a portrait camera squeezes the other axis", () => {
  const mask = cameraShapeMask("circle", { width: 1080, height: 1920 }, 24);
  assert.equal(mask["mask.sizeX"], 100);
  assert.equal(Math.round(mask["mask.sizeY"] * 100) / 100, 56.25);
});

test("a circle carries no corner radius, because it has no corners", () => {
  assert.equal(cameraShapeMask("circle", { width: 1920, height: 1080 }, 40)["mask.roundness"], 0);
});

test("square keeps the radius and crops to 1:1; rounded keeps the whole frame", () => {
  const square = cameraShapeMask("square", { width: 1920, height: 1080 }, 40);
  assert.equal(square["mask.type"], "rectangle");
  assert.equal(square["mask.roundness"], 40);
  assert.equal(Math.round(square["mask.sizeX"] * 100) / 100, 56.25);

  const rounded = cameraShapeMask("rounded", { width: 1920, height: 1080 }, 40);
  assert.equal(rounded["mask.sizeX"], 100);
  assert.equal(rounded["mask.sizeY"], 100);
  assert.equal(rounded["mask.roundness"], 40);
});

test("a camera that reported a nonsense size is masked square rather than to a sliver", () => {
  const mask = cameraShapeMask("circle", { width: 0, height: 0 }, 10);
  assert.equal(mask["mask.sizeX"], 100);
  assert.equal(mask["mask.sizeY"], 100);
});

test("every shape offered in the UI is one the mask builder handles", () => {
  for (const shape of CAMERA_SHAPES) {
    const mask = cameraShapeMask(shape.id, { width: 1280, height: 720 }, 12);
    assert.equal(typeof mask["mask.enabled"], "boolean", `${shape.id} produced no mask decision`);
  }
});

/* ── Dodging ────────────────────────────────────────────────────── */

/** A pointer parked at one spot, sampled at 30Hz like the real hook. */
const park = (x, y, fromMs, toMs) => {
  const out = [];
  for (let t = fromMs; t <= toMs; t += 33) out.push({ tMs: t, x, y });
  return out;
};

/* A 1920x1080 frame with a 24%-wide inset in the bottom right. */
const INSET = { x: 640, widthPx: 460, heightPx: 258, frameW: 1920, frameH: 1080 };

test("a pointer that never goes near the inset moves it nowhere", () => {
  assert.deepEqual(cameraDodges(park(0.2, 0.5, 0, 20000), INSET), []);
});

test("a pointer parked under the inset sends it to the other side", () => {
  /* 0.83 of the width is inside the inset's guarded zone; 0.5 of the
     height is its centre, because the pose is centre-relative. */
  const moves = cameraDodges(park(0.83, 0.5, 0, 6000), INSET);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].side, "away");
  assert.equal(moves[0].x, -INSET.x, "away is the mirrored offset, not an arbitrary margin");
  assert.ok(moves[0].atMs >= DEFAULT_DODGE.dwellMs, "it moved before the dwell was served");
});

test("a pointer crossing the zone does not move it", () => {
  /* Through and out inside the dwell: three samples, ~100ms. */
  const cursor = [
    ...park(0.2, 0.5, 0, 1000),
    { tMs: 1033, x: 0.83, y: 0.5 },
    { tMs: 1066, x: 0.83, y: 0.5 },
    ...park(0.2, 0.5, 1100, 4000),
  ];
  assert.deepEqual(cameraDodges(cursor, INSET), []);
});

test("it comes home when the zone clears, and only after the longer wait", () => {
  const cursor = [
    ...park(0.83, 0.5, 0, 4000),
    ...park(0.2, 0.5, 4033, 12000),
  ];
  const moves = cameraDodges(cursor, INSET);
  assert.deepEqual(moves.map((m) => m.side), ["away", "home"]);
  assert.equal(moves[1].x, INSET.x);
  assert.ok(
    moves[1].atMs - 4033 >= DEFAULT_DODGE.clearMs,
    "coming home should wait out `clearMs`, not `dwellMs`"
  );
});

test("a pointer flickering in and out cannot make the inset flap", () => {
  const cursor = [];
  for (let t = 0; t < 30000; t += 33) {
    /* A full second in, a full second out — each side of the fence long
       enough to serve the dwell, which is exactly the input that would
       shake a detector with no minimum hold. */
    const inside = Math.floor(t / 1000) % 2 === 0;
    cursor.push({ tMs: t, x: inside ? 0.83 : 0.2, y: 0.5 });
  }
  const moves = cameraDodges(cursor, INSET);
  for (let i = 1; i < moves.length; i++) {
    assert.ok(
      moves[i].atMs - moves[i - 1].atMs >= DEFAULT_DODGE.minHoldMs,
      `two moves ${moves[i].atMs - moves[i - 1].atMs}ms apart, under the ${DEFAULT_DODGE.minHoldMs}ms hold`
    );
  }
});

test("an inset with no other side to go to is left alone", () => {
  const centred = { ...INSET, x: 0 };
  assert.deepEqual(cameraDodges(park(0.5, 0.5, 0, 10000), centred), []);
});

test("an empty pointer track is not an error", () => {
  assert.deepEqual(cameraDodges([], INSET), []);
});

/* ── Explaining ─────────────────────────────────────────────────── */

const still = (fromMs, toMs) => park(0.5, 0.5, fromMs, toMs);

test("a silent microphone means no takeover, whatever the hands did", () => {
  const out = explainingStretches({
    cursor: still(0, 60000), events: [], durationMs: 60000, hasNarration: false,
  });
  assert.deepEqual(out, [], "quiet hands with no narration is someone who left the room");
});

test("hands off the machine over a live microphone hands the camera the frame", () => {
  const out = explainingStretches({
    cursor: still(0, 30000),
    events: [{ tMs: 500, kind: "click", x: 0.4, y: 0.4 }],
    durationMs: 30000,
    hasNarration: true,
  });
  assert.equal(out.length, 1);
  assert.ok(out[0].startMs > 500, "the stretch should start after the last click, not on it");
  assert.ok(out[0].endMs <= 30000 - DEFAULT_EXPLAIN.tailMs, "the closing seconds are not up for grabs");
});

test("a take that is all clicking is all presenting", () => {
  const events = [];
  for (let t = 0; t < 30000; t += 800) events.push({ tMs: t, kind: "click", x: 0.4, y: 0.4 });
  const out = explainingStretches({
    cursor: still(0, 30000), events, durationMs: 30000, hasNarration: true,
  });
  assert.deepEqual(out, []);
});

test("a demonstration with no clicks in it is still presenting, because the pointer moved", () => {
  /* Dragging a slider: continuous motion, zero events. Without the
     pointer half of the detector this is the case that gets called an
     explanation. */
  const cursor = [];
  for (let t = 0; t < 30000; t += 33) cursor.push({ tMs: t, x: 0.2 + (t / 30000) * 0.6, y: 0.5 });
  const out = explainingStretches({
    cursor, events: [], durationMs: 30000, hasNarration: true,
  });
  assert.deepEqual(out, []);
});

test("a hand resting on the trackpad still counts as parked", () => {
  const cursor = [];
  for (let t = 0; t < 30000; t += 33) {
    cursor.push({ tMs: t, x: 0.5 + Math.sin(t / 900) * 0.004, y: 0.5 });
  }
  const out = explainingStretches({ cursor, events: [], durationMs: 30000, hasNarration: true });
  assert.ok(out.length >= 1, "a pixel of drift should not read as driving the interface");
});

test("no stretch outstays `maxMs`", () => {
  const out = explainingStretches({
    cursor: still(0, 600000), events: [], durationMs: 600000, hasNarration: true,
  });
  for (const stretch of out) {
    assert.ok(
      stretch.endMs - stretch.startMs <= DEFAULT_EXPLAIN.maxMs,
      "a takeover past `maxMs` stops being a beat and becomes a different video"
    );
  }
});

test("the takeovers together never outrun the share the take can afford", () => {
  const events = [];
  /* Twelve five-second silences: far more than the budget allows. */
  for (let t = 0; t < 120000; t += 10000) events.push({ tMs: t, kind: "key", x: 0.3, y: 0.3 });
  const out = explainingStretches({
    cursor: still(0, 120000), events, durationMs: 120000, hasNarration: true,
  });
  const held = out.reduce((n, s) => n + (s.endMs - s.startMs), 0);
  assert.ok(
    held <= 120000 * DEFAULT_EXPLAIN.maxShare,
    `${held}ms of takeover in a 120s take is past the ${DEFAULT_EXPLAIN.maxShare} share`
  );
  assert.ok(out.length > 0, "a budget is not a refusal");
});

test("what survives the budget is returned in playing order", () => {
  const events = [];
  for (let t = 0; t < 120000; t += 10000) events.push({ tMs: t, kind: "key", x: 0.3, y: 0.3 });
  const out = explainingStretches({
    cursor: still(0, 120000), events, durationMs: 120000, hasNarration: true,
  });
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].startMs >= out[i - 1].endMs, "stretches overlap or run backwards");
  }
});

test("a take too short to hold an explanation gets none", () => {
  assert.deepEqual(
    explainingStretches({ cursor: still(0, 2000), events: [], durationMs: 2000, hasNarration: true }),
    []
  );
});

/* ── The wiring ─────────────────────────────────────────────────── */

test("the assemble reads the choreography, and the camera block is gated on a camera", () => {
  const project = readFileSync(src("video", "engine", "recordingProject.ts"), "utf8");
  assert.match(project, /from '\.\/cameraChoreography'/);
  assert.match(
    project,
    /if \(cameraTrack && take\.camera && o\.includeCamera\)/,
    "a take recorded without a webcam must skip the camera block entirely"
  );
  assert.match(project, /const shift = \(ms: number\) => Math\.max\(0, ms - take\.cameraOffsetMs\)/,
    "detector output is in take time and the clip runs in clip time");
});

test("the dodge and the takeover are emitted as one keyframe track", () => {
  const look = readFileSync(src("video", "engine", "cinematicLook.ts"), "utf8");
  assert.match(look, /dodges\?: \{ atMs: number; x: number \}\[\]/);
  /* The takeover must return the inset to wherever the dodge has since
     put it, or every dodge is undone by the next takeover's exit. */
  assert.match(look, /\[outAt, homeX\(outAt\)\]/);
  assert.match(look, /points\.sort\(\(a, b\) => a\[0\] - b\[0\]\)/,
    "interleaved dodge and takeover keys have to be sorted before they are written");
});
