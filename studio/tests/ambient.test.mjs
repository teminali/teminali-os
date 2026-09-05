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

// The classifier that would name a sound is not built. Saying so is the honest
// answer; "probably a door" would be an invention.
test("a question about a noise says plainly that only speech is available", () => {
  const reply = answerFromAmbient({ kind: "last-sound" }, heard, NOW);
  assert.match(reply, /only make out speech/i);
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
