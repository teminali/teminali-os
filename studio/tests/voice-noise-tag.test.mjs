/**
 * "[noise]" is not something the operator said.
 *
 * Measured 2026-09-13 on 0.0.17: Gemini's input transcription wrote room noise
 * as "[noise]", the stage showed it as a user bubble, and `gateSpokenTurn`
 * rejected it as not addressed to her. A rejected turn barges in and stops her
 * playback, so every burst of noise silenced the reply she was giving. The
 * engine now strips the tag before anything downstream sees the turn.
 *
 * Driven with the message shapes Gemini sends, as
 * `voice-live-engine-generation.test.mjs` does.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { GeminiLiveEngine } from "../src/services/voice/geminiLiveEngine.ts";

function harness() {
  const engine = new GeminiLiveEngine();
  const messages = [];
  engine.onMessage = (msg) => messages.push(msg);
  engine.onNote = () => {};
  engine.onError = () => {};
  const seen = (type) => messages.filter((m) => m.type === type);
  return { engine, seen };
}

const says = (text) => ({ serverContent: { outputTranscription: { text } } });
const hears = (text) => ({ serverContent: { inputTranscription: { text } } });
const TURN_END = { serverContent: { turnComplete: true } };

test("a turn that is only [noise] never reaches the stage", () => {
  const { engine, seen } = harness();
  engine.handleServerMessage(hears("[noise]"));
  assert.equal(seen("partial_user_request").length, 0, "the tag was captioned as speech");
  engine.handleServerMessage(TURN_END);
  assert.equal(seen("final_user_request").length, 0, "the tag was routed as a user turn");
});

test("a tag split across chunks is still a tag", () => {
  const { engine, seen } = harness();
  engine.handleServerMessage(hears("[noi"));
  engine.handleServerMessage(hears("se]"));
  engine.handleServerMessage(says("Hi."));
  assert.deepEqual(
    seen("final_user_request").map((m) => m.content),
    [],
  );
});

test("real words around a tag survive without it", () => {
  const { engine, seen } = harness();
  engine.handleServerMessage(hears("[noise] Okay, I was just saying"));
  engine.handleServerMessage(hears(" how are you? [noise]"));
  engine.handleServerMessage(says("I am well."));
  assert.deepEqual(
    seen("final_user_request").map((m) => m.content),
    ["Okay, I was just saying how are you?"],
  );
  assert.equal(seen("partial_user_request").at(-1).content, "Okay, I was just saying how are you?");
});

test("the next spoken turn after a noise-only turn is not glued to the tag", () => {
  const { engine, seen } = harness();
  engine.handleServerMessage(hears("[noise]"));
  engine.handleServerMessage(TURN_END);
  engine.handleServerMessage(hears("Hello, how are you?"));
  engine.handleServerMessage(says("Good."));
  assert.deepEqual(
    seen("final_user_request").map((m) => m.content),
    ["Hello, how are you?"],
  );
});

test("the stripper leaves ordinary speech and the directive alone", () => {
  const strip = GeminiLiveEngine.withoutNonSpeechTags;
  assert.equal(strip("[noise]"), "");
  assert.equal(strip("<noise>"), "");
  assert.equal(strip("(noise)"), "");
  assert.equal(strip("*noise*"), "");
  assert.equal(strip("noice"), "");
  assert.equal(strip("noise"), "");
  assert.equal(strip("[background music] play it"), "play it");
  assert.equal(strip("make it sound more like singing"), "make it sound more like singing");
  const directive = "[Say this to the user now, in your own voice: the build passed.]";
  assert.equal(strip(directive), directive);
});

test("pure punctuation, dots, and foreign noise hallucinations are stripped", () => {
  const strip = GeminiLiveEngine.withoutNonSpeechTags;
  assert.equal(strip("."), "");
  assert.equal(strip(". . . ."), "");
  assert.equal(strip("..."), "");
  assert.equal(strip("-"), "");
  assert.equal(strip("?"), "");
  assert.equal(strip("ครับ"), "");
  assert.equal(strip("100 บาท"), "");
  assert.equal(strip("โอ้ย ไม่ ได้ เอา"), "");
  assert.equal(strip("Ну"), "");
  assert.equal(strip("ஓகே நைஸ் நைஸ்"), "");
});

test("user turn finalizes promptly when inputTranscription.finished arrives", () => {
  const { engine, seen } = harness();
  engine.handleServerMessage({
    serverContent: {
      inputTranscription: { text: "Hey, check my computer storage.", finished: true },
    },
  });
  assert.equal(seen("final_user_request").length, 1);
  assert.equal(seen("final_user_request")[0].content, "Hey, check my computer storage.");
});

