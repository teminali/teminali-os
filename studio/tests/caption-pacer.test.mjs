/**
 * The caption is paced by the speaker, not by the model.
 *
 * The model finishes a sentence seconds before the voice does. A caption that
 * follows generation therefore shows the end of a thought while the listener is
 * still hearing its beginning, which is worse than no caption at all: the eye
 * overtakes the ear and the reader stops listening. These tests pin the two
 * properties that make the pacing feel like one thing rather than two — it
 * tracks real playback, and it never takes back a word it has shown.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CaptionPacer,
  DEFAULT_CHARS_PER_SECOND,
  MIN_CHARS_PER_SECOND,
  MAX_CHARS_PER_SECOND,
} from "../src/services/voice/captionPacer.ts";

const SENTENCE = "That is the most beautiful thing I have ever heard today my friend.";

test("nothing is captioned before the voice has said anything", () => {
  const p = new CaptionPacer();
  p.beginTurn();
  p.setText(SENTENCE);
  assert.equal(p.advanceTo(0), "");
});

test("the caption follows playback rather than the generated text", () => {
  const p = new CaptionPacer();
  p.beginTurn();
  p.setText(SENTENCE);
  const early = p.advanceTo(1);
  assert.ok(early.length > 0, "a second of speech should show something");
  assert.ok(early.length < SENTENCE.length, "one second must not reveal the whole sentence");
  assert.ok(SENTENCE.startsWith(early), "the caption is always a prefix of what is said");
});

test("a word is never shown half-written", () => {
  const p = new CaptionPacer();
  p.beginTurn();
  p.setText(SENTENCE);
  for (let s = 0.1; s < 4; s += 0.1) {
    const shown = p.advanceTo(s);
    if (shown && shown.length < SENTENCE.length) {
      assert.ok(!/\S$/.test(shown) || SENTENCE[shown.length] === " ",
        `"${shown}" ends mid-word`);
    }
  }
});

test("the caption never un-reveals a word it has already shown", () => {
  const p = new CaptionPacer();
  p.beginTurn();
  p.setText(SENTENCE);
  const at2 = p.advanceTo(2);
  // A barge-in resets the worklet's clock; progress can legitimately drop.
  const after = p.advanceTo(0.2);
  assert.equal(after, at2, "a lower playback figure must not rewind the caption");
});

test("text that has not been generated yet is never invented", () => {
  const p = new CaptionPacer();
  p.beginTurn();
  p.setText("Half a sen");
  const shown = p.advanceTo(30);
  assert.ok("Half a sen".startsWith(shown));
});

test("a completed turn measures the speaking rate instead of assuming it", () => {
  const p = new CaptionPacer();
  const before = p.charsPerSecond;
  assert.equal(before, DEFAULT_CHARS_PER_SECOND);
  // 100 characters in 10 seconds is a slow, deliberate voice: 10 chars/sec.
  p.beginTurn();
  p.completeTurn("x".repeat(100), 10);
  assert.ok(p.charsPerSecond < before, "a slower voice should lower the estimate");
  assert.ok(p.charsPerSecond >= MIN_CHARS_PER_SECOND);
});

test("a clipped turn does not poison the estimate", () => {
  const p = new CaptionPacer();
  const before = p.charsPerSecond;
  p.beginTurn();
  // Barge-in: 200 characters "spoken" in 0.4s, because the audio was cut.
  p.completeTurn("x".repeat(200), 0.4);
  assert.equal(p.charsPerSecond, before, "an interrupted turn measures the interruption");
});

test("an absurd rate is rejected rather than clamped into plausibility", () => {
  const p = new CaptionPacer();
  const before = p.charsPerSecond;
  p.beginTurn();
  p.completeTurn("x".repeat(10000), 2);   // 5000 chars/sec
  assert.equal(p.charsPerSecond, before);
  assert.ok(MAX_CHARS_PER_SECOND < 5000);
});

test("the measured rate survives the turn that measured it", () => {
  const p = new CaptionPacer();
  p.beginTurn();
  p.completeTurn("x".repeat(100), 10);
  const learned = p.charsPerSecond;
  p.beginTurn();
  assert.equal(p.charsPerSecond, learned, "the rate describes the voice, not the sentence");
});

test("a speaker that never plays still gets its caption", () => {
  const p = new CaptionPacer();
  p.beginTurn();
  p.setText(SENTENCE);
  assert.equal(p.advanceTo(0), "");
  assert.equal(p.revealAll(), SENTENCE);
});
