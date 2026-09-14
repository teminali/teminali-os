/**
 * Full-experience battle test for Temi's voice pipeline.
 *
 * Mimics the exact chain running in the Electron app:
 *   WebAudio Worklet batch (48 kHz Int16 + 8-byte header)
 *   -> downsampleTo16k
 *   -> MicEndpointer (NoiseFloor, FFT, McLeod pitch, Endpointer)
 *   -> GeminiLiveEngine (activityStart, activityEnd, audio stream)
 *   -> Gemini Live inbound transcripts (handling [noise], tags, partials, finals)
 *   -> Stall watchdog (endpointStall, cooldown, pacing recovery)
 *   -> Assistant TTS playback ducking & intentional barge-in
 *   -> Multi-turn conversational flow
 */
import test from "node:test";
import assert from "node:assert/strict";

import { GeminiLiveEngine, ENDPOINT_STALL_NOTE } from "../src/services/voice/geminiLiveEngine.ts";

const RATE_48K = 48_000;
const BATCH_SAMPLES = 2048; // one VoiceAudioEngine worklet batch (42.666 ms)
const BATCH_MS = (BATCH_SAMPLES / RATE_48K) * 1000;

/** Make a 48 kHz worklet batch with the 8-byte big-endian header. */
function makeWorkletBatch(samples, isTTSPlaying = false, timestamp = 0) {
  const buf = new ArrayBuffer(8 + BATCH_SAMPLES * 2);
  const view = new DataView(buf);
  view.setUint32(0, (timestamp || Date.now()) & 0xffffffff, false);
  view.setUint32(4, isTTSPlaying ? 1 : 0, false);
  new Int16Array(buf, 8).set(samples);
  return buf;
}

/** Generate realistic room noise (fan hum / mic hiss) at a given RMS level. */
function makeRoomNoise(n, rms = 0.016, fanFreq = 220) {
  const out = new Int16Array(n);
  // Blend random noise with a faint periodic fan blade hum
  for (let i = 0; i < n; i += 1) {
    const random = (Math.random() * 2 - 1) * rms * 0.8;
    const hum = Math.sin((2 * Math.PI * fanFreq * i) / RATE_48K) * rms * 0.4;
    const sample = Math.max(-1, Math.min(1, random + hum));
    out[i] = Math.round(sample * 32768);
  }
  return out;
}

/** Generate voiced speech: rich harmonic glottal pulse train at speech level. */
function makeSpeech(n, offset = 0, f0 = 140, rms = 0.08) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = (offset + i) / RATE_48K;
    let s = 0;
    for (let k = 1; k <= 15; k += 1) {
      s += Math.sin(2 * Math.PI * f0 * k * t) / Math.pow(k, 0.8);
    }
    const sample = Math.max(-1, Math.min(1, (s / 3.0) * rms * 2.8));
    out[i] = Math.round(sample * 32768);
  }
  return out;
}

function createHarness() {
  const engine = new GeminiLiveEngine();
  const sentRealtime = [];
  const emittedMessages = [];
  const emittedNotes = [];
  const errors = [];

  engine.session = {
    sendRealtimeInput: (m) => sentRealtime.push(m),
    sendClientContent: () => {},
    close: () => {},
  };

  engine.onMessage = (m) => emittedMessages.push(m);
  engine.onNote = (n) => emittedNotes.push(n);
  engine.onError = (e) => errors.push(e);

  return { engine, sentRealtime, emittedMessages, emittedNotes, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Battle Test 1: Ambient room / fan noise at idle
// ─────────────────────────────────────────────────────────────────────────────

test("idle in a room with fan noise (rms 0.016) never starts a turn or triggers stall notes", () => {
  const { engine, sentRealtime, emittedNotes } = createHarness();
  let simTime = 10_000;

  // Feed 200 batches (~8.5 seconds) of continuous room noise with fan hum
  for (let b = 0; b < 200; b += 1) {
    const batch = makeWorkletBatch(makeRoomNoise(BATCH_SAMPLES, 0.016, 240), false, simTime);
    engine.sendAudioChunk(batch, simTime);
    simTime += BATCH_MS;
  }

  // The noise floor must have adapted upward to the room
  assert.ok(
    engine.endpointer.stats.windowMs > 0,
    "endpointer remains operational",
  );

  // Must NOT have opened an activity bracket or streamed audio to Gemini
  assert.equal(
    sentRealtime.filter((m) => m.activityStart).length,
    0,
    "room noise must not send activityStart",
  );
  assert.equal(
    sentRealtime.filter((m) => m.audio).length,
    0,
    "room noise must not stream audio",
  );

  // Must NOT have emitted the watchdog stall error prompt
  assert.equal(
    emittedNotes.filter((n) => n === ENDPOINT_STALL_NOTE).length,
    0,
    "room noise must not trigger the stall watchdog prompt",
  );
  assert.equal(engine.activityOpen, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Battle Test 2: Natural spoken sentence with thinking pause over room noise
// ─────────────────────────────────────────────────────────────────────────────

test("a natural spoken turn with a thinking pause over room noise endpoints cleanly and quickly", () => {
  const { engine, sentRealtime, emittedNotes } = createHarness();
  let simTime = 10_000;

  // 1. Initial idle room noise (20 batches ~850 ms) to let the floor settle
  for (let b = 0; b < 20; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeRoomNoise(BATCH_SAMPLES, 0.016), false, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, false, "idle room noise did not open turn");

  // 2. User speaks phrase 1: "open dukabot" (16 batches ~680 ms)
  let offset = 0;
  for (let b = 0; b < 16; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeSpeech(BATCH_SAMPLES, offset, 135, 0.08), false, simTime),
      simTime,
    );
    offset += BATCH_SAMPLES;
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, true, "phrase 1 opened the activity bracket");
  assert.ok(sentRealtime.some((m) => m.activityStart), "activityStart was sent to Gemini");

  // 3. Thinking pause: 12 batches (~510 ms) of room noise
  for (let b = 0; b < 12; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeRoomNoise(BATCH_SAMPLES, 0.016), false, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, true, "the thinking pause was held open, not prematurely cut");

  // 4. User speaks phrase 2: "and run the tests" (18 batches ~760 ms)
  for (let b = 0; b < 18; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeSpeech(BATCH_SAMPLES, offset, 140, 0.08), false, simTime),
      simTime,
    );
    offset += BATCH_SAMPLES;
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, true, "phrase 2 continued within the same bracket");

  // 5. User stops speaking: room noise resumes for 35 batches (~1.5 s)
  for (let b = 0; b < 35; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeRoomNoise(BATCH_SAMPLES, 0.016), false, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }

  // The bracket must have closed via clean endpoint, NOT via stall
  assert.equal(engine.activityOpen, false, "bracket closed cleanly after silence");
  assert.ok(sentRealtime.some((m) => m.activityEnd), "activityEnd was sent to Gemini");
  assert.equal(
    emittedNotes.filter((n) => n === ENDPOINT_STALL_NOTE).length,
    0,
    "no stall note was fired on a natural turn",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Battle Test 3: Gemini non-speech acoustic tags & live transcription
// ─────────────────────────────────────────────────────────────────────────────

test("Gemini [noise] or bare noise transcription never shows in UI or silences playback", () => {
  const { engine, emittedMessages } = createHarness();

  // Gemini sends an acoustic noise tag
  engine.handleServerMessage({ serverContent: { inputTranscription: { text: "[noise]" } } });
  assert.equal(
    emittedMessages.filter((m) => m.type === "partial_user_request").length,
    0,
    "[noise] partial must not be emitted to the stage",
  );

  // Gemini sends alternate casing and brackets: (noise), <noise>, *noise*, noice
  engine.handleServerMessage({ serverContent: { inputTranscription: { text: "(noise)" } } });
  engine.handleServerMessage({ serverContent: { inputTranscription: { text: "<noise>" } } });
  engine.handleServerMessage({ serverContent: { inputTranscription: { text: "*noise*" } } });
  engine.handleServerMessage({ serverContent: { inputTranscription: { text: "noice" } } });
  assert.equal(
    emittedMessages.filter((m) => m.type === "partial_user_request").length,
    0,
    "all acoustic noise variations stripped",
  );

  // Gemini completes the turn with turnComplete
  engine.handleServerMessage({ serverContent: { turnComplete: true } });
  assert.equal(
    emittedMessages.filter((m) => m.type === "final_user_request").length,
    0,
    "noise final must not be routed to the stage (which would cause barge-in)",
  );

  // Real speech arrives: "Hey Temi"
  engine.handleServerMessage({ serverContent: { inputTranscription: { text: "Hey Temi" } } });
  assert.equal(
    emittedMessages.filter((m) => m.type === "partial_user_request").length,
    1,
    "real speech partial is emitted",
  );
  assert.equal(
    emittedMessages.find((m) => m.type === "partial_user_request").content,
    "Hey Temi",
  );

  // Assistant answers: "Hello!"
  engine.handleServerMessage({ serverContent: { outputTranscription: { text: "Hello!" } } });
  engine.handleServerMessage({ serverContent: { turnComplete: true } });
  assert.equal(
    emittedMessages.filter((m) => m.type === "final_user_request").length,
    1,
    "real speech final is emitted",
  );
  assert.equal(
    emittedMessages.find((m) => m.type === "final_user_request").content,
    "Hey Temi",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Battle Test 4: Stall Watchdog Recovery, Cooldown & Pacing Reset
// ─────────────────────────────────────────────────────────────────────────────

test("watchdog stall on an endless tone forgets pacing and enters a refractory cooldown", () => {
  const { engine, sentRealtime, emittedNotes } = createHarness();
  let simTime = 10_000;

  // Force an activity bracket open with 3 speech batches (ensures onsetFrames >= 3)
  for (let b = 0; b < 3; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeSpeech(BATCH_SAMPLES, b * BATCH_SAMPLES, 150, 0.1), false, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, true, "speech opened turn");

  // Artificially advance time by 16 seconds to simulate an overrun
  simTime += 16_000;

  // Next chunk triggers guardAgainstEndlessTurn
  engine.sendAudioChunk(
    makeWorkletBatch(makeSpeech(BATCH_SAMPLES, 5000, 150, 0.1), false, simTime),
    simTime,
  );
  simTime += BATCH_MS;

  // The bracket must be closed
  assert.equal(engine.activityOpen, false, "watchdog closed the stalled bracket");
  assert.ok(sentRealtime.some((m) => m.activityEnd), "activityEnd was sent");

  // Because no user transcript was recorded, no error banner is emitted
  assert.equal(
    emittedNotes.filter((n) => n === ENDPOINT_STALL_NOTE).length,
    0,
    "ambient stall without speech does not emit error prompt",
  );

  // Pacing floor must be reset to 0
  assert.equal(engine.endpointer.stats.pacingFloorMs, 0, "learned pacing floor was cleared");

  // Immediate next chunk within cooldown (e.g. 50ms later) cannot reopen bracket
  engine.sendAudioChunk(
    makeWorkletBatch(makeSpeech(BATCH_SAMPLES, 6000, 150, 0.1), false, simTime),
    simTime,
  );
  assert.equal(engine.activityOpen, false, "refractory cooldown prevented immediate restart");

  // Advance time past the 800ms cooldown
  simTime += 1000;

  // Now, real user speech opens the turn cleanly
  for (let b = 0; b < 3; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeSpeech(BATCH_SAMPLES, b * BATCH_SAMPLES, 150, 0.1), false, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, true, "after cooldown expires, new speech opens cleanly");
});

// ─────────────────────────────────────────────────────────────────────────────
// Battle Test 5: Full Duplex: Speaker bleed rejection vs intentional barge-in
// ─────────────────────────────────────────────────────────────────────────────

test("speaker bleed while ducked does not open turns, but intentional loud barge-in breaks through", () => {
  const { engine, sentRealtime } = createHarness();
  let simTime = 10_000;

  // 1. Settle in a room
  for (let b = 0; b < 20; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeRoomNoise(BATCH_SAMPLES, 0.015), false, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }

  // 2. Assistant starts speaking: isTTSPlaying = true, realistic speaker bleed (0.015)
  for (let b = 0; b < 40; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeSpeech(BATCH_SAMPLES, b * BATCH_SAMPLES, 200, 0.015), true, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }

  // Must NOT have opened a user turn from speaker bleed
  assert.equal(engine.activityOpen, false, "speaker bleed did not open a turn");
  assert.equal(sentRealtime.filter((m) => m.activityStart).length, 0);

  // 3. User intentionally barges in over the assistant with loud speech (RMS 0.065)
  for (let b = 0; b < 4; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeSpeech(BATCH_SAMPLES, b * BATCH_SAMPLES, 140, 0.065), true, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, true, "intentional loud barge-in opened turn over playback");
  assert.ok(sentRealtime.some((m) => m.activityStart), "activityStart sent to interrupt assistant");

  // 4. User stops speaking: endpoints cleanly
  for (let b = 0; b < 30; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeRoomNoise(BATCH_SAMPLES, 0.015), false, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, false, "barge-in turn ended cleanly after silence");
});

// ─────────────────────────────────────────────────────────────────────────────
// Battle Test 6: Multi-turn conversational flow
// ─────────────────────────────────────────────────────────────────────────────

test("multi-turn conversation transitions smoothly between user turns and assistant responses", () => {
  const { engine, sentRealtime } = createHarness();
  let simTime = 10_000;

  // Let room settle
  for (let b = 0; b < 20; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeRoomNoise(BATCH_SAMPLES, 0.016), false, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }

  // Turn 1: User asks "What is the time?"
  for (let b = 0; b < 10; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeSpeech(BATCH_SAMPLES, b * BATCH_SAMPLES, 130, 0.08), false, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, true, "turn 1 opened");

  // Gemini Live streams inbound partial transcript
  engine.handleServerMessage({ serverContent: { inputTranscription: { text: "What is the time?" } } });

  // User silence -> turn 1 closes
  for (let b = 0; b < 30; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeRoomNoise(BATCH_SAMPLES, 0.016), false, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, false, "turn 1 closed cleanly");

  // Assistant plays answer for 1 second (isTTSPlaying = true, bleed = 0.014)
  for (let b = 0; b < 25; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeSpeech(BATCH_SAMPLES, b * BATCH_SAMPLES, 210, 0.014), true, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, false, "assistant answer playback did not trigger turn");

  // Turn 2: User immediately follows up: "Thanks, and what about tomorrow?"
  for (let b = 0; b < 10; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeSpeech(BATCH_SAMPLES, b * BATCH_SAMPLES, 135, 0.08), false, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, true, "turn 2 opened immediately");

  // Gemini Live streams follow-up transcript
  engine.handleServerMessage({ serverContent: { inputTranscription: { text: "Thanks, and what about tomorrow?" } } });

  // User silence -> turn 2 closes
  for (let b = 0; b < 30; b += 1) {
    engine.sendAudioChunk(
      makeWorkletBatch(makeRoomNoise(BATCH_SAMPLES, 0.016), false, simTime),
      simTime,
    );
    simTime += BATCH_MS;
  }
  assert.equal(engine.activityOpen, false, "turn 2 closed cleanly");
  assert.equal(
    sentRealtime.filter((m) => m.activityStart).length,
    2,
    "exactly two turns started across the conversation",
  );
  assert.equal(
    sentRealtime.filter((m) => m.activityEnd).length,
    2,
    "exactly two turns ended cleanly across the conversation",
  );
});
