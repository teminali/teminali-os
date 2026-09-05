import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOMAIN_TERMS, MIN_KEY_LENGTH,
  buildLexicon, phoneticKey, repairVocabulary, vocabularyFromEnv,
} from "../lexicon.js";

test("phonetic key ignores the vowels a misrecognition gets wrong", () => {
  assert.equal(phoneticKey("Kokoro"), phoneticKey("Kakoro"));
  assert.equal(phoneticKey("Teminali"), phoneticKey("to Minoli"));
  assert.equal(phoneticKey("Teminali"), phoneticKey("to Minnally"));
});

test("phonetic key keeps the consonants a misrecognition gets right", () => {
  assert.notEqual(phoneticKey("Teminali"), phoneticKey("terminal"));
  assert.notEqual(phoneticKey("gateway"), phoneticKey("sidecar"));
});

test("doubling is spelling, not sound", () => {
  assert.equal(phoneticKey("minnally"), phoneticKey("minali"));
  // ...but a repeated sound with a vowel between is two sounds.
  assert.equal(phoneticKey("Kokoro"), "kkr");
});

test("keys shorter than the minimum are not claimed", () => {
  const lexicon = buildLexicon(["ab", "ox"], {});
  assert.equal(lexicon.size, 0);
  assert.ok(MIN_KEY_LENGTH >= 3);
});

test("two terms that sound alike claim nothing", () => {
  const lexicon = buildLexicon(["gateway", "gatway"], {});
  assert.equal(lexicon.get(phoneticKey("gateway")), undefined);
});

test("a term claims its own key", () => {
  const lexicon = buildLexicon(["Kokoro"], {});
  assert.equal(lexicon.get(phoneticKey("kakoro")), "Kokoro");
});

test("repairs the product name Whisper has never read", () => {
  assert.equal(
    repairVocabulary("the file is in my projects to Minoli Code Studio."),
    "the file is in my projects Teminali Code Studio.",
  );
});

test("repairs across a multi-word window, longest first", () => {
  assert.equal(repairVocabulary("open to Minnally Code"), "open Teminali Code");
});

test("leaves a word the model already spelled correctly exactly as it was", () => {
  assert.equal(repairVocabulary("Kokoro speaks"), "Kokoro speaks");
  assert.equal(repairVocabulary("STUDIO shouts"), "STUDIO shouts");
});

test("carries punctuation through the repair", () => {
  assert.equal(repairVocabulary("run it, Kakoro!"), "run it, Kokoro!");
});

test("does not rewrite a word the language already has", () => {
  const untouched = "open the terminal window and get the log";
  assert.equal(repairVocabulary(untouched), untouched);
});

test("empty and blank transcripts survive untouched", () => {
  assert.equal(repairVocabulary(""), "");
  assert.equal(repairVocabulary(null), "");
  assert.equal(repairVocabulary("   "), "   ");
});

test("an empty lexicon is a no-op, not a crash", () => {
  assert.equal(repairVocabulary("to Minoli", new Map()), "to Minoli");
});

test("environment vocabulary takes commas and newlines", () => {
  assert.deepEqual(vocabularyFromEnv("Fusion, phase-one\n Kilimanjaro "),
    ["Fusion", "phase-one", "Kilimanjaro"]);
  assert.deepEqual(vocabularyFromEnv(""), []);
  assert.deepEqual(vocabularyFromEnv(undefined), []);
});

test("a folder named in the environment is repaired like any other term", () => {
  const lexicon = buildLexicon([...DOMAIN_TERMS, ...vocabularyFromEnv("VibeVoice")]);
  assert.equal(repairVocabulary("open the vibe voice folder", lexicon), "open the VibeVoice folder");
});

test("a name whose sounds the model lost is beyond an exact-phonetic repair", () => {
  // The honest limit: "five zone" carries an f the folder never had, so no
  // skeleton lines up and the lexicon leaves it alone rather than guessing.
  const lexicon = buildLexicon([...DOMAIN_TERMS, ...vocabularyFromEnv("Faizan")]);
  assert.equal(repairVocabulary("open the five zone folder", lexicon), "open the five zone folder");
});
