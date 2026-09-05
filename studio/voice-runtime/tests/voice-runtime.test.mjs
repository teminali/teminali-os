import test from "node:test";
import assert from "node:assert/strict";

import {
  assessTranscript, dominantScript, isDegenerate, isScriptMismatch, isSilenceArtefact,
} from "../transcript-guard.js";
import { encodeWav, rms, voicedFraction, SAMPLE_RATE } from "../audio.js";
import { splitClauses } from "../tts.js";

/* ── Hallucination guards ─────────────────────────────────────────────────── */

// Every string in this block is one the operator actually saw on 2026-09-05.
test("a looping n-gram is not a sentence", () => {
  assert.equal(isDegenerate("Hanna, hanna, hanna, hanna, hanna, hanna."), true);
  assert.equal(isDegenerate("no no no no no no no"), true);
  assert.equal(isDegenerate("very very good"), false);
  assert.equal(isDegenerate("can you tell me how much storage we have free"), false);
  assert.equal(isDegenerate("yes"), false);
});

test("Whisper's subtitle fillers are treated as silence", () => {
  for (const line of ["Thank you.", "thanks for watching!", "Please subscribe", "you", ""]) {
    assert.equal(isSilenceArtefact(line), true, line);
  }
  assert.equal(isSilenceArtefact("thank you for opening the settings"), false);
});

test("the script of a transcript is identified", () => {
  assert.equal(dominantScript("hello there"), "latin");
  assert.equal(dominantScript("واني نزن"), "arabic");
  assert.equal(dominantScript("बालीच"), "devanagari");
  assert.equal(dominantScript("1234 !?"), null);
});

test("a Latin-language request that comes back in another script is rejected", () => {
  assert.equal(isScriptMismatch("बालीच", "en-GB"), true);
  assert.equal(isScriptMismatch("واني نزن", "en-US"), true);
  assert.equal(isScriptMismatch("habari za asubuhi", "sw-TZ"), false);
  // "auto" means the operator may genuinely switch language mid-session.
  assert.equal(isScriptMismatch("बालीच", "auto"), false);
});

test("a real utterance survives every guard", () => {
  const verdict = assessTranscript({
    text: "open the settings panel", language: "en-GB", voicedFraction: 0.42, durationMs: 1800,
  });
  assert.deepEqual(verdict, { accept: true, reason: null, text: "open the settings panel" });
});

test("silence, noise and a too-short clip are rejected with a reason", () => {
  const base = { text: "Thank you.", language: "en-GB", voicedFraction: 0.42, durationMs: 1800 };
  assert.equal(assessTranscript(base).reason, "silence-artefact");
  assert.equal(assessTranscript({ ...base, durationMs: 120 }).reason, "too-short");
  assert.equal(assessTranscript({ ...base, voicedFraction: 0.01 }).reason, "no-speech");
  assert.equal(assessTranscript({ ...base, text: "  " }).reason, "empty");
});

test("a rejected clip yields empty text, never a guess", () => {
  for (const text of ["Hanna, hanna, hanna, hanna.", "Thanks for watching!", "बालीच"]) {
    const verdict = assessTranscript({ text, language: "en-GB", voicedFraction: 0.4, durationMs: 2000 });
    assert.equal(verdict.accept, false, text);
    assert.equal(verdict.text, "", text);
  }
});

/* ── Audio ────────────────────────────────────────────────────────────────── */

// The measure is deliberately relative to the clip's own noise floor: what
// makes Whisper hallucinate is not quiet audio but *featureless* audio, and a
// steady hiss at any volume must read the same as silence.
test("speech is voiced; silence and steady hiss are not", () => {
  const silence = new Float32Array(SAMPLE_RATE);
  assert.equal(voicedFraction(silence), 0);

  const hiss = new Float32Array(SAMPLE_RATE);
  for (let i = 0; i < hiss.length; i += 1) hiss[i] = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 0.3;
  assert.ok(voicedFraction(hiss) < 0.1, `a steady tone must not read as speech, got ${voicedFraction(hiss)}`);

  // Bursts with gaps between them: the shape every real utterance has.
  const speech = new Float32Array(SAMPLE_RATE);
  for (let i = 0; i < speech.length; i += 1) {
    const loud = Math.floor(i / (SAMPLE_RATE * 0.1)) % 2 === 0;
    speech[i] = loud ? Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 0.3 : 0;
  }
  assert.ok(voicedFraction(speech) > 0.3, `expected bursts to read as speech, got ${voicedFraction(speech)}`);

  assert.ok(rms(hiss) > rms(silence));
});

test("a WAV carries the header the studio's audio element expects", () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 24_000);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt16LE(34), 16, "16-bit samples");
  assert.equal(wav.length, 44 + 5 * 2);
  // Full scale must not wrap round to negative.
  assert.equal(wav.readInt16LE(44 + 3 * 2), 32767);
  assert.equal(wav.readInt16LE(44 + 4 * 2), -32767);
});

/* ── Clause splitting ─────────────────────────────────────────────────────── */

test("long text is split on clauses so the first audio is not held up", () => {
  const clauses = splitClauses("I read the file, and then I ran the tests. Two of them failed.");
  assert.ok(clauses.length >= 3, `expected several clauses, got ${clauses.length}`);
  assert.equal(clauses[0], "I read the file,");
});

test("a clause with nothing to break on is cut on word count", () => {
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const clauses = splitClauses(long, 18);
  assert.equal(clauses.length, 3);
  for (const clause of clauses) assert.ok(clause.split(" ").length <= 18);
});

test("a short line stays whole", () => {
  assert.deepEqual(splitClauses("Two edits were made."), ["Two edits were made."]);
});
