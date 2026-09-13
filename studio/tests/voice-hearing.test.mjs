/**
 * Hearing in a noisy room.
 *
 * `isVoicedFrame` is the whole voice-activity decision, reduced to the five
 * numbers the audio graph already has. It is pure, so the case that matters —
 * an ordinary speaking voice in a room whose noise floor has climbed under it —
 * can be stated as arithmetic rather than reproduced with a microphone.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isVoicedFrame } from "../src/services/voice/voiceActivity.ts";

/** A frame with nothing periodic in it: broadband noise, no fundamental. */
const noise = (over) => ({ rms: 0.01, centroid: 1400, noiseFloor: 0.004, f0: 0, clarity: 0, ...over });
/** A frame of voiced speech: a fundamental a person could produce, clearly. */
const speech = (over) => ({ rms: 0.02, centroid: 1400, noiseFloor: 0.004, f0: 120, clarity: 0.85, ...over });

test("a loud frame is speech, as it always was", () => {
  assert.equal(isVoicedFrame(noise({ rms: 0.05 })), true);
});

test("a quiet room's own hiss is not speech", () => {
  assert.equal(isVoicedFrame(noise({ rms: 0.005, noiseFloor: 0.004 })), false);
});

test("a voice a noisy room has buried is still heard", () => {
  // The floor has climbed to 0.012, so the loudness route wants 0.031 —
  // more than an ordinary speaking voice at the same distance produces.
  const busy = { rms: 0.02, noiseFloor: 0.012 };
  assert.equal(isVoicedFrame(noise(busy)), false, "loudness alone cannot hear it");
  assert.equal(isVoicedFrame(speech(busy)), true, "its periodicity can");
});

test("the pitch route still needs the frame to be above the floor", () => {
  // Periodic, but quieter than the room it is in: that is a neighbouring
  // conversation bleeding in, not the person at the microphone.
  assert.equal(isVoicedFrame(speech({ rms: 0.005, noiseFloor: 0.012 })), false);
});

test("a fan is periodic and is still not speech", () => {
  // A motor's fundamental is as clean as a vowel's; what gives it away is
  // that all its energy sits below the band speech occupies.
  assert.equal(isVoicedFrame(speech({ centroid: 90 })), false);
  assert.equal(isVoicedFrame(speech({ centroid: 6000 })), false);
});

test("a periodic frame below the clarity bar is not admitted", () => {
  assert.equal(isVoicedFrame(speech({ clarity: 0.6, rms: 0.008, noiseFloor: 0.004 })), false);
});

test("while the assistant speaks, its own voice does not read as a barge-in", () => {
  // Speaker bleed is periodic, and at these levels it is exactly what the
  // ducked bars exist to reject: the pitch route holds an absolute floor.
  assert.equal(isVoicedFrame(speech({ rms: 0.015 }), true), false);
});

test("the operator can still interrupt over the assistant", () => {
  assert.equal(isVoicedFrame(speech({ rms: 0.05, clarity: 0.9 }), true), true);
});

test("ducking raises the bar it does not remove the route", () => {
  const frame = { rms: 0.025, centroid: 1400, noiseFloor: 0.004, f0: 130, clarity: 0.85 };
  assert.equal(isVoicedFrame(frame, false), true, "heard in the clear");
  assert.equal(isVoicedFrame(frame, true), true, "and over our own voice, being clearly periodic");
  assert.equal(isVoicedFrame({ ...frame, clarity: 0.75 }, true), false, "but not on a muddier frame");
});

test("while the assistant speaks, unvoiced desk noise or table scratching is rejected", () => {
  // Mechanical friction from scratching a desk, tapping a surface, or typing has high RMS
  // but zero harmonic periodicity. It must never trigger a barge-in interrupt while ducked.
  assert.equal(isVoicedFrame(noise({ rms: 0.05 }), true), false);
  assert.equal(isVoicedFrame(noise({ rms: 0.08 }), true), false);
  assert.equal(isVoicedFrame(noise({ rms: 0.15 }), true), false);
});

