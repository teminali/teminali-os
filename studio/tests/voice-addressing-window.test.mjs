/*
  The follow-up window used to be a blanket bypass.

  Instrumented before it was changed: for nine seconds after the assistant
  asked anything, `followUpWindow` alone added +0.32 to a 0.34 base and cleared
  the 0.62 line on timing and nothing else — and it also short-circuited the
  wake-word hard gate. Every one of these came back DIRECTED, in
  wake-word-only mode: a stray single word, a sentence about someone's recipe,
  and the recogniser's own noise loop.

  The window is still worth having; a terse answer to a question the assistant
  just asked is exactly what it exists to admit. So the tests below are in two
  halves, and the second half is the one that must not regress.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAddressing } from '../src/services/voice/addressing.ts';

const context = (over = {}) => ({
  assistantAskedQuestion: true,
  msSinceAssistantTurn: 1000,
  speakerMatch: null,
  hasProfile: false,
  requireWakeWord: true,
  requireSpeakerMatch: false,
  wakeWords: ['temy'],
  windowFocused: true,
  ...over,
});

const directed = (text, over) => scoreAddressing(text, context(over)).verdict.directed;

/* ── What the window must still let through ───────────────────────────────── */

test('a terse answer inside the window is still heard without a wake word', () => {
  for (const line of ['yes', 'no', 'the second one', 'sawa', 'go ahead']) {
    assert.equal(directed(line), true, line);
  }
});

test('the operator taking a moment to answer is not punished', () => {
  // A direct answer keeps its full weight regardless of the delay; only the
  // bare timing prior decays.
  assert.equal(directed('yes', { msSinceAssistantTurn: 8000 }), true);
});

test('a voice that matches the enrolled profile is believed in the window', () => {
  assert.equal(directed('the second one', { hasProfile: true, speakerMatch: 0.78 }), true);
});

/* ── What it must now refuse ──────────────────────────────────────────────── */

test('room chatter no longer becomes an answer just by arriving in time', () => {
  assert.equal(directed('I told her the recipe was wrong'), false);
});

test('the window closes against a voice that is decisively not the operator', () => {
  // Someone else answering the assistant's question is the exact failure the
  // window made invisible: the words are a perfect answer, the speaker is not.
  assert.equal(directed('the second one', { hasProfile: true, speakerMatch: 0.31 }), false);
});

test('a marginal speaker score is treated as no evidence, not as a mismatch', () => {
  // speakerProfile.ts is a weak verifier by its own admission, so only a
  // decisive mismatch is allowed to close the window.
  assert.equal(directed('the second one', { hasProfile: true, speakerMatch: 0.58 }), true);
});

test('the prior decays across the window instead of holding at full strength', () => {
  const line = 'the bus leaves at four';
  assert.equal(directed(line, { msSinceAssistantTurn: 500 }), true);
  assert.equal(directed(line, { msSinceAssistantTurn: 8000 }), false);
});

test('an open window does not defeat wake-word-only mode on its own', () => {
  // The hard gate now tests whether the window is *trusted*, not merely open.
  assert.equal(directed('I told her the recipe was wrong', { msSinceAssistantTurn: 200 }), false);
});

/* ── The reason must agree with the verdict ───────────────────────────────── */

test('a rejected turn is never explained as an answer that was accepted', () => {
  const { verdict } = scoreAddressing('the bus leaves at four', context({ msSinceAssistantTurn: 8000 }));
  assert.equal(verdict.directed, false);
  assert.doesNotMatch(verdict.reason, /Answering the question/);
  assert.match(verdict.reason, /Too long after the question/);
});

test('an accepted answer still says so', () => {
  const { verdict } = scoreAddressing('the second one', context());
  assert.equal(verdict.directed, true);
  assert.match(verdict.reason, /Answering the question just asked/);
});
