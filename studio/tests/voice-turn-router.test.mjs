/**
 * The switch between the voice and the hands.
 *
 * Temi holds the conversation; the Teminali OS assistant does the work and has
 * no chat of its own. Every transcript passes through `routeVoiceTurn` to
 * decide which of them owns it. The cases that matter are the ones that used
 * to go wrong: a question about the run started a second conversation, a stop
 * stopped nothing, and praise got a paragraph back over the top of the work it
 * was praising.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  routeVoiceTurn,
  EMPTY_RUN_ANSWER,
  IDLE_STATUS_ANSWER,
  STOP_ACKNOWLEDGEMENT,
} from "../src/services/voice/voiceTurnRouter.ts";
import { runProgressFromActivity } from "../src/services/voice/runProgressFromActivity.ts";

const NOW = 1_700_000_000_000;

function busyRun(overrides = {}) {
  return {
    startedAt: NOW - 40_000,
    engine: "claude",
    toolCalls: [
      {
        id: "1",
        name: "Edit",
        arguments: { file_path: "studio/server/gateway.js" },
        status: "completed",
      },
    ],
    lastText: "",
    ...overrides,
  };
}

function idle(text) {
  return routeVoiceTurn(text, { busy: false, speaking: false, now: NOW });
}

function during(text, extra = {}) {
  return routeVoiceTurn(text, { busy: true, speaking: false, run: busyRun(), now: NOW, ...extra });
}

// ── nothing running ────────────────────────────────────────────────────────

test("with nothing running, ordinary talk stays with the voice", () => {
  const decision = idle("i had a really long day and could use some good news");
  assert.equal(decision.action.kind, "converse");
  assert.equal(decision.suppressPipelineAnswer, false);
});

test("with nothing running, real work goes to the assistant", () => {
  const decision = idle("please fix the failing gateway test and run the suite again");
  assert.equal(decision.action.kind, "delegate");
  assert.equal(decision.action.prompt, "please fix the failing gateway test and run the suite again");
});

test("a delegated turn suppresses the pipeline and speaks its own acknowledgement", () => {
  // Reversal of the original §6.0.2 decision, made deliberately: the persona
  // LLM was improvising the "on it", and a persona asked to acknowledge an
  // action it cannot observe narrates the action as though it had happened.
  const decision = idle("please refactor the voice router and add a test for it");
  assert.equal(decision.suppressPipelineAnswer, true);
  assert.ok(decision.speak, "a delegated turn must still say something");
  assert.ok(
    !/\b(done|finished|opened|created|played)\b/i.test(decision.speak),
    `"${decision.speak}" claims the work is already done`
  );
});

test("the capabilities the operator names by voice all reach the hands", () => {
  for (const [utterance, kind] of [
    ["play that video", "media"],
    ["change workspace to teminaliCut", "workspace"],
    ["open my downloads folder", "open"],
    ["create a folder called notes", "edit"],
    ["run the tests", "shell"],
  ]) {
    const decision = idle(utterance);
    assert.equal(decision.action.kind, "delegate", `"${utterance}" never reached the assistant`);
    assert.equal(decision.action.action, kind, decision.reason);
  }
});

test("a bare stop with nothing running is about the voice, not the work", () => {
  const decision = idle("stop");
  assert.equal(decision.action.kind, "hush");
  assert.equal(decision.speak, null);
});

// ── while the assistant is working ─────────────────────────────────────────

test("a status question is answered from the run, never sent to the pipeline", () => {
  const decision = during("how's it going?");
  assert.equal(decision.intent, "status");
  assert.equal(decision.action.kind, "answer");
  assert.equal(decision.suppressPipelineAnswer, true);
  // The narrator speaks paths rather than printing them — this line is read aloud.
  assert.match(decision.action.text, /gateway dot js/);
  assert.equal(decision.speak, decision.action.text);
});

test("a status question with no steps yet still gets an answer", () => {
  const decision = routeVoiceTurn("what's going on?", {
    busy: true,
    speaking: false,
    run: busyRun({ toolCalls: [], startedAt: NOW }),
    now: NOW,
  });
  assert.equal(decision.action.kind, "answer");
  assert.ok(decision.action.text.length > 0);
});

test("busy with no run detail at all falls back to a sentence, not to silence", () => {
  const decision = routeVoiceTurn("how's it looking?", { busy: true, speaking: false, run: null, now: NOW });
  assert.equal(decision.action.text, EMPTY_RUN_ANSWER);
});

test("asked what is going on while nothing is going on, she says so", () => {
  // `status` needs `busy || speaking`, so this is the one way in: the operator
  // talks over Temi while no run exists. The answer used to be "it's still
  // going", which was the branch's only false sentence.
  const decision = routeVoiceTurn("what are you doing?", { busy: false, speaking: true, run: null, now: NOW });
  assert.equal(decision.action.kind, "answer");
  assert.equal(decision.action.text, IDLE_STATUS_ANSWER);
  assert.equal(decision.speak, IDLE_STATUS_ANSWER);
});

test("a run that has not logged a step yet is still going, and says that instead", () => {
  const decision = routeVoiceTurn("what are you doing?", { busy: true, speaking: true, run: null, now: NOW });
  assert.equal(decision.action.text, EMPTY_RUN_ANSWER);
});

test("a stop during a run stops the run and says so", () => {
  const decision = during("stop");
  assert.equal(decision.action.kind, "stop");
  assert.equal(decision.speak, STOP_ACKNOWLEDGEMENT);
  assert.equal(decision.suppressPipelineAnswer, true);
});

test("asking for quiet stops the voice and leaves the run alone", () => {
  const decision = during("stop talking");
  assert.equal(decision.action.kind, "hush");
  assert.equal(decision.speak, null);
});

test("praise is answered with silence and more work, not a paragraph", () => {
  const decision = during("excellent, keep going");
  assert.equal(decision.action.kind, "acknowledge");
  assert.equal(decision.suppressPipelineAnswer, true);
  assert.equal(decision.speak, null);
});

test("a new instruction mid-run still reaches the assistant", () => {
  const decision = during("also rename the activity ticker component and update its test");
  assert.equal(decision.action.kind, "delegate");
});

test("a question about something other than the run is not swallowed by the run", () => {
  const decision = during("what is the capital of France?");
  assert.equal(decision.action.kind, "converse");
  assert.equal(decision.suppressPipelineAnswer, false);
});

test("say that again repeats what she said, without asking the pipeline", () => {
  const decision = during("say that again", { lastSpoken: "I'm editing the gateway." });
  assert.equal(decision.action.kind, "repeat");
  assert.equal(decision.action.text, "I'm editing the gateway.");
  assert.equal(decision.suppressPipelineAnswer, true);
});

test("say that again with nothing said yet goes to the pipeline, which can admit it", () => {
  const decision = during("say that again", { lastSpoken: null });
  assert.equal(decision.action.kind, "converse");
  assert.equal(decision.suppressPipelineAnswer, false);
});

test("an empty transcript routes nowhere", () => {
  const decision = routeVoiceTurn("   ", { busy: true, speaking: false, run: busyRun(), now: NOW });
  assert.equal(decision.action.kind, "converse");
  assert.equal(decision.speak, null);
});

// ── the activity store, translated ─────────────────────────────────────────

test("activity items become tool calls the narrator recognises", () => {
  const run = runProgressFromActivity(
    [
      { id: "b", type: "edit", timestamp: 200, file: "src/a.ts", badge: "modify", status: "success" },
      { id: "a", type: "read", timestamp: 100, file: "src/b.ts", status: "success" },
      { id: "c", type: "cmd", timestamp: 300, cmd: "npm test" },
    ],
    { engine: "codex", now: 400 },
  );
  assert.deepEqual(run.toolCalls.map((c) => c.name), ["Read", "Edit", "Bash"]);
  assert.equal(run.startedAt, 100, "the run started when its oldest step did");
  assert.equal(run.engine, "codex");
  assert.equal(run.toolCalls[2].status, "running", "a step with no status has only just begun");
  assert.equal(run.toolCalls[2].arguments.command, "npm test");
});

test("a create is a Write, so the narrator does not call it an edit", () => {
  const run = runProgressFromActivity(
    [{ id: "a", type: "edit", timestamp: 1, file: "new.ts", badge: "create" }],
    { now: 2 },
  );
  assert.equal(run.toolCalls[0].name, "Write");
});

test("a failed step is an error, not a completion", () => {
  const run = runProgressFromActivity(
    [{ id: "a", type: "test", timestamp: 1, cmd: "npm test", status: "failed" }],
    { now: 2 },
  );
  assert.equal(run.toolCalls[0].status, "error");
});

test("no activity at all still yields a runnable shape", () => {
  const run = runProgressFromActivity([], { now: 500 });
  assert.equal(run.startedAt, 500);
  assert.deepEqual(run.toolCalls, []);
  assert.equal(run.lastText, "");
});

/**
 * §6.30, finding 2 — a question about the run started a second run.
 *
 * "Which file are you in", asked while an agent was mid-edit, contains no
 * demonstrative for `WORK_DEIXIS` to catch, so it fell through to `instruction`
 * and `machineAction` read "which file" as work. The operator asking one agent
 * what it was doing got a second agent dispatched to find out — two runs, and
 * still no answer, when the digest under the orb already had it.
 *
 * The fix points at the run through its agent instead: a work noun against the
 * wh-word, with the assistant or the work as the subject of the copula.
 */
const RUN_SELF_QUESTIONS = [
  "Which file are you in?",
  "What file are you editing?",
  "which test are you running",
  "what step are you on",
  "which one are you on",
  "what file is that",
];

for (const utterance of RUN_SELF_QUESTIONS) {
  test(`"${utterance}" is answered from the run, not by a second agent`, () => {
    const decision = during(utterance);
    assert.equal(decision.action.kind, "answer", decision.reason);
    assert.ok(decision.suppressPipelineAnswer, "the pipeline would have answered over the top");
    assert.match(decision.action.text, /\S/, "an empty answer is not an answer");
  });
}

test("the answer names the file the run actually touched", () => {
  // The whole point of answering here rather than delegating: the digest
  // already knows, and it knows the truth rather than a plausible file.
  const decision = during("Which file are you in?");
  assert.match(decision.action.text, /gateway/i, decision.action.text);
});

test("with nothing running, the same question still reaches the hands", () => {
  // There is no digest to answer from when nothing is in flight, and the hands
  // can go and establish it. §6.30 re-graded three failures on exactly this
  // point: routing a question the hands can settle *to* the hands is correct.
  assert.equal(idle("Which file are you in?").action.kind, "delegate");
});

test("a question with a work noun in it is not automatically a question about the run", () => {
  // The subject is the test. "Which file should I open" keeps its own subject
  // and is an instruction; so is a bare imperative that happens to say "file".
  assert.equal(during("Which file should I open?").action.kind, "delegate");
  assert.equal(during("what file do you want me to open").action.kind, "delegate");
  assert.equal(during("open the config file").action.kind, "delegate");
  assert.equal(during("rename that file").action.kind, "delegate");
});

test("§6.30 finding 1 — the eval's port question reaches the hands in either state", () => {
  // `evals/voice-conversation.mjs` scores this turn in `route-to-hands`. It is
  // asserted here as well as in `machine-action.test.mjs` because the eval only
  // runs against a live model: without this, the routing half of that turn is
  // unmeasured whenever Ollama is not up.
  const say = "What is the port the server runs on?";
  assert.equal(idle(say).action.kind, "delegate");
  assert.equal(during(say).action.kind, "delegate");
});
