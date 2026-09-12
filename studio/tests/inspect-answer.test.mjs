/**
 * An inspect turn's answer has to survive the report.
 *
 * `machineAction` classifies "did the tests pass" as `inspect`, Temi says
 * "Checking now.", and the truthful part is supposed to arrive afterwards from
 * the run. It does — the wire is whole: `delegateTask` -> `onCompleted` ->
 * `sendAssistantDirective` -> the voice lane -> spoken. What did not survive was
 * the answer itself. `firstSentence` strips markdown so a work narration does
 * not read punctuation aloud, and on a question that strip deleted the payload:
 * measured 2026-09-10, eight of eight realistic answers to a state question
 * came out hollow — "The port is `8080`." spoken as "The port is ." and
 * "There are `3` errors in the log." as "There are errors in the log.", a
 * fluent sentence with the number removed.
 *
 * These are the cases that were wrong. The acknowledgement was never the lie;
 * the report was.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { summariseOutcome, NO_ANSWER, NOTHING_RAN } from "../src/services/voice/progressNarration.ts";
import { routeVoiceTurn } from "../src/services/voice/voiceTurnRouter.ts";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

const NOW = 1_700_000_000_000;
const ran = [{ id: "1", name: "bash", arguments: { command: "npm test" }, status: "completed" }];
const outcome = (lastText, extra = {}) =>
  summariseOutcome({ startedAt: NOW - 20_000, finishedAt: NOW, engine: "frontier", toolCalls: ran, lastText, ...extra });

/* ── The answer survives ──────────────────────────────────────────────────── */

test("a value in backticks is spoken, not deleted", () => {
  // Each of these lost its payload before the unwrap. The left column is what
  // an assistant actually writes; the right is what the operator must hear.
  const measured = [
    ["The port is `8080`.", "The port is 8080."],
    ["Yes — the build is still running (PID `4831`).", "Yes — the build is still running (PID 4831)."],
    ["There are `3` errors in the log.", "There are 3 errors in the log."],
    ["The tests passed: `2222 passed, 0 failed`.", "The tests passed: 2222 passed, 0 failed."],
    ["You are on branch `master`.", "You are on branch master."],
    ["`npm test` exited 0, so the suite is green.", "npm test exited 0, so the suite is green."],
  ];
  for (const [written, spoken] of measured) {
    assert.equal(outcome(written), spoken, `"${written}" must keep its answer`);
  }
});

test("a fence holding one short value is read; a listing is still dropped", () => {
  assert.equal(outcome("The answer is:\n```\n8080\n```"), "The answer is: 8080");
  assert.equal(outcome("```js\nconst port = 8080;\n```"), "const port = 8080;");
  // Forty-one characters of one line, and every multi-line block: output, not
  // an answer. Read aloud it is unbearable, so it goes as it always did.
  const long = "x".repeat(41);
  assert.equal(outcome(`Here:\n\`\`\`\n${long}\n\`\`\``), "Here:");
  assert.equal(outcome("Here:\n```\nsrc/a.ts\nsrc/b.ts\n```"), "Here:");
});

/* ── When there is no answer, say so ──────────────────────────────────────── */

test("an inspect run that came back with nothing admits it instead of saying Done", () => {
  assert.equal(outcome("", { kind: "inspect" }), NO_ANSWER);
  assert.equal(outcome("```\nsrc/a.ts\nsrc/b.ts\n```", { kind: "inspect" }), NO_ANSWER);
  // "Done." is the answer to "do this", never to "did it pass".
  assert.doesNotMatch(NO_ANSWER, /^Done\./);
});

test("work still reports as work", () => {
  assert.equal(outcome("", { kind: "edit" }), "Done.");
  assert.equal(outcome(""), "Done.", "an unclassified run is not a question");
  const edited = summariseOutcome({
    startedAt: NOW,
    engine: "codex",
    lastText: "All green.",
    kind: "edit",
    toolCalls: [{ id: "1", name: "Write", arguments: { path: "src/voice/echoGuard.ts" }, status: "completed" }],
  });
  assert.equal(edited, "Done. I changed echoGuard dot ts. All green.");
});

test("a run that did nothing does not say it is done", () => {
  /*
    Observed on 2026-09-11: a conversational turn was delegated, the stream
    resolved empty in under a millisecond without throwing, and the operator
    heard "On it." then "Done." Nothing had run. "Done." is a claim about work
    and there was none, so the one thing the report may not do is imply there
    was. Only `inspect` refused this before, which had the rule backwards: it
    is not about the kind of turn, it is about what was observed.
  */
  const nothing = (extra = {}) =>
    summariseOutcome({ startedAt: NOW, finishedAt: NOW + 1, engine: "frontier", toolCalls: [], lastText: "", ...extra });

  assert.equal(nothing(), NOTHING_RAN);
  assert.equal(nothing({ kind: "edit" }), NOTHING_RAN);
  assert.equal(nothing({ kind: "inspect" }), NO_ANSWER);

  // A run that made calls and changed no file did work. That one may say so.
  assert.equal(nothing({ toolCalls: ran }), "Done.");

  // And whatever it actually said still wins over both.
  assert.equal(nothing({ lastText: "The port is 8080." }), "The port is 8080.");
});

/* ── The wire the answer travels on ───────────────────────────────────────── */

test("a state question is delegated and acknowledged, so something must follow it", () => {
  const idle = { busy: false, run: null, lastSpoken: "", now: NOW };
  for (const question of ["is the build still running", "did the tests pass", "what is the port the server runs on"]) {
    const decision = routeVoiceTurn(question, idle, NOW);
    assert.equal(decision.action.kind, "delegate", `"${question}" is work for the hands`);
    assert.equal(decision.action.action, "inspect", "and a question about state is a look");
    assert.ok(decision.speak, "she says something while it happens");
  }
});

test("the turn's kind reaches the closing line", () => {
  // Without this the report cannot tell a question from an instruction, and
  // every silent inspect goes back to "Done."
  return Promise.all([
    readSource("../src/components/voice/TemiVoiceStage.tsx").then((stage) => {
      assert.match(stage, /delegateTask\(action\.prompt, \{[\s\S]{0,240}?action: action\.action/);
    }),
    readSource("../src/services/voice/teminaliAgentBridge.ts").then((bridge) => {
      assert.match(bridge, /summariseOutcome\(\{[\s\S]{0,260}?kind: options\.action/);
    }),
  ]);
});

test("a refused delegation is spoken, not only shown in a toast", async () => {
  // Every other exit reaches `onCompleted`. This one did not, so a duplicate
  // or a full queue left "On it." as the last thing said and put the reason on
  // a screen the operator is not looking at — which is why they asked aloud.
  const bridge = await readSource("../src/services/voice/teminaliAgentBridge.ts");
  assert.match(
    bridge,
    /const refusal = describeRejection\(result\.reason\);[\s\S]{0,700}?options\.onCompleted\?\.\(refusal\)/,
    "the refusal must reach onCompleted, which is what speaks",
  );
});

test("a delegated run that failed says so instead of reporting success", async () => {
  /*
    `AIService.streamMessage` catches everything and hands it to `onError`,
    then resolves — it never throws. The voice bridge was the one caller that
    passed no `onError`, so a 401 (or any other failure) arrived as a stream
    that produced nothing at all, the bridge's `catch` never ran, and the turn
    reported success. Observed 2026-09-11: "On it." and "Done." one
    millisecond apart, with no answer in between.
  */
  const bridge = await readSource("../src/services/voice/teminaliAgentBridge.ts");
  assert.match(bridge, /onError:\s*\(error\)\s*=>\s*\{\s*streamError = error;/);
  assert.match(bridge, /if \(streamError\) throw streamError;/);

  // And the throw must land before the success report is built, or it reports
  // success on the way past.
  assert.ok(
    bridge.indexOf("if (streamError) throw streamError;") < bridge.indexOf("const completionSummary = summariseOutcome("),
    "the raise must precede the outcome summary",
  );
});
