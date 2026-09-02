import assert from "node:assert/strict";
import test from "node:test";

import {
  eligibleWatchers,
  formatBenchmarkReport,
  isSelfGraded,
  parseVerdict,
  watcherPrompt,
} from "../src/services/arenaVerdict.ts";
import { sandboxPath } from "../server/arena.js";

const contestant = (id, kind, label = id) => ({ id, kind, label, model: null });

const results = [
  {
    contestant: contestant("frontier", "frontier", "Frontier Auto"),
    sandbox: null, transcript: "I updated the parser.", toolCalls: 3,
    durationMs: 4200, tokens: 900, costUsd: 0, error: null,
    measurement: { filesChanged: 2, linesAdded: 10, linesRemoved: 3, files: [], diff: "--- a/x\n+++ b/x", diffTruncated: false,
      checks: [{ name: "Tests", command: "npm test", passed: true, durationMs: 900, output: "" }] },
  },
  {
    contestant: contestant("claude", "claude", "Claude Code"),
    sandbox: null, transcript: "Done.", toolCalls: 7,
    durationMs: 8100, tokens: 4000, costUsd: 0.21, error: null,
    measurement: { filesChanged: 1, linesAdded: 4, linesRemoved: 1, files: [], diff: "--- a/y\n+++ b/y", diffTruncated: false,
      checks: [{ name: "Tests", command: "npm test", passed: false, durationMs: 1200, output: "1 failing" }] },
  },
];

/* ── Who may judge ────────────────────────────────────────────────────────── */

test("either agent may judge, whoever is competing", () => {
  // The subject under test is Frontier; the challenger is the reference it is
  // measured against. Locking the operator out of their preferred judge costs
  // more than the bias does — so the bias is surfaced instead, below.
  const both = ["claude", "codex"];
  assert.deepEqual(eligibleWatchers([contestant("frontier", "frontier"), contestant("claude", "claude")]), both);
  assert.deepEqual(eligibleWatchers([contestant("frontier", "frontier"), contestant("codex", "codex")]), both);
  assert.deepEqual(eligibleWatchers([contestant("frontier", "frontier")]), both);
});

test("a watcher that also competed is flagged as self-grading", () => {
  const match = [contestant("frontier", "frontier"), contestant("claude", "claude")];
  assert.equal(isSelfGraded("claude", match), true, "Claude judging a match it is in");
  assert.equal(isSelfGraded("codex", match), false, "Codex is not in this match");
  assert.equal(isSelfGraded(null, match), false, "no watcher is not self-grading");
});

test("the brief tells a self-judging watcher that it is judging itself", () => {
  const withSelf = watcherPrompt("t", results, "claude");
  assert.match(withSelf, /one of the contestants above is you/i);
  assert.match(withSelf, /if its diff is worse, say so plainly/i);

  const independent = watcherPrompt("t", results, "codex");
  assert.equal(/one of the contestants above is you/i.test(independent), false);
});

/* ── Sandbox paths: the destructive operations go through these ───────────── */

test("a sandbox path stays inside the arena directory", () => {
  const { relative } = sandboxPath("/work", "run1", "frontier");
  assert.equal(relative, ".frontier-arena/run1/frontier");
});

test("ids that could escape the arena are refused", () => {
  for (const bad of ["../..", "a/b", "", "..", "x".repeat(65), "a b"]) {
    assert.throws(() => sandboxPath("/work", bad, "frontier"), /INVALID_RUN_ID/, `runId ${JSON.stringify(bad)}`);
    assert.throws(() => sandboxPath("/work", "run1", bad), /INVALID_CONTESTANT_ID/, `contestantId ${JSON.stringify(bad)}`);
  }
});

/* ── The watcher's brief ──────────────────────────────────────────────────── */


test("the brief carries the real diff, not just what each assistant claimed", () => {
  const prompt = watcherPrompt("Add a null guard", results);
  assert.match(prompt, /TASK: Add a null guard/);
  assert.match(prompt, /--- a\/x/, "the diff must be in the brief");
  assert.match(prompt, /I updated the parser\./, "so must the transcript");
  assert.match(prompt, /ground truth/, "and the watcher must be told which one wins when they disagree");
});

test("measured facts reach the watcher, including a failing check", () => {
  const prompt = watcherPrompt("t", results);
  assert.match(prompt, /Tests=PASS/);
  assert.match(prompt, /Tests=FAIL/);
  assert.match(prompt, /cost: \$0\.2100/);
  assert.match(prompt, /cost: not reported|cost: \$0\.0000/);
});

test("the watcher is told not to touch anything", () => {
  // It is handed read-only permission too, but saying so removes the ambiguity
  // that makes an agent "helpfully" fix what it was asked to judge.
  assert.match(watcherPrompt("t", results), /Do not run any commands or edit any files/);
});

/* ── Reading the verdict back ─────────────────────────────────────────────── */

test("a fenced verdict is parsed", () => {
  const verdict = parseVerdict('Sure!\n```json\n{"winner":"frontier","summary":"Tighter diff.","improvements":["Verify before finishing"]}\n```\nHope that helps.');
  assert.equal(verdict.winner, "frontier");
  assert.equal(verdict.summary, "Tighter diff.");
  assert.deepEqual(verdict.improvements, ["Verify before finishing"]);
});

test("a bare object with chatter around it is still parsed", () => {
  const verdict = parseVerdict('Here is my judgement: {"winner":"claude","summary":"Passed its own tests."} — let me know.');
  assert.equal(verdict.winner, "claude");
});

test("a watcher that ignored the schema still has its prose kept", () => {
  // Showing what it said beats showing an error where the verdict should be.
  const verdict = parseVerdict("Frontier was better but I will not use your format.");
  assert.equal(verdict.winner, null);
  assert.equal(verdict.summary, "");
  assert.match(verdict.raw, /Frontier was better/);
});

test("malformed fields are dropped rather than trusted", () => {
  const verdict = parseVerdict('```json\n{"winner":42,"summary":null,"improvements":["ok",7,{"a":1}],"scores":"nope"}\n```');
  assert.equal(verdict.winner, null, "a non-string winner is not a contestant id");
  assert.equal(verdict.summary, "");
  assert.deepEqual(verdict.improvements, ["ok"], "non-string suggestions are discarded");
  assert.deepEqual(verdict.scores, {});
});

/* ── The report, for the clipboard and for the chat ───────────────────────── */

const verdict = {
  winner: "frontier",
  summary: "Frontier made the smaller change and its tests passed.",
  scores: { frontier: { correctness: 4, scope: 5, evidence: "guarded the null at diff.ts:62" } },
  behaviour: {},
  improvements: ["Run the test suite before declaring the task finished"],
  raw: "",
};

test("the report leads with measured facts, not the opinion", () => {
  const report = formatBenchmarkReport("Add a null guard", results, verdict, "codex");
  const factsAt = report.indexOf("Files changed");
  const verdictAt = report.indexOf("### Verdict");
  assert.ok(factsAt > -1 && verdictAt > -1);
  assert.ok(factsAt < verdictAt, "numbers are true whoever judged; they come first");
});

test("every measured column reaches the report", () => {
  const report = formatBenchmarkReport("t", results, null, null);
  for (const label of ["Files changed", "Lines", "Tool calls", "Duration", "Tokens", "Cost", "Tests"]) {
    assert.match(report, new RegExp(`\\| ${label} \\|`), label);
  }
  assert.match(report, /\*\*fail\*\*/, "a failing check is emphasised, not buried");
});

test("an unreported cost stays unreported, and a real zero stays zero", () => {
  // Frontier runs locally and genuinely costs $0. Codex bills a subscription
  // and reports nothing. Those are different facts and must not print alike.
  const withUnreported = [
    results[0],                                   // costUsd: 0   — really free
    { ...results[1], costUsd: null },             // costUsd: null — unknown
  ];
  const report = formatBenchmarkReport("t", withUnreported, null, null);
  assert.match(report, /\$0\.0000/, "a real zero is shown as a zero");
  assert.match(report, /not reported/, "an unknown cost says so");
});

test("a self-graded run says so in the report, not only on screen", () => {
  // The clipboard version outlives the panel; the caveat has to travel with it.
  const report = formatBenchmarkReport("t", results, verdict, "claude", true);
  assert.match(report, /Self-graded/);
  assert.equal(/Self-graded/.test(formatBenchmarkReport("t", results, verdict, "codex", false)), false);
});

test("the verdict's evidence and suggestions survive into the report", () => {
  const report = formatBenchmarkReport("t", results, verdict, "codex");
  assert.match(report, /Frontier Auto/);
  assert.match(report, /correctness 4\/5/);
  assert.match(report, /guarded the null at diff\.ts:62/);
  assert.match(report, /1\. Run the test suite/);
});

test("a run with no verdict still produces a usable report", () => {
  const report = formatBenchmarkReport("t", results, null, null);
  assert.match(report, /## Benchmark/);
  assert.equal(/### Verdict/.test(report), false);
});
