/**
 * The distribution his real turns accumulate into.
 *
 * The 993 ms that moved the endpoint off Google is the median of four
 * scripted runs. These tests pin the arithmetic that will report the same
 * statistic for real conversations, because a median computed differently
 * cannot be compared with the one in DESIGN.md 6.0.46, and pin that a turn the
 * endpointer called too early is counted rather than quietly recovered.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  formatTurnLatency,
  recordTurn,
  resetTurnLatency,
  turnLatencyLog,
  turnLatencySummary,
} from "../src/services/voice/turnLatency.ts";

/** One answered turn. `commitMs` is ours, the remainder of the wait is Gemini's. */
function turn(firstAudioMs, commitMs = 1198, extra = {}) {
  return {
    commitMs,
    turnStartMs: firstAudioMs - 400,
    firstAudioMs,
    windowMs: 1216,
    corrections: 0,
    cutGapMs: 0,
    pacingFloorMs: 0,
    ...extra,
  };
}

test("the median is the one the A/B was reported with", () => {
  resetTurnLatency();
  // The measured "after" arm, verbatim: 3449, 3584, 3603, 3944 was quoted 3594.
  for (const ms of [3449, 3584, 3603, 3944]) recordTurn(turn(ms));
  assert.equal(turnLatencySummary().wait.medianMs, 3594, "an even count averages the two middles");

  resetTurnLatency();
  // And the "before" arm: 4239, 4534, 4638, 4765 was quoted 4586.
  for (const ms of [4239, 4534, 4638, 4765]) recordTurn(turn(ms));
  assert.equal(turnLatencySummary().wait.medianMs, 4586);

  resetTurnLatency();
  for (const ms of [3000, 3500, 5000]) recordTurn(turn(ms));
  assert.equal(turnLatencySummary().wait.medianMs, 3500, "an odd count takes the middle value");
});

test("order of arrival cannot change the distribution", () => {
  resetTurnLatency();
  for (const ms of [3944, 3449, 3603, 3584]) recordTurn(turn(ms));
  const s = turnLatencySummary();
  assert.equal(s.wait.medianMs, 3594);
  assert.equal(s.wait.worstMs, 3944);
  assert.equal(s.wait.p90Ms, 3944, "nearest rank: the top of four is the 90th percentile");
});

test("the split names whose second it is", () => {
  resetTurnLatency();
  // Our commit was steady at ~1198 ms while her first audio took ~3594.
  const summary = recordTurn(turn(3594, 1198));
  assert.equal(summary.commit.medianMs, 1198, "the part this lane owns");
  assert.equal(summary.model.medianMs, 2396, "the part that is Gemini's, and the larger one");
});

test("a turn that was cut off is counted, not averaged away", () => {
  resetTurnLatency();
  recordTurn(turn(3500));
  recordTurn(turn(3600, 1198, { corrections: 2, cutGapMs: 780, pacingFloorMs: 975 }));
  recordTurn(turn(3400, 1198, { corrections: 1, cutGapMs: 940, pacingFloorMs: 1175 }));

  const s = turnLatencySummary();
  assert.equal(s.turns, 3);
  assert.equal(s.cutTurns, 2, "two of three turns were called over early");
  assert.equal(s.corrections, 3, "one of them twice, and a per-turn count would hide that");
  assert.equal(s.tightestCutMs, 780, "the worst cut is the shortest silence, not the longest");
  assert.equal(s.pacingFloorMs, 1175, "the floor reported is the one currently in force");
});

test("the line he reads says CUT only when this turn was cut", () => {
  resetTurnLatency();
  const clean = turn(3594);
  assert.equal(formatTurnLatency(clean, recordTurn(clean)).includes("CUT"), false);

  const cut = turn(3600, 1198, { corrections: 1, cutGapMs: 780, pacingFloorMs: 975 });
  const line = formatTurnLatency(cut, recordTurn(cut));
  assert.match(line, /CUT 1x, tightest 780ms/);
  assert.match(line, /cut 1\/2 turns/, "and the session total, so one bad turn is seen in context");
  assert.match(line, /wait 3600ms \(commit 1198 \+ model 2402/);
});

test("a machine left running for a week cannot grow the log without bound", () => {
  resetTurnLatency();
  for (let i = 0; i < 520; i += 1) recordTurn(turn(3000 + i));
  assert.equal(turnLatencyLog().length, 500);
  assert.equal(turnLatencyLog()[499].firstAudioMs, 3519, "the newest turn is kept");
  assert.equal(turnLatencyLog()[0].firstAudioMs, 3020, "the oldest is dropped");
});

test("an empty log answers with zeros rather than NaN", () => {
  resetTurnLatency();
  const s = turnLatencySummary();
  assert.equal(s.turns, 0);
  assert.equal(s.wait.medianMs, 0);
  assert.equal(s.tightestCutMs, 0);
});
