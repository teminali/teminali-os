import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { clampSequence, frameGapMs, MAX_FRAMES, MAX_SPAN_MS } from "../src/utils/cameraSequence.ts";
import { openRun, closeRun, requestCameraFrame, resolveCameraFrame } from "../server/permission-bridge.js";

/** A one-pixel JPEG's worth of base64. Nothing here decodes it; it only has to be a non-empty string. */
const PICTURE = "/9j/4AAQSkZJRg==";

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

/* ── The word the frames travel under ─────────────────────────────────────── */

/*
  `look_at_me` failed every time it was ever called, for four releases, and no
  test caught it because all three files were correct on their own. The window
  sends `images`; `resolveCameraFrame` reads `images`; the gateway hop between
  them forwarded `image`, which is the *player's* spelling and a key neither
  end writes. The list arrived empty, the capture resolved as "the window could
  not take a photograph", and the camera looked broken rather than mis-wired.

  So the round trip is exercised here with the body the window actually sends,
  and the gateway's forwarding is asserted as source — the failure lives in a
  key name crossing a process boundary, so a key name crossing a process
  boundary is what is tested.
*/

test("a camera frame survives the hop the window sends it on", async () => {
  const seen = [];
  const token = openRun("run-camera", (event) => { seen.push(event); return true; });
  try {
    const waiting = requestCameraFrame({ runId: "run-camera", token, frames: 2, spanMs: 800 });
    const asked = seen.find((event) => event.type === "camera");
    assert.ok(asked, "the window is asked on the run's own stream");

    // Exactly what `answerCameraRequest` POSTs: `captureCameraFrames`'s return
    // spread over the ids. If this object stops matching that one, the tool
    // breaks again in the same silent way.
    const body = { runId: "run-camera", id: asked.id, images: [PICTURE, PICTURE], warm: true, tookMs: 240 };
    assert.deepEqual(resolveCameraFrame(body), { ok: true });

    const frame = await waiting;
    assert.deepEqual(frame.images, [PICTURE, PICTURE], "both frames reach the agent");
    assert.equal(frame.warm, true, "whether the camera was already on is part of the answer");
    assert.equal(frame.tookMs, 240);
  } finally {
    closeRun("run-camera");
  }
});

test("the gateway forwards the camera's word, not the player's", () => {
  const source = fs.readFileSync(new URL("../server/gateway.js", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf('route === "/api/assistant/camera-frame"'));
  const call = handler.slice(handler.indexOf("resolveCameraFrame({"), handler.indexOf("replyJson"));
  assert.match(call, /images:/, "`images`, plural — the word both the window and the resolver use");
  assert.equal(/\bimage:/.test(call), false, "`image` is the player's spelling and reaches nothing here");
  // Dropped by the same line, and both are in the sentence the agent is given.
  assert.match(call, /warm:/);
  assert.match(call, /tookMs:/);
});

test("a capture with nothing in it fails loudly rather than resolving empty", async () => {
  const seen = [];
  const token = openRun("run-camera-empty", (event) => { seen.push(event); return true; });
  try {
    const waiting = requestCameraFrame({ runId: "run-camera-empty", token });
    const { id } = seen.find((event) => event.type === "camera");
    resolveCameraFrame({ runId: "run-camera-empty", id, images: [], error: "" });
    await assert.rejects(() => waiting, /could not take a photograph/);
  } finally {
    closeRun("run-camera-empty");
  }
});
