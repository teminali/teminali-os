/**
 * A turn that never ends.
 *
 * `speech-end` is the only event that commits an utterance, and everything
 * that produces one sits upstream of the `Endpointer`. When any of it stalls
 * there is no event at all, so "hearing" is a latch with no exit: the
 * recogniser keeps appending and several separate attempts pile into one
 * caption that is never sent. That was observed live — ten "hello"s in one
 * growing caption, state stuck at "hearing" — which is what `endpointStall`
 * exists to end. `VoiceEngine` is DOM-bound, so the rule is tested here as
 * arithmetic, the same way `isVoicedFrame` is.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { endpointStall } from "../src/services/voice/turnTaking.ts";

const NOW = 1_000_000;
const check = (over) =>
  endpointStall({
    turnStartedAt: NOW - 20_000,
    lastFrameAt: NOW - 20,
    now: NOW,
    maxUtteranceMs: 15_000,
    frameStallMs: 2_000,
    ...over,
  });

test("a turn inside its bound is not a stall", () => {
  assert.equal(check({ turnStartedAt: NOW - 14_999 }), null);
});

test("no turn is open, so nothing can have overrun", () => {
  assert.equal(check({ turnStartedAt: 0 }), null);
});

test("the bound is inclusive", () => {
  assert.equal(check({ turnStartedAt: NOW - 15_000 })?.overranMs, 15_000);
});

test("frames still arriving blames the turn detector, not the graph", () => {
  assert.equal(check().cause, "endpointer");
});

test("a silent audio graph is named as the frame pump", () => {
  assert.equal(check({ lastFrameAt: NOW - 2_000 }).cause, "frame-pump");
});

test("a graph that never produced a frame at all is a stalled pump", () => {
  // `lastFrameAt` is 0 before the first frame; an unknown last frame is not a
  // recent one, and reading it as recent would blame the wrong component.
  assert.equal(check({ lastFrameAt: 0 }).cause, "frame-pump");
});

test("a pause shorter than the stall window is still a live pump", () => {
  assert.equal(check({ lastFrameAt: NOW - 1_999 }).cause, "endpointer");
});
