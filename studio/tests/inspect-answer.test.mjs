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

test("the command she ran is working, not the answer, and is never spoken", () => {
  /*
    Heard on a live call 2026-09-12. Asked about disk space, the agent showed
    the command in a fence and put the answer underneath it, and the operator
    was read both:

      "du -sh ~/Desktop The total size of all the files in your Desktop folder
       is 38 gigabytes."
      "df -h / You have about 26 gigabytes of available storage space
       remaining."

    Inlining the fence glued the command onto the front of the sentence, and
    since the only full stop was at the very end, the whole line counted as
    the first sentence. Nobody asked what was typed. What comes after a fence
    is the answer; the fence itself was the working.
  */
  assert.equal(
    outcome("```bash\ndu -sh ~/Desktop\n```\nThe total size of all the files in your Desktop folder is 38 gigabytes."),
    "The total size of all the files in your Desktop folder is 38 gigabytes.",
  );
  assert.equal(
    outcome("```bash\ndf -h /\n```\nYou have about 26 gigabytes of available storage space remaining."),
    "You have about 26 gigabytes of available storage space remaining.",
  );

  // The same report arrives unfenced just as often: the command alone on the
  // first line, with no punctuation to end it, and the answer on the next.
  assert.equal(
    outcome("du -sh ~/Desktop\nThe total size of all the files in your Desktop folder is 38 gigabytes."),
    "The total size of all the files in your Desktop folder is 38 gigabytes.",
  );
  assert.equal(
    outcome("df -h /\nYou have about 26 gigabytes of available storage space remaining."),
    "You have about 26 gigabytes of available storage space remaining.",
  );
});

test("a fence that is the last thing said is still the answer", () => {
  // Position is the whole rule, so it has to be pinned from both sides. The
  // block nothing follows is the payload and is read exactly as before, even
  // when an earlier block in the same reply was working and was dropped.
  assert.equal(outcome("The size is:\n```\n38G\n```"), "The size is: 38G");
  assert.equal(outcome("```\n38G\n```"), "38G");
  assert.equal(outcome("```bash\ndu -sh ~/Desktop\n```\nThe size is:\n```\n38G\n```"), "The size is: 38G");
});

test("dropping the working leaves no seam in the line", () => {
  // A dropped block becomes a single space, so one sitting between two pieces
  // of prose is where a double space or a leading one would show up. The
  // synthesiser will not read them, but this string is also what gets logged
  // and compared, so it has to come out as a person would have typed it.
  const spoken = outcome(
    "I checked both:\n```bash\ndu -sh ~/Desktop\ndf -h /\n```\nThe Desktop folder is 38 gigabytes and 26 remain free.",
  );
  assert.equal(spoken, "I checked both: The Desktop folder is 38 gigabytes and 26 remain free.");
  assert.doesNotMatch(spoken, /\s\s/, "no double space where the block was");
  assert.doesNotMatch(spoken, /^\s|\s$/, "and nothing left hanging off either end");
});

test("a sentence that merely mentions a command is left whole", () => {
  // The unfenced rule is the one that could eat an answer, so it only fires
  // on a line that cannot be a sentence: no terminating punctuation, and a
  // flag or a path after a command name no one writes in prose. These two
  // fail it on one count each and must survive untouched.
  assert.equal(
    outcome("npm run build is the one that fails\nI will look at it now."),
    "npm run build is the one that fails I will look at it now.",
  );
  assert.equal(outcome("df -h / says 26 gigabytes.\nThat is plenty."), "df -h / says 26 gigabytes.");
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
      /* The options are a named object rather than a literal at the call site
         because the stage also passes `approveCommand` through them — see
         voice-stage-gates.test.mjs. What is pinned here is unchanged: the kind
         is still in the options, and the options still reach `delegateTask`. */
      assert.match(stage, /const options: TaskDelegationOptions = \{[\s\S]{0,320}?action: action\.action/);
      assert.match(stage, /delegateTask\(action\.prompt, options\)/);
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
