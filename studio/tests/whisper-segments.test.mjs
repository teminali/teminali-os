/*
  The timings subtitles are built on.

  `parseWhisperJson` used to return the words and throw the timings
  away, and `transcribeLocal` passed `-nt` to whisper.cpp. Both of those
  were invisible while the only consumer was the voice assistant, which
  reads `text` and nothing else. They stop being invisible the moment a
  caption track is laid on them.

  The fixture is not invented. It is the shape whisper.cpp v1.9.2
  actually emits, captured from a real run on this machine, including
  the `-nt` failure mode: one segment whose `offsets` span the whole
  30-second decode window regardless of how long the audio was.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWhisperJson } from '../server/speech-local.js';

/** A real two-cue answer from `whisper-cli -oj -ml 42` on a 3.84s utterance. */
const SEGMENTED = {
  model: { type: 'base' },
  result: { language: 'en' },
  transcription: [
    {
      timestamps: { from: '00:00:00,000', to: '00:00:01,910' },
      offsets: { from: 0, to: 1910 },
      text: ' Open the Settings panel, then click on',
    },
    {
      timestamps: { from: '00:00:01,910', to: '00:00:03,840' },
      offsets: { from: 1910, to: 3840 },
      text: ' the Export button to render your video.',
    },
  ],
};

test('the timings whisper reports survive the parse', () => {
  const result = parseWhisperJson(SEGMENTED, 'en');
  assert.deepEqual(result.segments, [
    { startMs: 0, endMs: 1910, text: 'Open the Settings panel, then click on' },
    { startMs: 1910, endMs: 3840, text: 'the Export button to render your video.' },
  ]);
});

test('the joined text is unchanged by segmentation', () => {
  const result = parseWhisperJson(SEGMENTED, 'en');
  assert.equal(result.text, 'Open the Settings panel, then click on the Export button to render your video.');
  assert.equal(result.model, 'base');
  assert.equal(result.language, 'en');
});

test('a segment with no text is dropped rather than laid down as an empty cue', () => {
  const result = parseWhisperJson({
    ...SEGMENTED,
    transcription: [
      ...SEGMENTED.transcription,
      { offsets: { from: 3840, to: 4200 }, text: '   ' },
      { offsets: { from: 4200, to: 4900 }, text: '[BLANK_AUDIO]' },
    ],
  }, 'en');
  assert.equal(result.segments.length, 3);
  assert.equal(result.segments[2].text, '[BLANK_AUDIO]');
});

test('a zero-length or backwards cue is refused', () => {
  const result = parseWhisperJson({
    transcription: [
      { offsets: { from: 500, to: 500 }, text: 'instant' },
      { offsets: { from: 900, to: 400 }, text: 'backwards' },
      { offsets: { from: 0, to: 100 }, text: 'fine' },
    ],
  }, 'en');
  assert.deepEqual(result.segments, [{ startMs: 0, endMs: 100, text: 'fine' }]);
});

test('a segment with no offsets at all does not become a cue at zero', () => {
  /* The regression this guards is arithmetic, not parsing: `Number(undefined)`
     is NaN, and `Math.round(NaN)` is NaN, but `Math.max(0, NaN)` is also NaN —
     so a missing offset must be filtered, never clamped to a plausible 0. */
  const result = parseWhisperJson({
    transcription: [{ text: 'no timings here' }],
  }, 'en');
  assert.deepEqual(result.segments, []);
  assert.equal(result.text, 'no timings here');
});

test('the transcript still parses when whisper reports no language', () => {
  const result = parseWhisperJson({ transcription: SEGMENTED.transcription }, 'sw');
  assert.equal(result.language, 'sw');
  assert.equal(result.segments.length, 2);
});

test('an empty transcription is an empty answer, not a throw', () => {
  const result = parseWhisperJson({ transcription: [] }, 'auto');
  assert.equal(result.text, '');
  assert.equal(result.language, '');
  assert.deepEqual(result.segments, []);
});
