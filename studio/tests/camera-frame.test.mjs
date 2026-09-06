import assert from "node:assert/strict";
import test from "node:test";
import { clampSequence, frameGapMs, MAX_FRAMES, MAX_SPAN_MS } from "../src/utils/cameraSequence.ts";

/**
 * The camera itself cannot be exercised here. What can be is the arithmetic
 * that decides how a sequence is spaced and how far a request is allowed to
 * go — which is what bounds both the light being on and the size of what is
 * sent to a model.
 */

test("a sequence spaces its frames across the span, and one frame waits for nothing", () => {
  assert.equal(frameGapMs(1, 5000), 0);
  assert.equal(frameGapMs(2, 1000), 1000);
  // Gaps are between frames: four frames over 1200 ms leave three gaps.
  assert.equal(frameGapMs(4, 1200), 400);
  assert.equal(frameGapMs(6, 5000), 1000);
});

test("a request cannot ask for more than the limits, or less than one frame", () => {
  assert.deepEqual(clampSequence(undefined, undefined), { frames: 1, spanMs: 1200 });
  assert.deepEqual(clampSequence(0, -5), { frames: 1, spanMs: 0 });
  assert.deepEqual(clampSequence(99, 99_000), { frames: MAX_FRAMES, spanMs: MAX_SPAN_MS });
  assert.deepEqual(clampSequence("3", "900"), { frames: 3, spanMs: 900 });
  assert.deepEqual(clampSequence("lots", NaN), { frames: 1, spanMs: 1200 });
  assert.equal(MAX_FRAMES, 6);
  assert.equal(MAX_SPAN_MS, 5000);
});
