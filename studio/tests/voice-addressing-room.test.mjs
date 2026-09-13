/**
 * A room with more than two voices in it.
 *
 * The operator ran a three-way conversation: himself, Temi, and another voice
 * assistant on another device. It held together on the model's own instincts,
 * because the code had no notion of a third party at all. Every sentence of two
 * words or more scored as directed at her, including "no I was talking to
 * ChatGPT", and her own name in a sentence about her was rewritten into a
 * command from whoever said it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { scoreAddressing, stripWakeWord, addressesOtherAssistant } from "../src/services/voice/addressing.ts";

const WAKE = ["temy", "temi", "teminali"];

/** Exactly what `TemiVoiceStage` passes on the live lane. */
const openSession = (over = {}) => ({
  assistantAskedQuestion: false,
  msSinceAssistantTurn: 99_999,
  speakerMatch: null,
  hasProfile: false,
  requireWakeWord: false,
  requireSpeakerMatch: false,
  wakeWords: WAKE,
  windowFocused: true,
  ...over,
});

const directed = (text, over) => scoreAddressing(text, openSession(over)).verdict.directed;

test("a sentence about her is not a sentence to her", () => {
  for (const said of ["Temi said the build is broken", "Temi says it's done", "let's ask Temi", "I'll tell teminali"]) {
    const { text, matched } = stripWakeWord(said, WAKE);
    assert.equal(matched, false, `${said}: a mention is not an address`);
    assert.equal(text, said, `${said}: and nothing may be stripped out of it`);
  }
});

test("being called by name still reaches her, comma or not", () => {
  const cases = [
    ["Temi, open the file", "open the file"],
    ["Temi open the file", "open the file"],
    ["Temi can you hear me", "can you hear me"],
    ["hey Temi what's the status", "what's the status"],
    ["open the file, teminali", "open the file"],
    ["Temi", ""],
  ];
  for (const [said, expected] of cases) {
    const { text, matched } = stripWakeWord(said, WAKE);
    assert.equal(matched, true, `${said}: she was called by name`);
    assert.equal(text, expected, `${said}: the name is stripped, the instruction is not`);
  }
});

test("another assistant called by name is answered by neither of us", () => {
  for (const said of [
    "ChatGPT, what do you think about that",
    "hey ChatGPT can you check that",
    "ok Google what's the weather",
    "Siri, set a timer",
    "what do you reckon, Alexa",
  ]) {
    assert.equal(directed(said), false, said);
  }
  assert.equal(addressesOtherAssistant("ChatGPT, what do you think"), "chatgpt");
});

test("another assistant as a topic is still her conversation", () => {
  // The same mistake in the other direction: he is talking to her ABOUT it.
  assert.equal(directed("ChatGPT is down again"), true);
  assert.equal(addressesOtherAssistant("ChatGPT is down again"), null);
});

test("her own name outranks the other one", () => {
  assert.equal(directed("Temi, ask ChatGPT what it thinks"), true);
});

test("the operator can say who he was talking to", () => {
  for (const said of ["no I was talking to ChatGPT", "sorry, not you", "I was talking to the other one"]) {
    assert.equal(directed(said), false, said);
  }
});

test("an answer inside the follow-up window is still hers", () => {
  // The window exists for exactly this and a third party must not close it.
  assert.equal(directed("yes go ahead", { assistantAskedQuestion: true, msSinceAssistantTurn: 1200 }), true);
});
