/*
  The studio's reader for a streamed `/speak` reply. The framing is the
  sidecar's (`voice-runtime/stream.js`); the encoder here is a test-local copy
  so this suite needs nothing from that package.
*/
import test from "node:test";
import assert from "node:assert/strict";

import {
  FrameReader,
  SPEECH_STREAM_TYPE,
  heardChars,
  isClauseFrame,
  isSpeechStream,
  nextStartTime,
  pcm16ToFloat32,
  readyToWarmNext,
} from "../src/services/voice/speechStream.ts";

function encodeFrame(header, body = new Uint8Array(0)) {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + 4 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, json.length);
  out.set(json, 4);
  view.setUint32(4 + json.length, body.length);
  out.set(body, 8 + json.length);
  return out;
}

const clause = { clause: "Hi there,", start: 0, end: 9, sampleRate: 24_000, samples: 2 };
const pcm = new Uint8Array([0x00, 0x00, 0xff, 0x7f]); // 0, +full scale

test("the stream is told apart from a whole-file reply by its content type", () => {
  assert.equal(isSpeechStream(SPEECH_STREAM_TYPE), true);
  assert.equal(isSpeechStream(`${SPEECH_STREAM_TYPE}; charset=binary`), true);
  assert.equal(isSpeechStream("audio/wav"), false);
  assert.equal(isSpeechStream(null), false);
});

test("frames arrive whole however the bytes were sliced", () => {
  const stream = new Uint8Array([...encodeFrame(clause, pcm), ...encodeFrame({ done: true })]);
  const whole = new FrameReader().push(stream);
  assert.equal(whole.length, 2);
  assert.deepEqual(whole[0].header, clause);
  assert.deepEqual([...whole[0].body], [...pcm]);
  assert.deepEqual(whole[1].header, { done: true });

  // One byte at a time: the same two frames, nothing parsed in half.
  const reader = new FrameReader();
  const dribbled = [];
  for (const byte of stream) dribbled.push(...reader.push(new Uint8Array([byte])));
  assert.deepEqual(dribbled.map((f) => f.header), whole.map((f) => f.header));
  assert.deepEqual([...dribbled[0].body], [...pcm]);
});

test("only a header with audio in it is a clause", () => {
  assert.equal(isClauseFrame(clause), true);
  assert.equal(isClauseFrame({ done: true }), false);
  assert.equal(isClauseFrame({ ...clause, samples: 0 }), false);
});

test("PCM decodes to float samples even from an unaligned view", () => {
  const padded = new Uint8Array([0xaa, ...pcm]);
  const samples = pcm16ToFloat32(padded.subarray(1));
  assert.equal(samples.length, 2);
  assert.equal(samples[0], 0);
  assert.ok(Math.abs(samples[1] - 32767 / 32768) < 1e-6);
});

test("the next clause starts when the previous ends, or now if the renderer fell behind", () => {
  assert.equal(nextStartTime(1.0, 1.5), 1.5);
  assert.equal(nextStartTime(2.0, 1.5), 2.03);
  assert.equal(nextStartTime(0, 0), 0.03);
});

test("a barge-in reports how far into the clause the operator was", () => {
  const frame = { clause: "one two three four", start: 10, end: 28, sampleRate: 24_000, samples: 48_000 }; // 2 s
  assert.equal(heardChars(frame, 0), 10);
  assert.equal(heardChars(frame, 1), 19);
  assert.equal(heardChars(frame, 5), 28);
});

test("the next block starts rendering while the current one is still heard", () => {
  // A block cannot be played until it is rendered, so a render started when
  // the previous block ends is heard as a pause between paragraphs. Started in
  // the last fifth of the block being spoken, it happens under the audio.
  assert.equal(readyToWarmNext(0, 500), false);
  assert.equal(readyToWarmNext(399, 500), false);
  assert.equal(readyToWarmNext(400, 500), true);
  assert.equal(readyToWarmNext(500, 500), true);
  // Never warm on a block with no length to warm through, and never on a
  // boundary report that has gone backwards.
  assert.equal(readyToWarmNext(10, 0), false);
  assert.equal(readyToWarmNext(-1, 500), false);
  assert.equal(readyToWarmNext(0, 0), false);
  // The window is tunable, and a fraction of 0 would warm both blocks at once
  // — two renders queued behind the one being listened to.
  assert.equal(readyToWarmNext(1, 500, 0), true);
  assert.equal(readyToWarmNext(499, 500, 1), false);
  assert.equal(readyToWarmNext(500, 500, 1), true);
});
