import test from "node:test";
import assert from "node:assert/strict";

import {
  AMBIENT_MAX_ENTRIES,
  AmbientMemory,
  answerFromAmbient,
  classifyAmbientQuery,
} from "../src/services/voice/ambientMemory.ts";

const NOW = 1_800_000_000_000;

function memoryWith(entries, windowMs, maxEntries) {
  const memory = new AmbientMemory(windowMs, maxEntries);
  for (const entry of entries) memory.remember(entry, NOW);
  return memory;
}

/* ── Recall phrasing ──────────────────────────────────────────────────────── */

test("questions about the room are recognised", () => {
  assert.deepEqual(classifyAmbientQuery("what did she say?"), { kind: "last-speech" });
  assert.deepEqual(classifyAmbientQuery("What did that person say"), { kind: "last-speech" });
  assert.deepEqual(classifyAmbientQuery("what did I miss"), { kind: "last-speech" });
  assert.deepEqual(classifyAmbientQuery("what was that noise?"), { kind: "last-sound" });
  assert.equal(classifyAmbientQuery("did you hear that?").kind, "recent");
  assert.equal(classifyAmbientQuery("what else have you heard").kind, "recent");
  assert.deepEqual(classifyAmbientQuery("forget what you heard"), { kind: "forget" });
});

// A false positive here swallows a real instruction, which is far worse than
// missing a recall question the operator can simply repeat.
test("ordinary instructions are not mistaken for recall", () => {
  for (const line of [
    "open the settings panel",
    "run the tests",
    "what did you do to the config",
    "say that again",
    "how's it going",
    "stop",
    "keep going",
    "",
  ]) {
    assert.equal(classifyAmbientQuery(line), null, line);
  }
});

/* ── Answers ──────────────────────────────────────────────────────────────── */

const heard = [
  { kind: "speech", text: "the meeting moved to four", speaker: "other", confidence: 0.6, at: NOW - 30_000 },
  { kind: "speech", text: "I'll grab lunch", speaker: "other", confidence: 0.5, at: NOW - 5_000 },
];

test("the last thing someone else said is recalled with how long ago", () => {
  const reply = answerFromAmbient({ kind: "last-speech" }, heard, NOW);
  assert.match(reply, /I'll grab lunch/);
  assert.match(reply, /just now/);
});

test("the operator's own words are not offered back as something overheard", () => {
  const mine = [{ kind: "speech", text: "run the tests", speaker: "operator", confidence: 0.9, at: NOW - 1000 }];
  assert.equal(answerFromAmbient({ kind: "last-speech" }, mine, NOW), null);
});

test("nothing overheard yields null rather than an invented answer", () => {
  assert.equal(answerFromAmbient({ kind: "last-speech" }, [], NOW), null);
  assert.equal(answerFromAmbient({ kind: "recent", withinMs: 60_000 }, [], NOW), null);
});

// Two different noes. Without a classifier the engine never listened for a
// sound, so it says what it can do; with one, "nothing" is an observation it
// is entitled to make. Guessing "probably a door" is neither.
test("a question about a noise answers from what the engine can actually do", () => {
  assert.match(answerFromAmbient({ kind: "last-sound" }, heard, NOW), /only make out speech/i);
  const withClassifier = answerFromAmbient({ kind: "last-sound" }, heard, NOW, { soundLabels: true });
  assert.match(withClassifier, /didn't pick out any sound/i);
  assert.doesNotMatch(withClassifier, /only make out speech/i);
});

test("a sound that was heard is named, with how long ago", () => {
  const room = [
    ...heard,
    { kind: "sound", text: "a car going past", label: "Car passing by", speaker: "unknown", confidence: 0.62, at: NOW - 20_000 },
  ];
  const reply = answerFromAmbient({ kind: "last-sound" }, room, NOW, { soundLabels: true });
  assert.match(reply, /a car going past/);
  assert.match(reply, /20 seconds ago/);
  // The most recent sound, not the most recent anything: "I'll grab lunch" is
  // newer and is not a noise.
  assert.doesNotMatch(reply, /lunch/);
});

test("did you hear that car is a question about the room", () => {
  assert.equal(classifyAmbientQuery("did you hear that car?").kind, "recent");
  assert.equal(classifyAmbientQuery("did you hear a car outside").kind, "recent");
  assert.equal(classifyAmbientQuery("did you just hear the doorbell").kind, "recent");
  assert.deepEqual(classifyAmbientQuery("what made that noise"), { kind: "last-sound" });
  assert.deepEqual(classifyAmbientQuery("what sound was that"), { kind: "last-sound" });
});

// A sound is heard, words are said. Reading a car out as "I heard: a car"
// is the tell that a log is being read rather than a room remembered.
test("sounds and speech are read out differently", () => {
  const car = [{ kind: "sound", text: "a car", label: "Car", speaker: "unknown", confidence: 0.7, at: NOW - 3_000 }];
  assert.match(answerFromAmbient({ kind: "recent", withinMs: 60_000 }, car, NOW), /I heard a car$/);
  const words = [{ kind: "speech", text: "over here", speaker: "other", confidence: 0.5, at: NOW - 3_000 }];
  assert.match(answerFromAmbient({ kind: "recent", withinMs: 60_000 }, words, NOW), /I heard: over here$/);
});

test("several recent things are summarised rather than listed in full", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    kind: "speech", text: `line ${i}`, speaker: "other", confidence: 0.5, at: NOW - i * 1000,
  }));
  const reply = answerFromAmbient({ kind: "recent", withinMs: 60_000 }, many, NOW);
  assert.match(reply, /^A few things:/);
  assert.equal(reply.split(";").length, 3, "at most three are read out");
});

/* ── The store ────────────────────────────────────────────────────────────── */

test("entries outside the retention window are gone, not merely hidden", () => {
  const memory = new AmbientMemory(60_000, 100);
  memory.remember({ kind: "speech", text: "old", speaker: "other", confidence: 0.5, at: NOW - 120_000 }, NOW);
  memory.remember({ kind: "speech", text: "new", speaker: "other", confidence: 0.5, at: NOW - 1_000 }, NOW);
  assert.equal(memory.size, 1);
  assert.deepEqual(memory.all(NOW).map((entry) => entry.text), ["new"]);
});

test("a loud room cannot grow the log without bound", () => {
  const memory = new AmbientMemory(600_000, 3);
  for (let i = 0; i < 10; i += 1) {
    memory.remember({ kind: "speech", text: `line ${i}`, speaker: "other", confidence: 0.5 }, NOW);
  }
  assert.equal(memory.size, 3);
  assert.deepEqual(memory.all(NOW).map((entry) => entry.text), ["line 7", "line 8", "line 9"]);
  assert.equal(AMBIENT_MAX_ENTRIES, 200, "the shipped ceiling");
});

test("empty transcripts are never stored", () => {
  const memory = new AmbientMemory();
  memory.remember({ kind: "speech", text: "   ", speaker: "other", confidence: 0.5 }, NOW);
  assert.equal(memory.size, 0);
});

test("forgetting is immediate and complete", () => {
  const memory = memoryWith(heard, 600_000, 100);
  assert.equal(memory.size, 2);
  assert.equal(memory.answer({ kind: "forget" }, NOW), "Forgotten.");
  assert.equal(memory.size, 0);
  assert.equal(memory.answer({ kind: "last-speech" }, NOW), null);
});

test("search finds an overheard line, newest first", () => {
  const memory = memoryWith(heard, 600_000, 100);
  const hits = memory.search("lunch", NOW);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, "I'll grab lunch");
  assert.deepEqual(memory.search("nothing here", NOW), []);
  assert.deepEqual(memory.search("  ", NOW), []);
});

test("the settings default keeps ambient memory on and bounded", async () => {
  const { DEFAULT_VOICE_SETTINGS } = await import("../src/services/voice/types.ts");
  assert.equal(DEFAULT_VOICE_SETTINGS.ambientMemory, true);
  const { AMBIENT_WINDOW_MS } = await import("../src/services/voice/ambientMemory.ts");
  assert.ok(AMBIENT_WINDOW_MS <= 15 * 60 * 1000, "the window must stay short enough to be defensible");
});
