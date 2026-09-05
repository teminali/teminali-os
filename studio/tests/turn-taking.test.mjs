/**
 * Turn-taking latency: prosodic end-of-turn prediction and its blend with the
 * syntactic endpointer. Everything under test is pure; no AudioContext.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  estimatePitch,
  readProsody,
  ProsodyTracker,
  DEFAULT_PROSODY,
} from "../src/services/voice/prosody.ts";
import {
  Endpointer,
  DEFAULT_ENDPOINTER,
  combineFinality,
  silenceWindowMs,
  syntaxFinality,
} from "../src/services/voice/turnTaking.ts";

const RATE = 48_000;
const FRAME = 1024;

/** One analyser frame of a tone with the given harmonics, at `amplitude`. */
function tone(f0, { amplitude = 0.3, harmonics = [1], phase = 0 } = {}) {
  const out = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) {
    let v = 0;
    for (let h = 0; h < harmonics.length; h += 1) {
      v += harmonics[h] * Math.sin(2 * Math.PI * f0 * (h + 1) * (i / RATE) + phase);
    }
    out[i] = amplitude * v;
  }
  return out;
}

function noise(amplitude = 0.3) {
  const out = new Float32Array(FRAME);
  let seed = 7;
  for (let i = 0; i < FRAME; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amplitude * ((seed / 0x7fffffff) * 2 - 1);
  }
  return out;
}

function rmsOf(samples) {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length);
}

/* ── Pitch ────────────────────────────────────────────────────────────────── */

test("a pure tone's pitch is recovered to within a few hertz", () => {
  for (const f0 of [110, 200, 320]) {
    const { f0: got, clarity } = estimatePitch(tone(f0), RATE);
    assert.ok(Math.abs(got - f0) < 4, `${f0} Hz read as ${got.toFixed(1)}`);
    assert.ok(clarity > 0.9);
  }
});

test("a voice-like tone with strong harmonics is not read an octave up", () => {
  // Second and third harmonics louder than the fundamental, as in a real voice.
  const frame = tone(120, { harmonics: [0.4, 1, 0.7] });
  const { f0 } = estimatePitch(frame, RATE);
  assert.ok(Math.abs(f0 - 120) < 5, `read ${f0.toFixed(1)}`);
});

test("noise and silence have no pitch", () => {
  assert.equal(estimatePitch(noise(), RATE).f0, 0);
  assert.equal(estimatePitch(new Float32Array(FRAME), RATE).f0, 0);
});

/* ── Reading the tail ─────────────────────────────────────────────────────── */

/** Voiced points every 20 ms for `ms`, with rms and f0 taken from `shape(t)` where t runs 0→1. */
function points(ms, shape, startAt = 0) {
  const out = [];
  const count = Math.round(ms / 20);
  for (let i = 0; i < count; i += 1) {
    const t = count > 1 ? i / (count - 1) : 1;
    const { rms, f0 } = shape(t);
    out.push({ at: startAt + i * 20, rms, f0 });
  }
  return out;
}

test("a tail that falls in energy and pitch reads as finished", () => {
  const reading = readProsody(points(600, (t) => ({ rms: 0.2 - 0.14 * t, f0: 180 - 40 * t })));
  assert.ok(reading, "expected a reading");
  assert.ok(reading.energyRatio < 0.7, `energy ratio ${reading.energyRatio}`);
  assert.ok(reading.pitchSemitones < -1.5, `pitch ${reading.pitchSemitones} st`);
  assert.ok(reading.finality > 0.7, `finality ${reading.finality}`);
});

test("a rising tail at level energy reads as a question — hold", () => {
  const reading = readProsody(points(600, (t) => ({ rms: 0.15, f0: 150 + 50 * t })));
  assert.ok(reading);
  assert.ok(reading.pitchSemitones > 1.5);
  assert.ok(reading.finality < 0.35, `finality ${reading.finality}`);
});

test("a level plateau with no pitch is a hold, not a release", () => {
  const reading = readProsody(points(600, () => ({ rms: 0.15, f0: 0 })));
  assert.ok(reading);
  assert.equal(reading.pitchSemitones, null);
  assert.ok(reading.finality < 0.5 && reading.finality > 0.35, `finality ${reading.finality}`);
});

test("energy alone can release when the pitch is unreadable", () => {
  const reading = readProsody(points(600, (t) => ({ rms: 0.2 - 0.14 * t, f0: 0 })));
  assert.ok(reading);
  assert.ok(reading.finality > 0.6, `finality ${reading.finality}`);
});

test("too little speech gives no reading rather than a guess", () => {
  assert.equal(readProsody([]), null);
  // 300 ms is a tail with no head to compare it to.
  assert.equal(readProsody(points(300, () => ({ rms: 0.1, f0: 150 }))), null);
  // A head that is too sparse to trust.
  const sparse = [...points(60, () => ({ rms: 0.2, f0: 150 })), ...points(300, () => ({ rms: 0.1, f0: 150 }), 320)];
  assert.equal(readProsody(sparse), null);
});

test("the tracker forgets speech older than its history window", () => {
  const tracker = new ProsodyTracker();
  for (const p of points(2000, () => ({ rms: 0.1, f0: 150 }))) tracker.observe(p);
  assert.ok(tracker.size <= DEFAULT_PROSODY.historyMs / 20 + 1);
  tracker.reset();
  assert.equal(tracker.size, 0);
  assert.equal(tracker.finality(), null);
});

test("frame pitch and level from a synthesised falling utterance drive the tracker to release", () => {
  const tracker = new ProsodyTracker();
  // 700 ms glide from 190 Hz to 130 Hz while the voice trails off.
  for (let i = 0; i < 35; i += 1) {
    const t = i / 34;
    const frame = tone(190 - 60 * t, { amplitude: 0.3 - 0.2 * t, harmonics: [1, 0.5], phase: i });
    const { f0 } = estimatePitch(frame, RATE);
    tracker.observe({ at: i * 20, rms: rmsOf(frame), f0 });
  }
  const finality = tracker.finality();
  assert.ok(finality !== null && finality > 0.7, `finality ${finality}`);
});

test("frame pitch and level from a synthesised rising utterance keep the tracker holding", () => {
  const tracker = new ProsodyTracker();
  for (let i = 0; i < 35; i += 1) {
    const t = i / 34;
    const frame = tone(140 + 70 * t, { amplitude: 0.25, harmonics: [1, 0.5], phase: i });
    const { f0 } = estimatePitch(frame, RATE);
    tracker.observe({ at: i * 20, rms: rmsOf(frame), f0 });
  }
  const finality = tracker.finality();
  assert.ok(finality !== null && finality < 0.35, `finality ${finality}`);
});

/* ── Blending and the window ──────────────────────────────────────────────── */

test("an empty transcript is unknown syntax, not an unfinished sentence", () => {
  assert.equal(syntaxFinality(""), null);
  assert.equal(syntaxFinality("   "), null);
  assert.ok(syntaxFinality("open the file.") > 0.7);
});

test("finality blends what is known and stays neutral when nothing is", () => {
  assert.equal(combineFinality(null, null), 0.5);
  assert.equal(combineFinality(null, 0.9), 0.9);
  assert.equal(combineFinality(0.2, null), 0.2);
  assert.equal(combineFinality(0.2, 0.8), 0.5);
  // A dangling "and" still holds the turn against a voice that fell.
  assert.ok(combineFinality(syntaxFinality("open the file and"), 0.85) < 0.5);
});

test("the window runs from the ceiling at 0 to the floor at 1, and eager shortens both", () => {
  const { minSilenceMs, maxSilenceMs } = DEFAULT_ENDPOINTER;
  assert.equal(silenceWindowMs(DEFAULT_ENDPOINTER, 0), maxSilenceMs);
  assert.equal(silenceWindowMs(DEFAULT_ENDPOINTER, 1), minSilenceMs);
  assert.equal(silenceWindowMs(DEFAULT_ENDPOINTER, 0.5), Math.round((minSilenceMs + maxSilenceMs) / 2));
  assert.equal(silenceWindowMs(DEFAULT_ENDPOINTER, 1, true), Math.round(minSilenceMs * 0.7));
});

/* ── The endpointer with a clock ──────────────────────────────────────────── */

/** Speak for `speechMs`, then go silent with the given evidence; return the silence it took to fire. */
function silenceToFire({ transcript = "", prosody = null, eager = false, speechMs = 800 } = {}) {
  const endpointer = new Endpointer();
  let at = 0;
  for (; at < speechMs; at += 20) endpointer.push(true, transcript, eager, { at });
  const silentFrom = at;
  for (let guard = 0; guard < 400; guard += 1) {
    const event = endpointer.push(false, transcript, eager, { at, prosody });
    if (event?.type === "speech-end") return { silenceMs: at - silentFrom, event };
    if (event?.type === "discarded") throw new Error("discarded");
    at += 20;
  }
  throw new Error("never fired");
}

test("with no transcript and no prosody the window is the midpoint, not the ceiling", () => {
  const { minSilenceMs, maxSilenceMs } = DEFAULT_ENDPOINTER;
  const { silenceMs, event } = silenceToFire();
  const midpoint = (minSilenceMs + maxSilenceMs) / 2;
  assert.ok(Math.abs(silenceMs - midpoint) <= 20, `fired after ${silenceMs} ms`);
  assert.equal(event.windowMs, Math.round(midpoint));
});

test("a falling tail releases the turn near the floor; a rising one holds it near the ceiling", () => {
  const { minSilenceMs, maxSilenceMs } = DEFAULT_ENDPOINTER;
  const falling = silenceToFire({ prosody: 0.9 }).silenceMs;
  const rising = silenceToFire({ prosody: 0.1 }).silenceMs;
  assert.ok(falling <= minSilenceMs + (maxSilenceMs - minSilenceMs) * 0.1 + 20, `falling fired at ${falling}`);
  assert.ok(rising >= maxSilenceMs - (maxSilenceMs - minSilenceMs) * 0.1 - 20, `rising fired at ${rising}`);
  assert.ok(falling < rising);
});

test("syntax and prosody both count: a finished sentence with a falling voice is the fastest turn", () => {
  const both = silenceToFire({ transcript: "Open the settings file.", prosody: 0.9 }).silenceMs;
  const syntaxOnly = silenceToFire({ transcript: "Open the settings file." }).silenceMs;
  const prosodyOnly = silenceToFire({ prosody: 0.9 }).silenceMs;
  const contradictory = silenceToFire({ transcript: "open the settings file and", prosody: 0.9 }).silenceMs;
  // The blend is an average of the two, so it lands between them — a second
  // agreeing signal tightens a syntax-only call, it does not pile on top of it.
  assert.ok(both < syntaxOnly, `${both} vs syntax-only ${syntaxOnly}`);
  assert.ok(Math.abs(both - (syntaxOnly + prosodyOnly) / 2) <= 40, `${both} vs ${syntaxOnly}/${prosodyOnly}`);
  assert.ok(contradictory > both + 300, `a dangling connector fired at ${contradictory}`);
});

test("holding events report the window so the HUD can show how long it is waiting", () => {
  const endpointer = new Endpointer();
  let at = 0;
  for (; at < 200; at += 20) endpointer.push(true, "", false, { at });
  const event = endpointer.push(false, "", false, { at, prosody: 0.5 });
  assert.equal(event.type, "holding");
  assert.ok(event.windowMs > 0 && event.remainingMs < event.windowMs);
});

test("the frame clock comes from the caller, so a stalled timer cannot stretch the silence", () => {
  const endpointer = new Endpointer();
  for (let at = 0; at < 100; at += 20) endpointer.push(true, "", false, { at });
  // A 5 s gap between frames is clamped to the 120 ms ceiling per frame.
  const event = endpointer.push(false, "", false, { at: 5100, prosody: 0.5 });
  assert.equal(event.type, "holding");
});
