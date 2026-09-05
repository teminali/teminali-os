/*
  Which system voice the desktop tier speaks with.

  Two defects met here and compounded. `say -v ?` pads a voice name into a
  column, but a long name leaves only one space before the language tag, and
  every voice Apple has shipped since the novelty era carries parentheses in
  its own name ("Samantha (English (US))"). The old pattern accepted at most
  two whitespace-free words, so on this machine it kept 71 of 187 voices and
  threw away every usable one. What survived for en-US was Albert, Bad News,
  Bahh, Bells, Boing, Jester, Zarvox and their siblings - voices macOS ships
  as jokes. `pickVoice` then took the first match, so the assistant spoke as
  Albert. That is the whole of "the voice sounds robotic".

  The fixture is real: it is `say -v '?'` on macOS 26, including the single-
  space padding of a long name, a three-digit region tag, and the duplicate
  line macOS prints for a voice installed at two quality tiers.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickVoice } from '../server/speech-local.js';

/** Verbatim `say -v '?'` lines, one of each shape that matters. */
const SAY_OUTPUT = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Bad News            en_US    # Hello! My name is Bad News.',
  'Zarvox              en_US    # Hello! My name is Zarvox.',
  'Samantha (English (US)) en_US    # Hello! My name is Samantha.',
  'Samantha (English (US)) en_US    # Hello! My name is Samantha.',
  'Daniel (English (UK)) en_GB    # Hello! My name is Daniel.',
  'Daniel (Enhanced)   en_GB    # Hello! My name is Daniel.',
  'Majed               ar_001   # Hello! My name is Majed.',
  'Eddy (French (France)) fr_FR    # Bonjour! Je m appelle Eddy.',
];

/** The parser under test, mirrored from localTtsStatus so no `say` is spawned. */
function parseVoices(lines) {
  const seen = new Set();
  return lines
    .map((line) => /^(.+?)\s+([a-z]{2,3}[-_][A-Za-z0-9]{2,3})\s+#/.exec(line))
    .filter(Boolean)
    .map((match) => ({ name: match[1].trim(), language: match[2].replace('_', '-') }))
    .filter((voice) => {
      const key = `${voice.name} ${voice.language}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

test('every line say prints is parsed, whatever the name and tag look like', () => {
  const voices = parseVoices(SAY_OUTPUT);
  const names = voices.map((v) => v.name);
  // A name with its own parentheses, and one padded by a single space.
  assert.ok(names.includes('Samantha (English (US))'));
  assert.ok(names.includes('Daniel (English (UK))'));
  // A three-digit region tag.
  assert.equal(voices.find((v) => v.name === 'Majed')?.language, 'ar-001');
  // The duplicate line macOS prints for a two-tier install collapses to one.
  assert.equal(names.filter((n) => n === 'Samantha (English (US))').length, 1);
  assert.equal(voices.length, SAY_OUTPUT.length - 1);
});

test('a novelty voice is never chosen while a real one exists', () => {
  const voices = parseVoices(SAY_OUTPUT);
  const chosen = pickVoice(voices, 'en-US');
  assert.ok(chosen, 'a voice should be chosen');
  for (const joke of ['Albert', 'Bad News', 'Zarvox']) {
    assert.notEqual(chosen, joke);
  }
});

test('nothing but joke voices means the system default, not a joke voice', () => {
  const onlyJokes = parseVoices([
    'Albert              en_US    # Hello! My name is Albert.',
    'Zarvox              en_US    # Hello! My name is Zarvox.',
  ]);
  assert.equal(pickVoice(onlyJokes, 'en-US'), null);
});

test('a quality tier outranks the region, so one downloaded voice is heard', () => {
  const voices = parseVoices(SAY_OUTPUT);
  // Enhanced en-GB beats ordinary en-US; the accent gap is smaller than the
  // quality gap, and an operator who downloaded one good voice wants it used.
  assert.equal(pickVoice(voices, 'en-US'), 'Daniel (Enhanced)');
  assert.equal(pickVoice(voices, 'en-GB'), 'Daniel (Enhanced)');
});

test('an ordinary voice does not cross a region boundary', () => {
  const voices = parseVoices([
    'Samantha (English (US)) en_US    # Hello!',
    'Daniel (English (UK)) en_GB    # Hello!',
  ]);
  assert.equal(pickVoice(voices, 'en-US'), 'Samantha (English (US))');
  assert.equal(pickVoice(voices, 'en-GB'), 'Daniel (English (UK))');
});

test('an exact-region quality voice wins over a cross-region one', () => {
  const voices = parseVoices([
    'Daniel (Enhanced)   en_GB    # Hello!',
    'Ava (Premium)       en_US    # Hello!',
  ]);
  assert.equal(pickVoice(voices, 'en-US'), 'Ava (Premium)');
});

test('a language with no voice at all falls back to the system default', () => {
  const voices = parseVoices(SAY_OUTPUT);
  assert.equal(pickVoice(voices, 'sw-KE'), null);
  assert.equal(pickVoice([], 'en-US'), null);
});

test('another language still resolves to its own voice', () => {
  const voices = parseVoices(SAY_OUTPUT);
  assert.equal(pickVoice(voices, 'fr-FR'), 'Eddy (French (France))');
});

test('Alex is a real voice, not a joke, and is never scored out', () => {
  // Apple's largest English asset at 885 MB and its flagship US male voice.
  // It sat on the novelty list inherited from the browser tier, so the app
  // would have refused the best male voice an operator could install.
  const voices = parseVoices([
    'Alex                en_US    # Hello!',
    'Albert              en_US    # Hello!',
  ]);
  assert.equal(pickVoice(voices, 'en-US'), 'Alex');
});

test('an Eloquence voice loses to a real one without being banned', () => {
  const withReal = parseVoices([
    'Eddy (English (US)) en_US    # Hello!',
    'Samantha (English (US)) en_US    # Hello!',
  ]);
  assert.equal(pickVoice(withReal, 'en-US'), 'Samantha (English (US))');

  // Alone, it is still a usable voice: better than falling back to whatever
  // `say` defaults to.
  const alone = parseVoices(['Eddy (English (US)) en_US    # Hello!']);
  assert.equal(pickVoice(alone, 'en-US'), 'Eddy (English (US))');
});

test('a downloaded premium voice beats the flagship default', () => {
  const voices = parseVoices([
    'Alex                en_US    # Hello!',
    'Ava (Premium)       en_US    # Hello!',
  ]);
  assert.equal(pickVoice(voices, 'en-US'), 'Ava (Premium)');
});
