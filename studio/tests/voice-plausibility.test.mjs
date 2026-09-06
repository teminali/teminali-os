/*
  The gate that would have stopped the reported failure.

  The operator's screenshot: `"Olof, siri e prole, olof, olof, olof, olof."`
  was committed as a real turn, aborted a running command, and forced the
  model to reply that it had not caught that one. It is a Whisper repetition
  loop on non-speech audio, and every existing filter passed it — there was no
  bracketed artefact for `cleanTranscript` to strip and no shortage of words
  for `isNonSpeechOrBlank` to notice.

  The other half of these tests matters just as much: the operator must not be
  refused. A gate that drops "stop stop stop stop" while a command runs away
  is worse than the bug it fixes.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { scorePlausibility, repetitionShare, coherenceShare, baseLanguage } from '../src/services/voice/plausibility.ts';

/* ── The failure this exists for ──────────────────────────────────────────── */

test('the reported transcript is rejected before it can become a prompt', () => {
  const verdict = scorePlausibility('Olof, siri e prole, olof, olof, olof, olof.');
  assert.equal(verdict.plausible, false);
  assert.match(verdict.reason, /olof/i);
});

test('it is caught on text alone, with no confidence to lean on', () => {
  // The sidecar reports no confidence, and the CLI fallback reports nothing
  // about whether the audio was speech. The gate cannot depend on either.
  const verdict = scorePlausibility('Olof, siri e prole, olof, olof, olof, olof.', { confidence: -1 });
  assert.equal(verdict.plausible, false);
});

test('a looped phrase is caught, not just a looped word', () => {
  const verdict = scorePlausibility('Thanks for watching, thanks for watching, thanks for watching.');
  assert.equal(verdict.plausible, false);
  assert.match(verdict.reason, /looped/i);
});

test('the measured "tk tk tk" loop is rejected despite scoring high', () => {
  // Measured on ggml-large-v3-turbo-q8_0: confidence 0.813, better than some
  // correctly transcribed speech. Confidence alone could never catch this.
  const verdict = scorePlausibility('TK TK TK TK TK TK TK TK TK TK.', { confidence: 0.813 });
  assert.equal(verdict.plausible, false);
});

/* ── Hallucinated phrases, judged with the confidence beside them ─────────── */

test('silence transcribed as "Thank you." is dropped at the confidence silence scores', () => {
  const verdict = scorePlausibility('Thank you.', { confidence: 0.369 });
  assert.equal(verdict.plausible, false);
  assert.equal(verdict.signals.hallucination, true);
});

test('the operator actually saying thank you is not dropped', () => {
  const verdict = scorePlausibility('Thank you.', { confidence: 0.93 });
  assert.equal(verdict.plausible, true);
});

test('with no confidence reported, a suspect phrase is allowed rather than guessed at', () => {
  assert.equal(scorePlausibility('Thank you.').plausible, true);
  assert.equal(scorePlausibility('Thank you.', { confidence: -1 }).plausible, true);
});

/* ── The operator must never be refused ───────────────────────────────────── */

test('hammering a stop is not mistaken for a loop', () => {
  for (const line of [
    'stop stop stop stop stop',
    'no no no no no no',
    'wait wait wait wait wait wait',
    'hapana hapana hapana hapana hapana hapana',
  ]) {
    assert.equal(scorePlausibility(line).plausible, true, line);
  }
});

test('ordinary instructions pass, including terse and repetitive ones', () => {
  for (const line of [
    'run the studio tests',
    'open the composer and check the transcript chip',
    'yes',
    'no, the other one',
    'add a test for that, then run it again and show me the diff',
    'fungua faili la mtihani na uendeshe tena',
    'commit that as fix parenthesis voice close parenthesis stop the loop',
  ]) {
    assert.equal(scorePlausibility(line, { confidence: 0.9 }).plausible, true, line);
  }
});

test('a short answer is not penalised for being short', () => {
  /*
    Measured, because the opposite was assumed first: short utterances do NOT
    score low simply for carrying less audio. Through whisper-server on
    ggml-large-v3-turbo-q8_0 — "go ahead" 0.913, "no" 0.866, "yes" 0.811, and
    even a bare "stop" 0.741. All of them clear the 0.45 line comfortably, so
    the rule that drops a doubtful short utterance never sees a real one.
  */
  for (const [line, confidence] of [['go ahead', 0.913], ['yes', 0.811], ['no', 0.866], ['stop', 0.741]]) {
    assert.equal(scorePlausibility(line, { confidence }).plausible, true, line);
  }
});

test('code dictation full of identifiers is not called gibberish', () => {
  const line = 'rename scorePlausibility to scoreTranscript in plausibility ts and conversation ts';
  assert.equal(scorePlausibility(line, { confidence: 0.88 }).plausible, true);
});

/* ── Low confidence on its own ────────────────────────────────────────────── */

test('a short utterance the recogniser barely believes is speech is dropped', () => {
  const verdict = scorePlausibility('the door.', { confidence: 0.26 });
  assert.equal(verdict.plausible, false);
  assert.match(verdict.reason, /sure that was speech/);
});

test('a long utterance is not dropped for confidence alone', () => {
  // Sustained low confidence across many words is a microphone or an accent,
  // not an empty room, and refusing it would refuse the operator.
  const line = 'open the composer and run every studio test then tell me which ones failed';
  assert.equal(scorePlausibility(line, { confidence: 0.3 }).plausible, true);
});

/* ── The measures themselves ──────────────────────────────────────────────── */

test('repetitionShare finds the largest repeating unit', () => {
  assert.equal(repetitionShare('a b a b a b'.split(' ')).unit, 'a b');
  assert.equal(repetitionShare('a b a b a b'.split(' ')).count, 3);
  assert.equal(repetitionShare(['solo']).share, 0);
  assert.equal(repetitionShare('one two three four'.split(' ')).share, 0);
});

test('coherenceShare accepts real words and numbers, rejects the unpronounceable', () => {
  assert.equal(coherenceShare('open the composer'.split(' ')), 1);
  assert.equal(coherenceShare('run 42 tests'.split(' ')), 1);
  assert.equal(coherenceShare(['bcdfg', 'xkcdz']), 0);
  assert.equal(coherenceShare(['aaaaa']), 0);
});

/* ── A language the operator does not speak ───────────────────────────────── */

/*
  The second reported failure. The operator said "How are you?" and the
  transcript read "Bagaimana anda lakukan?" — fluent Indonesian, and a
  translation of what they had actually said. Every rule above passes it: it
  does not repeat, it is not an artefact phrase, every word is pronounceable,
  and the recogniser was confident. Whisper had reported the language all
  along and the engine had named the parameter `_language`.
*/
test('a confident decode into a language the operator does not speak is refused', () => {
  const verdict = scorePlausibility('Bagaimana anda lakukan?', {
    confidence: 0.95,
    language: 'id',
    expected: ['en-US', 'sw-TZ'],
  });
  assert.equal(verdict.plausible, false);
  assert.equal(verdict.signals.foreign, true);
  assert.match(verdict.reason, /id/);
});

test('confidence cannot rescue a foreign decode, because loops score high', () => {
  for (const confidence of [0.2, 0.6, 0.99, 1]) {
    assert.equal(
      scorePlausibility('Bagaimana anda lakukan?', { confidence, language: 'id', expected: ['en'] }).plausible,
      false,
    );
  }
});

test('a language the operator does speak passes, region tags and all', () => {
  // The operator's own languages: `en-US` from the system, `sw-TZ` pinned.
  // Whisper reports bare codes, so the comparison is on the base tag.
  assert.equal(scorePlausibility('how are you?', { confidence: 0.95, language: 'en', expected: ['en-US'] }).plausible, true);
  assert.equal(scorePlausibility('habari yako?', { confidence: 0.95, language: 'sw', expected: ['en-US', 'sw-TZ'] }).plausible, true);
  assert.equal(scorePlausibility('habari yako?', { confidence: 0.95, language: 'sw-KE', expected: ['sw-TZ'] }).plausible, true);
});

/*
  The rule is evidence, not suspicion. A recogniser that was *told* the
  language reports the language it was told, and a caller that cannot say what
  the operator speaks has said nothing — neither may reject anything.
*/
test('an unknown language or an unknown expectation rejects nothing', () => {
  assert.equal(scorePlausibility('Bagaimana anda lakukan?', { confidence: 0.95, expected: ['en'] }).plausible, true);
  assert.equal(scorePlausibility('Bagaimana anda lakukan?', { confidence: 0.95, language: 'id' }).plausible, true);
  assert.equal(scorePlausibility('Bagaimana anda lakukan?', { confidence: 0.95, language: 'id', expected: [] }).plausible, true);
});

test('baseLanguage takes the language off a tag', () => {
  assert.equal(baseLanguage('en-US'), 'en');
  assert.equal(baseLanguage('sw_TZ'), 'sw');
  assert.equal(baseLanguage('ID'), 'id');
  assert.equal(baseLanguage('  en  '), 'en');
});
