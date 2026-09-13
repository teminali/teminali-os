/**
 * The mic endpointer on Temi's live lane, and the activity bracket it drives.
 *
 * Google used to decide when he had stopped talking, on a flat 1800 ms of
 * silence. Measured end to end against the live model over four alternating
 * pairs, moving that decision here took 993 ms off the median wait for her
 * first audio, and every run of the new path beat every run of the old one.
 * These tests pin the parts of that which can be checked without a network:
 * that speech opens a bracket and silence closes it, that the window is sized
 * rather than fixed, that her own voice cannot open one, and that the onset is
 * not thrown away while the detector makes up its mind.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MicEndpointer } from "../src/services/voice/micEndpoint.ts";
import { DEFAULT_ENDPOINTER } from "../src/services/voice/turnTaking.ts";
import { GeminiLiveEngine } from "../src/services/voice/geminiLiveEngine.ts";

const RATE = 16_000;
const CHUNK = 682; // what one 2048-sample batch at 48 kHz downsamples to

/** A glottal pulse train: periodic, harmonic, and squarely in the speech band. */
function speech(n, offset = 0, f0 = 150, gain = 0.25) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = (offset + i) / RATE;
    let s = 0;
    for (let k = 1; k <= 20; k += 1) s += Math.sin(2 * Math.PI * f0 * k * t) / k;
    out[i] = Math.max(-32768, Math.min(32767, Math.round((s / 2.8) * gain * 32768)));
  }
  return out;
}

/**
 * A real mic at rest is not digital zero. Takes the same (n, offset) shape as
 * `speech` so `drive` can call either, and ignores the offset: noise has no
 * phase to keep continuous.
 */
function room(n, _offset = 0) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.round((Math.random() * 2 - 1) * 0.003 * 32768 * 1.73);
  return out;
}

function drive(ep, make, chunks, at) {
  const events = [];
  for (let c = 0; c < chunks; c += 1) {
    at.now += (CHUNK / RATE) * 1000;
    events.push(...ep.push(make(CHUNK, c * CHUNK), RATE, Math.round(at.now)));
  }
  return events;
}

test("speech opens a turn and silence closes it", () => {
  const ep = new MicEndpointer();
  const at = { now: 1_000_000 };

  const started = drive(ep, speech, 20, at); // ~850 ms of voice
  assert.ok(
    started.some((e) => e.type === "speech-start"),
    "a second of a periodic, in-band, well above the floor signal is speech",
  );
  assert.equal(ep.isSpeaking, true);

  const ended = drive(ep, room, 60, at); // up to ~2.5 s of quiet
  const end = ended.find((e) => e.type === "speech-end");
  assert.ok(end, "silence after speech has to end the turn, or it never ends");
  assert.equal(end.reason, "endpoint");
  assert.equal(ep.isSpeaking, false);
});

test("the wait is sized, and sits under the ceiling Google was holding", () => {
  const ep = new MicEndpointer();
  const at = { now: 2_000_000 };
  drive(ep, speech, 20, at);
  const spokeUntil = at.now;
  const ended = drive(ep, room, 60, at);
  const end = ended.find((e) => e.type === "speech-end");

  assert.ok(end.windowMs >= DEFAULT_ENDPOINTER.minSilenceMs);
  assert.ok(end.windowMs <= DEFAULT_ENDPOINTER.maxSilenceMs);
  assert.ok(
    end.windowMs < DEFAULT_ENDPOINTER.maxSilenceMs,
    "a window pinned at the ceiling is the flat wait we just removed",
  );

  // The whole point, stated as a number: he is not waiting 1800 ms.
  const waited = ep.stats.lastEndpointAt - ep.stats.lastVoicedAt;
  assert.ok(
    waited < DEFAULT_ENDPOINTER.maxSilenceMs,
    `committed after ${waited} ms, which is no better than the flat ceiling`,
  );
  assert.ok(spokeUntil > 0);
});

test("her own voice cannot open a turn", () => {
  const ep = new MicEndpointer();
  const at = { now: 3_000_000 };
  ep.setDucked(true);
  // Speaker bleed: the same periodic signal, at the level a mic picks it up.
  const events = drive(ep, (n, o) => speech(n, o, 150, 0.03), 30, at);
  assert.equal(
    events.some((e) => e.type === "speech-start"),
    false,
    "bleed from our own speaker opening a turn is a self-interrupting assistant",
  );
});

test("the onset is held, not dropped, until the bracket opens", () => {
  const engine = new GeminiLiveEngine();
  const sent = [];
  engine.session = { sendRealtimeInput: (m) => sent.push(m), close() {} };

  const batch = (make, c) => {
    // 2048 samples at 48 kHz behind the 8-byte header the worklet writes.
    const buf = new ArrayBuffer(8 + 2048 * 2);
    new DataView(buf).setUint32(4, 0, false);
    const pcm = new Int16Array(buf, 8);
    const src = make(2048, c * 2048);
    pcm.set(src);
    return buf;
  };

  for (let c = 0; c < 25; c += 1) engine.sendAudioChunk(batch(speech, c));

  const startAt = sent.findIndex((m) => m.activityStart);
  assert.ok(startAt >= 0, "audio with no activityStart is audio Gemini was told nothing about");
  assert.ok(
    sent.slice(0, startAt).every((m) => !m.audio),
    "no audio may go out before the bracket opens",
  );
  const audioAfter = sent.slice(startAt).filter((m) => m.audio).length;
  assert.ok(
    audioAfter >= startAt + 1,
    "the chunks held during onset detection have to be flushed, not discarded",
  );
});

test("a reconnect cannot leave a bracket open on the old socket", () => {
  const engine = new GeminiLiveEngine();
  engine.session = { sendRealtimeInput() {}, close() {} };
  const batch = new ArrayBuffer(8 + 2048 * 2);
  new Int16Array(batch, 8).set(speech(2048));
  for (let c = 0; c < 25; c += 1) engine.sendAudioChunk(batch);
  assert.equal(engine.activityOpen, true, "precondition: a bracket is open");

  engine.resetStreamState();
  assert.equal(engine.activityOpen, false);
  assert.equal(engine.prebuffer.length, 0);
});

test("a turn called over too early is counted, not silently recovered", () => {
  const engine = new GeminiLiveEngine();
  engine.session = { sendRealtimeInput() {}, close() {} };

  /* The endpointer measures silence against the wall clock, and the engine
     does not forward one. Patching the clock in rather than stubbing the
     detector keeps the real DSP in the test: what is faked here is the
     passage of time, not the verdict. */
  const clock = { now: 2_000_000 };
  const ep = engine.endpointer;
  const realPush = ep.push.bind(ep);
  ep.push = (pcm, rate) => {
    clock.now += (2048 / 48_000) * 1000; // one worklet batch
    return realPush(pcm, rate, Math.round(clock.now));
  };

  let batches = 0;
  const feed = (make) => {
    const buf = new ArrayBuffer(8 + 2048 * 2);
    new DataView(buf).setUint32(4, 0, false);
    new Int16Array(buf, 8).set(make(2048, batches * 2048));
    batches += 1;
    engine.sendAudioChunk(buf);
  };
  /* Only until the bracket closes. Carrying on past the endpoint puts the
     resumed speech outside `resumeWindowMs`, where it is a new turn rather
     than the same one continuing, and the mistake is no longer a mistake. */
  const pauseUntilCalledOver = () => {
    for (let c = 0; c < 80 && engine.activityOpen; c += 1) feed(room);
    assert.equal(engine.activityOpen, false, "silence after speech has to end the turn");
  };

  for (let c = 0; c < 25; c += 1) feed(speech);
  assert.equal(engine.activityOpen, true, "precondition: he is talking and the bracket is open");

  pauseUntilCalledOver();

  for (let c = 0; c < 25; c += 1) feed(speech); // and he carries straight on
  assert.equal(engine.activityOpen, true, "the bracket has to reopen, or the rest of him is lost");
  assert.equal(engine.corrections, 1, "reopening is what hides the mistake; count it");
  assert.ok(engine.cutGapMs > 0, "the silence it happened on is what says how badly");

  pauseUntilCalledOver();

  let timing = null;
  engine.onTiming = (t) => {
    timing = t;
  };
  engine.emitAudio(Buffer.from(new Int16Array([0, 0, 0, 0]).buffer).toString("base64"));

  assert.ok(timing, "her first audio is when the stopwatch reads out");
  assert.equal(timing.corrections, 1, "a wait bought by interrupting him is not a clean wait");
  assert.ok(timing.cutGapMs > 0, "and the report carries how tight the cut was");
  assert.ok(timing.pacingFloorMs > 0, "being wrong once teaches the endpointer to wait longer");
  assert.equal(engine.corrections, 0, "the count belongs to that turn, not to the session");
  assert.equal(engine.cutGapMs, 0);
});
