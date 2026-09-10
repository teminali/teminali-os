import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateRepeatedPhrases } from "../src/services/voice/transcriptRepair.ts";
import {
  VoiceTextSync,
  wordEndIndex,
  matchAudibleLengthInTarget,
} from "../src/services/voice/voiceTextSync.ts";

test("deduplicateRepeatedPhrases removes doubled whole phrases", () => {
  const input = "Hey, how are you? Hey, how are you?";
  const result = deduplicateRepeatedPhrases(input);
  assert.equal(result, "Hey, how are you?");
});

test("deduplicateRepeatedPhrases handles punctuation mismatches between repetitions", () => {
  const input = "Hey, how are you? Hey, how are you.";
  const result = deduplicateRepeatedPhrases(input);
  assert.equal(result, "Hey, how are you?");
});

test("deduplicateRepeatedPhrases handles triple repetitions", () => {
  const input = "Hello there. Hello there. Hello there.";
  const result = deduplicateRepeatedPhrases(input);
  assert.equal(result, "Hello there.");
});

test("deduplicateRepeatedPhrases handles consecutive identical sentences with continuation", () => {
  const input = "Can you check the file? Can you check the file? And run the tests.";
  const result = deduplicateRepeatedPhrases(input);
  assert.equal(result, "Can you check the file? And run the tests.");
});

test("wordEndIndex finds the end of words accurately", () => {
  const text = "Hey! I'm doing well, thank you.";
  // charIndex 0 ('H') -> word is "Hey!"
  assert.equal(wordEndIndex(text, 0), 4);
  // charIndex 5 ('I') -> word is "I'm"
  assert.equal(wordEndIndex(text, 5), 8);
  // charIndex 9 ('d') -> word is "doing"
  assert.equal(wordEndIndex(text, 9), 14);
  // charIndex 27 ('y') -> word is "you."
  assert.equal(wordEndIndex(text, 27), 31);
});

test("matchAudibleLengthInTarget maps spoken words into formatted target", () => {
  const target = "Hey! I'm doing **well**, thank you. How can I help you today?";
  const audible1 = "Hey! I'm doing";
  const end1 = matchAudibleLengthInTarget(target, audible1);
  assert.equal(target.slice(0, end1), "Hey! I'm doing");

  const audible2 = "Hey! I'm doing well, thank you.";
  const end2 = matchAudibleLengthInTarget(target, audible2);
  assert.equal(target.slice(0, end2), "Hey! I'm doing **well**, thank you.");
});

test("VoiceTextSync in text mode reveals immediately without pacing delay", () => {
  const updates = [];
  const sync = new VoiceTextSync({
    onUpdate: (text) => updates.push(text),
  });

  sync.start(false); // text mode
  sync.pushTarget("Hello world!");
  assert.equal(updates.length, 1);
  assert.equal(updates[0], "Hello world!");
  assert.equal(sync.isPacing, false);
});

test("VoiceTextSync in voice mode waits for audible speech before revealing", () => {
  const updates = [];
  let finished = false;
  const sync = new VoiceTextSync({
    onUpdate: (text) => updates.push(text),
    onFinish: () => {
      finished = true;
    },
  });

  sync.start(true); // voice turn
  sync.pushTarget("Hey! I'm doing well, thank you.");

  // Model generated the text, but audio has not started yet
  assert.equal(updates.length, 0, "must remain in thinking state until audio starts");
  assert.equal(sync.isPacing, true);

  // Audio Chunk 1 starts playing: first word boundary
  sync.onSpeechProgress({
    chunk: "Hey! I'm doing well, thank you.",
    charIndex: 0,
    isChunkEnd: false,
    totalSpokenChars: 0,
  });
  assert.ok(updates.length > 0);
  assert.equal(updates[updates.length - 1], "Hey!");

  // Speech advances to "doing"
  sync.onSpeechProgress({
    chunk: "Hey! I'm doing well, thank you.",
    charIndex: 9,
    isChunkEnd: false,
    totalSpokenChars: 9,
  });
  assert.equal(updates[updates.length - 1], "Hey! I'm doing");

  // Speech completes chunk
  sync.onSpeechProgress({
    chunk: "Hey! I'm doing well, thank you.",
    charIndex: 31,
    isChunkEnd: true,
    totalSpokenChars: 31,
  });

  // All speech done event
  sync.onSpeechProgress({
    chunk: "",
    charIndex: 0,
    isChunkEnd: true,
    isAllSpeechDone: true,
    totalSpokenChars: 31,
  });

  assert.equal(updates[updates.length - 1], "Hey! I'm doing well, thank you.");
  assert.equal(finished, true);
  assert.equal(sync.isPacing, false);
});

test("VoiceTextSync on interrupt freezes at exactly what was spoken", () => {
  const updates = [];
  let finished = false;
  const sync = new VoiceTextSync({
    onUpdate: (text) => updates.push(text),
    onFinish: () => {
      finished = true;
    },
  });

  sync.start(true);
  sync.pushTarget("Hey! I'm doing well, thank you. Let me show you around the workspace.");

  // Speech reached "I'm doing"
  sync.onSpeechProgress({
    chunk: "Hey! I'm doing well, thank you.",
    charIndex: 9,
    isChunkEnd: false,
    totalSpokenChars: 9,
  });

  assert.equal(updates[updates.length - 1], "Hey! I'm doing");

  // User interrupts (barge-in)
  sync.interrupt();

  assert.equal(finished, true);
  assert.equal(sync.isPacing, false);
  // Must NOT reveal the rest of the sentence
  assert.equal(updates[updates.length - 1], "Hey! I'm doing");
});
