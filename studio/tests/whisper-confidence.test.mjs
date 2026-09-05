/*
  The confidence whisper.cpp was returning all along.

  `parseWhisperJson` hard-coded `confidence: -1` behind a comment saying
  whisper.cpp "does not expose a confidence in this output mode". Half
  true, and the half that was false mattered: `whisper-cli -oj` really
  does report nothing, but `-ojf` carries a per-token probability and
  `whisper-server`'s `verbose_json` carries both that and a language
  probability. The studio was throwing away the only number that tells
  speech from an empty room.

  Every fixture below is real — captured from
  ggml-large-v3-turbo-q8_0 on this machine at `language=auto`, trimmed
  to the fields under test. The probabilities are not invented, which
  matters, because the thresholds any gate draws will be drawn against
  numbers of this shape.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWhisperJson, speechConfidence } from '../server/speech-local.js';

/**
 * Six seconds of digital silence, through `whisper-server`. It is not
 * transcribed as nothing: it is transcribed as "Thank you.", the single
 * most common Whisper hallucination, with the words themselves scored
 * high. Only the language probability gives it away.
 */
const SERVER_SILENCE = {
  text: ' Thank you.',
  language: 'english',
  detected_language_probability: 0.36859720945358276,
  segments: [{
    text: ' Thank you.', start: 0.0, end: 29.98,
    words: [
      { word: ' Thank', probability: 0.248077 },
      { word: ' you', probability: 0.997969 },
      { word: '.', probability: 0.954495 },
    ],
  }],
};

/** One spoken sentence, same path, same model. */
const SERVER_SPEECH = {
  text: ' Open the composer and run the studio tests.',
  language: 'english',
  detected_language_probability: 0.9995876550674438,
  segments: [{
    text: ' Open the composer and run the studio tests.', start: 0.0, end: 2.3,
    words: [
      { word: ' Open', probability: 0.825587 },
      { word: ' the', probability: 0.992784 },
      { word: ' composer', probability: 0.580867 },
      { word: ' and', probability: 0.984297 },
    ],
  }],
};

/** The same silence through `whisper-cli -ojf`, decoder markers included. */
const CLI_SILENCE = {
  model: { type: 'large-v3-turbo' },
  result: { language: 'en' },
  transcription: [{
    text: ' Thank you.',
    offsets: { from: 0, to: 29980 },
    tokens: [
      { text: '[_BEG_]', p: 0.850192 },
      { text: ' Thank', p: 0.248085 },
      { text: ' you', p: 0.99797 },
      { text: '.', p: 0.954499 },
      { text: '[_TT_1499]', p: 0.698849 },
    ],
  }],
};

test('a spoken sentence scores far above an empty room', () => {
  const speech = parseWhisperJson(SERVER_SPEECH, 'auto');
  const silence = parseWhisperJson(SERVER_SILENCE, 'auto');

  assert.equal(speech.text, 'Open the composer and run the studio tests.');
  assert.equal(silence.text, 'Thank you.');
  assert.ok(speech.confidence > 0.8, `speech scored ${speech.confidence}`);
  assert.ok(silence.confidence < 0.5, `silence scored ${silence.confidence}`);
});

test('the language probability is what separates them, not the words', () => {
  const silence = parseWhisperJson(SERVER_SILENCE, 'auto');
  // Whisper is *sure* of the words it hallucinated: two of the three
  // score above 0.95. Averaging the words alone would have passed it.
  assert.ok(silence.acousticConfidence > 0.7, `words scored ${silence.acousticConfidence}`);
  assert.ok(silence.languageConfidence < 0.4, `language scored ${silence.languageConfidence}`);
  assert.equal(silence.confidence, silence.languageConfidence);
});

test('confidence is the weaker signal, so neither failure can hide behind the other', () => {
  assert.equal(speechConfidence(0.99, 0.26), 0.26);   // clear language, unsure words
  assert.equal(speechConfidence(0.37, 0.94), 0.37);   // sure words, not speech
  assert.equal(speechConfidence(-1, 0.88), 0.88);     // CLI: words are all there is
  assert.equal(speechConfidence(-1, -1), -1);         // nothing reported at all
});

test('the CLI path reports words only, and says so rather than guessing', () => {
  const result = parseWhisperJson(CLI_SILENCE, 'auto');
  assert.equal(result.languageConfidence, -1);
  // Decoder markers are excluded: with `[_BEG_]` and `[_TT_1499]` averaged
  // in this would read 0.75 instead of 0.73, drifting on bookkeeping.
  assert.ok(Math.abs(result.acousticConfidence - 0.733518) < 0.001, String(result.acousticConfidence));
  assert.equal(result.confidence, result.acousticConfidence);
});

test('a payload with no probabilities at all still reports -1, not a fabricated number', () => {
  const bare = {
    model: { type: 'base' },
    result: { language: 'en' },
    transcription: [{ text: ' hello there', offsets: { from: 0, to: 1200 } }],
  };
  const result = parseWhisperJson(bare, 'auto');
  assert.equal(result.confidence, -1);
  assert.equal(result.languageConfidence, -1);
  assert.equal(result.acousticConfidence, -1);
  assert.equal(result.text, 'hello there');
});
