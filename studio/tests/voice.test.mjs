import assert from "node:assert/strict";
import test from "node:test";

import {
  repairDeterministic,
  polishIsTrustworthy,
} from "../src/services/voice/transcriptRepair.ts";
import { scoreAddressing, stripWakeWord, parseClassifier, applyClassifier } from "../src/services/voice/addressing.ts";
import { completenessScore, Endpointer } from "../src/services/voice/turnTaking.ts";
import { speakableText, paceFor, PACE_SHORT_WORDS, PACE_LONG_WORDS, PACE_LONG_BOOST } from "../src/services/voice/speakable.ts";
import { normaliseAddress } from "../src/utils/address.ts";
import { segment } from "../src/utils/segment.ts";

/* ── Transcript repair ────────────────────────────────────────────────────── */

test("dictated file extensions become real ones", () => {
  const result = repairDeterministic("open app dot t s x and index dot css");
  assert.match(result.repaired, /app\.tsx/);
  assert.match(result.repaired, /index\.css/);
});

test("misheard technical terms are corrected", () => {
  assert.match(repairDeterministic("add a use effect hook").repaired, /useEffect/);
  assert.match(repairDeterministic("write it in type script").repaired, /TypeScript/);
  assert.match(repairDeterministic("push to git hub").repaired, /GitHub/);
});

test("filler words and stutters are removed", () => {
  const result = repairDeterministic("um so uh open the the file");
  assert.doesNotMatch(result.repaired, /\bum\b|\buh\b/i);
  // The duplicated article must collapse to one.
  assert.doesNotMatch(result.repaired, /the the/i);
  assert.ok(result.edits.some((edit) => edit.kind === "filler"));
});

test("a clean transcript is reported as clean and left alone", () => {
  const result = repairDeterministic("Open the settings panel.");
  assert.equal(result.repaired, "Open the settings panel.");
  assert.equal(result.clean, true);
});

test("repair never loses the original", () => {
  const raw = "um open app dot t s x";
  assert.equal(repairDeterministic(raw).raw, raw);
});

/* ── Polish guard ─────────────────────────────────────────────────────────── */

test("a polish that answers the question instead of cleaning it is rejected", () => {
  const before = "how do I add a table component";
  assert.equal(
    polishIsTrustworthy(before, "Sure! Here is how you add a table component: first create a file…"),
    false,
  );
});

test("a polish that shares almost no words with the input is rejected", () => {
  assert.equal(polishIsTrustworthy("open the terminal panel", "Delete every file in the repository."), false);
});

test("a genuine repunctuation is accepted", () => {
  assert.equal(
    polishIsTrustworthy("open the terminal and run the tests", "Open the terminal and run the tests."),
    true,
  );
});

/* ── Wake words ───────────────────────────────────────────────────────────── */

test("a leading wake word is stripped from the prompt", () => {
  const { text, matched } = stripWakeWord("Teminali, open the file", ["teminali"]);
  assert.equal(matched, true);
  assert.equal(text, "open the file");
});

test("a trailing wake word is stripped too", () => {
  const { text, matched } = stripWakeWord("open the file, teminali", ["teminali"]);
  assert.equal(matched, true);
  assert.equal(text, "open the file");
});

test("a wake word inside a sentence is left alone", () => {
  const { matched } = stripWakeWord("the teminali studio release", ["teminali"]);
  assert.equal(matched, false);
});

test("an exact wake word greeting like Hey Temy is matched and stripped cleanly", () => {
  const r1 = stripWakeWord("Hey Temy", ["temy", "teminali"]);
  assert.equal(r1.matched, true);
  assert.equal(r1.text, "");

  const r2 = stripWakeWord("Hey Temy!", ["temy", "teminali"]);
  assert.equal(r2.matched, true);
  assert.equal(r2.text, "");

  const r3 = stripWakeWord("Temy", ["temy", "teminali"]);
  assert.equal(r3.matched, true);
  assert.equal(r3.text, "");

  const r4 = stripWakeWord("Hey Temy, build a landing page", ["temy", "teminali"]);
  assert.equal(r4.matched, true);
  assert.equal(r4.text, "build a landing page");
});

/* ── Addressing ───────────────────────────────────────────────────────────── */

const baseContext = {
  assistantAskedQuestion: false,
  msSinceAssistantTurn: 60_000,
  speakerMatch: null,
  hasProfile: false,
  requireWakeWord: false,
  requireSpeakerMatch: false,
  wakeWords: ["teminali"],
  windowFocused: true,
};

test("being addressed by name is accepted", () => {
  const { verdict } = scoreAddressing("Teminali, run the tests", baseContext);
  assert.equal(verdict.directed, true);
  assert.equal(verdict.signals.wakeWord, true);
});

test("Saying Hey Temy directly addresses the assistant", () => {
  const { verdict } = scoreAddressing("Hey Temy", {
    ...baseContext,
    wakeWords: ["temy", "teminali"],
  });
  assert.equal(verdict.directed, true);
  assert.equal(verdict.signals.wakeWord, true);
});

test("speech aimed at another person is rejected", () => {
  const { verdict } = scoreAddressing("hold on, I'll call you back", baseContext);
  assert.equal(verdict.directed, false);
});

test("an answer to a question we just asked is accepted", () => {
  const { verdict } = scoreAddressing("yes", {
    ...baseContext,
    assistantAskedQuestion: true,
    msSinceAssistantTurn: 1200,
  });
  assert.equal(verdict.directed, true);
  assert.equal(verdict.signals.followUpWindow, true);
});

test("wake-word-only mode rejects everything unaddressed", () => {
  const { verdict, needsClassifier } = scoreAddressing("open the terminal", {
    ...baseContext,
    requireWakeWord: true,
  });
  assert.equal(verdict.directed, false);
  // A hard gate must not spend a model call to second-guess itself.
  assert.equal(needsClassifier, false);
});

test("a non-matching voice is rejected when strict speaker matching is on", () => {
  const { verdict } = scoreAddressing("open the terminal", {
    ...baseContext,
    requireSpeakerMatch: true,
    hasProfile: true,
    speakerMatch: 0.31,
  });
  assert.equal(verdict.directed, false);
  assert.match(verdict.reason, /did not match/i);
});

test("the classifier can flip a borderline verdict", () => {
  const { verdict } = scoreAddressing("that table needs another column", baseContext);
  const flipped = applyClassifier(verdict, parseClassifier("PERSON"));
  assert.equal(flipped.directed, false);
  const kept = applyClassifier(verdict, parseClassifier("ASSISTANT"));
  assert.equal(kept.directed, true);
});

test("an unparseable classifier reply yields no adjustment", () => {
  assert.equal(parseClassifier("I think maybe?"), null);
});

/* ── Turn taking ──────────────────────────────────────────────────────────── */

test("a dangling connector reads as unfinished", () => {
  assert.ok(completenessScore("open the file and") < completenessScore("open the file"));
});

test("a hesitation reads as unfinished", () => {
  assert.ok(completenessScore("open the file uh") < 0.4);
});

test("terminal punctuation reads as finished", () => {
  assert.ok(completenessScore("Open the file.") > 0.7);
});

test("the endpointer needs sustained speech before opening a turn", () => {
  const endpointer = new Endpointer();
  assert.equal(endpointer.push(true, ""), null);
  assert.equal(endpointer.push(true, ""), null);
  assert.deepEqual(endpointer.push(true, ""), { type: "speech-start" });
  assert.equal(endpointer.isSpeaking, true);
});

test("the endpointer holds the turn through a short pause", () => {
  const endpointer = new Endpointer();
  for (let i = 0; i < 3; i += 1) endpointer.push(true, "open the file and");
  const event = endpointer.push(false, "open the file and");
  assert.equal(event?.type, "holding");
});

/* ── Spoken output ────────────────────────────────────────────────────────── */

test("code blocks are announced rather than read out character by character", () => {
  const spoken = speakableText("Here it is:\n```ts\nconst x = 1\n```\nDone.");
  assert.doesNotMatch(spoken, /const x/);
  assert.match(spoken, /code block/);
});

test("markdown decoration is stripped from spoken text", () => {
  const spoken = speakableText("## Heading\n\n**bold** and `code` and [a link](http://x.com)");
  assert.doesNotMatch(spoken, /[#*`\[\]]/);
  assert.match(spoken, /a link/);
});

/* ── Address normalisation ────────────────────────────────────────────────── */

test("a bare port becomes a localhost URL", () => {
  assert.equal(normaliseAddress("5173").url, "http://localhost:5173");
});

test("a hostname gets https and a local host gets http", () => {
  assert.equal(normaliseAddress("example.com").url, "https://example.com");
  assert.equal(normaliseAddress("localhost:3000").url, "http://localhost:3000");
  assert.equal(normaliseAddress("127.0.0.1:4310/api/health").url, "http://127.0.0.1:4310/api/health");
});

test("dangerous schemes are refused rather than loaded", () => {
  for (const scheme of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<h1>x"]) {
    const result = normaliseAddress(scheme);
    assert.equal(result.url, null, `${scheme} must not resolve`);
    assert.ok(result.error);
  }
});

test("an out-of-range port is refused", () => {
  assert.equal(normaliseAddress("99999").url, null);
});

/* ── Reply segmentation ───────────────────────────────────────────────────── */

test("prose and code are separated", () => {
  const parts = segment("Do this:\n```ts\nconst x = 1\n```\nThen that.");
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((part) => part.kind), ["prose", "code", "prose"]);
  assert.equal(parts[1].text, "const x = 1");
});

test("a fence that names a file is recognised as one", () => {
  const [block] = segment("```tsx src/App.tsx\nexport default App\n```");
  assert.equal(block.filename, "src/App.tsx");
  assert.equal(block.language, "tsx");
});

test("a fence with only a language has no filename", () => {
  const [block] = segment("```bash\nnpm test\n```");
  assert.equal(block.filename, undefined);
  assert.equal(block.language, "bash");
});

test("text with no fences stays one prose segment", () => {
  const parts = segment("Just a sentence.");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, "prose");
});

/* ── Provider resolution ──────────────────────────────────────────────────── */

import { resolveProviders as resolve } from "../src/services/voice/resolution.ts";

const caps = (tier, label, patch = {}) => ({
  tier, label, asr: false, tts: false, languageDetection: false, streamingAsr: false,
  streamingTts: false, speakerEmbedding: false, languages: [], ...patch,
});

test("when the browser recogniser is unavailable, the local engine serves instead", () => {
  // This is the Electron case: Chromium's recogniser needs Google's speech
  // service, which the desktop shell has no key for. Reporting it as available
  // is what produced a dead microphone, so the resolution must route around it.
  const capabilities = {
    builtin: caps("builtin", "Built-in (browser)", { tts: true, detail: "no key in this shell" }),
    vibevoice: caps("vibevoice", "Local (whisper.cpp)", { asr: true, tts: true }),
  };
  const roster = { builtin: {}, vibevoice: {} };
  const resolved = resolve(roster, capabilities, "auto");

  assert.equal(resolved.asrTier, "vibevoice", "recognition must fall to the local engine");
  assert.ok(resolved.asr, "an ASR provider must still be selected");
});

test("recognition and synthesis resolve independently", () => {
  // Local recognition with browser synthesis is a normal, working combination.
  const capabilities = {
    builtin: caps("builtin", "Built-in (browser)", { tts: true }),
    vibevoice: caps("vibevoice", "Local (whisper.cpp)", { asr: true }),
  };
  const resolved = resolve({ builtin: {}, vibevoice: {} }, capabilities, "auto");
  assert.equal(resolved.asrTier, "vibevoice");
  assert.equal(resolved.ttsTier, "builtin");
});

test("no engine anywhere is reported rather than silently doing nothing", () => {
  const capabilities = {
    builtin: caps("builtin", "Built-in (browser)"),
    vibevoice: caps("vibevoice", "Local", { detail: "not installed" }),
  };
  const resolved = resolve({ builtin: {}, vibevoice: {} }, capabilities, "auto");
  assert.equal(resolved.asr, null);
  assert.equal(resolved.asrTier, null);
});

test("asking for the browser tier when it cannot recognise still yields a working engine", () => {
  const capabilities = {
    builtin: caps("builtin", "Built-in (browser)", { tts: true }),
    vibevoice: caps("vibevoice", "Local (whisper.cpp)", { asr: true, tts: true }),
  };
  const resolved = resolve({ builtin: {}, vibevoice: {} }, capabilities, "builtin");
  assert.equal(resolved.asrTier, "vibevoice");
  // And the downgrade is stated, not hidden.
  assert.equal(resolved.downgradedFrom, "builtin");
  assert.ok(resolved.downgradeReason);
});

/* ── Pace ─────────────────────────────────────────────────────────────────── */

test("short lines keep the operator's rate; long prose is read faster", () => {
  assert.equal(paceFor(1.15, "Okay, stopped."), 1.15);
  assert.equal(paceFor(1.15, Array(PACE_SHORT_WORDS).fill("word").join(" ")), 1.15);
  const long = Array(PACE_LONG_WORDS).fill("word").join(" ");
  assert.equal(paceFor(1.15, long), Math.round(1.15 * PACE_LONG_BOOST * 100) / 100);
  const mid = Array(Math.round((PACE_SHORT_WORDS + PACE_LONG_WORDS) / 2)).fill("word").join(" ");
  assert.ok(paceFor(1.15, mid) > 1.15 && paceFor(1.15, mid) < paceFor(1.15, long), "ramps between the two");
  assert.equal(paceFor(1.15, Array(200).fill("word").join(" ")), paceFor(1.15, long), "capped at the long boost");
});

test("pace stays inside what a speech engine reads naturally", () => {
  assert.equal(paceFor(0.1, "hi"), 0.5);
  assert.equal(paceFor(1.9, Array(80).fill("word").join(" ")), 2);
  assert.equal(paceFor(1, ""), 1);
});
