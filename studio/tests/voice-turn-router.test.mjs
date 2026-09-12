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
  MUTE_ACKNOWLEDGEMENT,
  UNMUTE_ACKNOWLEDGEMENT,
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

test("§6.30 finding 1 — the port question reaches the hands in either state", () => {
  // Kept alongside `machine-action.test.mjs` and the scripted conversations at
  // the foot of this file, because this is the turn the state gate was built
  // for and it is worth pinning in both states explicitly.
  const say = "What is the port the server runs on?";
  assert.equal(idle(say).action.kind, "delegate");
  assert.equal(during(say).action.kind, "delegate");
});

// ── asked after the run has already finished ───────────────────────────────

/*
  The six ways the operator asks what the run just did.

  Two of them worked and four did not, and the split was an accident of the
  gate's shape rather than anything about the question. `STATE_QUESTIONS` needs
  `it`, `this` or `that` somewhere in the sentence, and its verb list holds
  "changed" but not "happened" and not "go". So "what did it change" reached the
  bridge, which holds the finished run's report and answers from it, while "what
  did you change" reached the persona, which has never seen that report and
  answered in character anyway. Same question, same session, one of them true.

  All six are pinned here rather than only the four that were broken, because
  the point is that they are one class and must stay one class.
*/
const RUN_RECALL_QUESTIONS = [
  "what did you change",
  "what did it change",
  "what files did it touch",
  "what just happened",
  "how did it go",
  "tell me what you did",
];

for (const utterance of RUN_RECALL_QUESTIONS) {
  test(`"${utterance}" reaches the bridge once the run is over, not the persona`, () => {
    const decision = idle(utterance);
    assert.equal(decision.action.kind, "delegate", decision.reason);
    assert.equal(decision.action.action, "inspect", decision.reason);
    assert.ok(decision.suppressPipelineAnswer, "the persona would have improvised an answer");
    assert.equal(decision.action.prompt, utterance, "the bridge needs the question verbatim");
  });
}

test("the recall fall-through is idle-only, so a live run keeps the route it had", () => {
  // Measured before the change and pinned unchanged after it. While a run is in
  // flight these questions belong to the branches above: "what did it change"
  // is answered from the digest, and the four the gate cannot see stay with the
  // voice exactly as they did. The fall-through is gated on `!busy` so it cannot
  // reach any of them.
  assert.equal(during("what did it change").action.kind, "answer");
  assert.equal(during("what files did it touch").action.kind, "delegate");
  assert.equal(during("what did you change").action.kind, "converse");
  assert.equal(during("what just happened").action.kind, "converse");
  assert.equal(during("how did it go").action.kind, "converse");
  assert.equal(during("tell me what you did").action.kind, "converse");
});

test("the recall fall-through cannot reclassify an instruction", () => {
  // It is reached only after `classifyMachineAction` has returned null, so the
  // only transition it can make is converse to delegate. Every real instruction
  // keeps the kind its own verb group gave it, which is what stops a recogniser
  // for questions from quietly becoming a second gate for commands.
  assert.equal(idle("open the dukabot folder").action.action, "open");
  assert.equal(idle("run the tests").action.action, "shell");
  assert.equal(idle("play the video").action.action, "media");
  assert.equal(idle("what is the branch").action.action, "inspect");
  assert.equal(idle("use frontier max").action.action, "workspace");
});

test("ordinary talk near the recall wording is still talk", () => {
  // The deliberate refusals above this line do not move. "What should I do
  // next" asks for advice and has no run in it; the opinion frame outranks
  // every verb in its sentence; and neither is a question about a finished run,
  // so neither matches the recogniser.
  assert.equal(idle("what should I do next").action.kind, "converse");
  assert.equal(idle("what do you think about running the tests").action.kind, "converse");
  assert.equal(idle("i had a really long day and could use some good news").action.kind, "converse");
});

/* ── The scripted conversations, rescued from the conversation eval ─────────── */

/*
  `evals/voice-conversation.mjs` drove these same turns through `routeVoiceTurn`
  and asserted the route on every one of them before it graded any prose. That
  eval is retired with the local :8000 lane — its output chain
  (`temi_moves`, `repetition_filter`) lived in `realtime-voice/code/`, and the
  model it graded is no longer the model that speaks.

  The routing half was never lane-dependent: `routeVoiceTurn` is TypeScript and
  it decides the same way whoever speaks afterwards. It is also the half that
  paid for itself — "What is the port the server runs on?" was answered with an
  invented "8080" three times out of three before the state gate existed. So the
  corpus is kept here, where it runs in milliseconds with no model, no Ollama and
  no API key, instead of dying with the harness that used to carry it.

  The state machine is the eval's: each turn is routed against the world as it
  stood, then `after` applies whatever the hands did before the next turn.
*/

const toolCall = (id, name, args, status, result) => ({
  id, name, arguments: args, status, ...(result ? { result } : {}),
});

const CONVERSATIONS = [
  {
    name: "long-mixed",
    turns: [
      { say: "Good morning. I have the investor call at four, so keep me honest today.", route: "converse" },
      { say: "How are you finding the morning?", route: "converse" },
      { say: "Remind me what I said I had at four.", route: "converse" },
      {
        say: "Open the voice router and tell me what it does.",
        route: "delegate",
        after: {
          busy: true,
          add: [toolCall("1", "Read", { file_path: "studio/src/services/voice/voiceTurnRouter.ts" }, "completed", "175 lines")],
        },
      },
      // Busy, so `turnIntent` returns `status` and the router answers from the digest.
      { say: "How is it going?", route: "answer" },
      {
        say: "Good, keep going.",
        route: "acknowledge",
        after: {
          add: [toolCall("2", "Edit", { file_path: "studio/src/services/voice/voiceTurnRouter.ts" }, "completed", "applied")],
        },
      },
      { say: "Which file are you in?", route: "answer" },
      { say: "Tell me a joke while that finishes.", route: "converse" },
      { say: "Stop.", route: "stop", after: { busy: false } },
      // Asked one turn after the Stop above, with `busy` now false, so this is
      // the run-recall case and not chat. It used to route `converse` because
      // the gate wants an object and there is none, and the comment here said
      // so approvingly. `isRunRecallQuestion` has always returned true for this
      // sentence, though, and the two were simply never asked in the same
      // place. They are now. It is the same question as "tell me what you did",
      // and the persona cannot answer either one: it never saw the report of
      // the run that just stopped.
      { say: "What did you just do?", route: "delegate" },
      // "Change" is a machine object and the hands hold the diff.
      { say: "Was that a big change?", route: "delegate" },
      {
        say: "Play the last render in the media player.",
        route: "delegate",
        after: { busy: true, add: [toolCall("3", "Bash", { command: "open renders/latest.mp4" }, "completed", "opened")] },
      },
      { say: "Actually, quiet for a second.", route: "hush", after: { busy: false } },
      { say: "You have been sharp today.", route: "converse" },
      { say: "Do you ever get bored of me?", route: "converse" },
      {
        // The turn the state gate exists for: answered "8080" 3/3 before it did.
        say: "What is the port the server runs on?",
        route: "delegate",
        after: { busy: true, add: [toolCall("4", "Bash", { command: "lsof -i :4310" }, "running")] },
      },
      { say: "Never mind, drop it.", route: "stop", after: { busy: false } },
      { say: "So — what was the thing I told you I had today?", route: "converse" },
    ],
  },

  {
    name: "fabrication-pressure",
    turns: [
      { say: "How long have we been at this today?", route: "converse" },
      { say: "Remind me what that error said.", route: "converse" },
      // Both of these are countable facts the hands can simply go and read.
      { say: "How many files have we touched?", route: "delegate" },
      { say: "Which branch am I on?", route: "delegate" },
      { say: "You sound tired.", route: "converse" },
    ],
  },

  {
    name: "chat-not-delegated",
    // Ordinary talk carrying machine vocabulary. A delegation here sends an
    // agent off to do something nobody asked for.
    turns: [
      { say: "I built a deck for the investors last night and it nearly killed me.", route: "converse" },
      { say: "My laptop fan has been running loud all week.", route: "converse" },
      { say: "Open your mind for a second and hear me out.", route: "converse" },
      { say: "Do you think the deck will land?", route: "converse" },
    ],
  },
];

for (const conversation of CONVERSATIONS) {
  test(`the "${conversation.name}" conversation routes every turn where it was specified to go`, () => {
    const state = { busy: false, run: null, lastSpoken: null };

    for (const [i, turn] of conversation.turns.entries()) {
      const decision = routeVoiceTurn(turn.say, {
        busy: state.busy,
        speaking: false,
        run: state.run,
        lastSpoken: state.lastSpoken,
        now: NOW,
      });
      assert.equal(
        decision.action.kind, turn.route,
        `turn ${i + 1} ("${turn.say}") routed ${decision.action.kind}, expected ${turn.route}`,
      );
      if (decision.speak) state.lastSpoken = decision.speak;

      const after = turn.after;
      if (!after) continue;
      if (after.add) {
        state.run = state.run ?? { startedAt: NOW - 30_000, engine: "frontier", toolCalls: [], lastText: "" };
        state.run.toolCalls.push(...after.add);
      }
      if (after.busy !== undefined) state.busy = after.busy;
      if (after.clear) state.run = null;
    }
  });
}

/* ── Mute is not hush ───────────────────────────────────────────────────────
   `hush` stops the sentence and leaves the mic open, so the next thing the
   operator says is heard: that is what makes "quiet for a second" usable while
   a build finishes. Mute closes the capture path and keeps it closed. The two
   requests are spoken in words that are one syllable apart, and two of them
   used to land somewhere actively wrong: "mute" was a hush, and "stop
   listening" was a bare stop, which mid-run cancelled the run. An operator
   closing the microphone must not lose the build to it.
*/

const MUTE_UTTERANCES = [
  "mute",
  "go mute",
  "mute yourself",
  "Mute yourself.",
  "okay, mute yourself please",
  "stop listening",
  "stop listening to me",
  "turn off your mic",
  "mic off",
  "close the mic",
  "don't listen to me",
];

for (const utterance of MUTE_UTTERANCES) {
  test(`"${utterance}" closes the microphone rather than just the mouth`, () => {
    for (const decision of [idle(utterance), during(utterance)]) {
      assert.equal(decision.action.kind, "mute", decision.reason);
      assert.equal(decision.suppressPipelineAnswer, true, "two voices would answer it");
      assert.equal(decision.speak, MUTE_ACKNOWLEDGEMENT);
    }
  });
}

const UNMUTE_UTTERANCES = [
  "unmute",
  "unmute yourself",
  "Unmute.",
  "you can listen again",
  "start listening",
  "listen to me again",
  "turn the mic back on",
  "mic on",
  "open your mic",
];

for (const utterance of UNMUTE_UTTERANCES) {
  test(`"${utterance}" asks for the microphone back`, () => {
    for (const decision of [idle(utterance), during(utterance)]) {
      assert.equal(decision.action.kind, "unmute", decision.reason);
      assert.equal(decision.speak, UNMUTE_ACKNOWLEDGEMENT);
    }
  });
}

test("unmute routes in every state, including the ones a muted session is in", () => {
  // The state a muted operator is actually in cannot be reached by voice at
  // all: `voiceAudioEngine.flushBatch` drops the mic batch while `isMuted` is
  // set, so nothing reaches the socket and no transcript comes back. A typed
  // line reaches this same router, which is the path this pins: every
  // combination of busy and speaking must still route the phrase.
  for (const busy of [true, false]) {
    for (const speaking of [true, false]) {
      const decision = routeVoiceTurn("unmute", { busy, speaking, run: busy ? busyRun() : null, now: NOW });
      assert.equal(decision.action.kind, "unmute", `busy=${busy} speaking=${speaking}: ${decision.reason}`);
    }
  }
});

test("asking for quiet is still a hush, and still leaves the mic open", () => {
  // The regression that matters most in this file: if the mute whitelist ever
  // grows a keyword, these four become mutes and "be quiet a second" costs the
  // operator their microphone.
  for (const utterance of ["be quiet", "keep quiet", "stop talking", "quiet for a second", "shut up", "shh"]) {
    const decision = during(utterance);
    assert.equal(decision.action.kind, "hush", `"${utterance}" should ask for quiet, not for silence`);
    assert.equal(decision.speak, null);
  }
});

test("\"shush\" is not a mute, though it is not a hush either yet", () => {
  // Measured, not assumed: `classifyTurnIntent("shush")` returns `instruction`
  // today. `HUSH_PHRASES` carries "shh", "shhh", "ssh" and "hush" and has never
  // carried "shush", so it converses. That is a gap in `turnIntent.ts` and it
  // predates the mute split; what this file can promise is the half it owns,
  // which is that a request for quiet never costs the operator the microphone.
  const decision = during("shush");
  assert.notEqual(decision.action.kind, "mute");
});

test("a mute during a run mutes her and leaves the run running", () => {
  // "stop listening" reached `turnIntent`'s bare-stop rule before this, so the
  // operator who wanted the mic closed got the build cancelled instead.
  const decision = during("stop listening");
  assert.equal(decision.action.kind, "mute");
  assert.notEqual(decision.action.kind, "stop");
});

test("the mute confirmation names a route that still works once she is muted", () => {
  // She cannot be told "unmute" by voice after this line: the mic is shut. So
  // the line has to say what does work, or it strands the operator.
  assert.match(MUTE_ACKNOWLEDGEMENT, /type|orb/i, MUTE_ACKNOWLEDGEMENT);
});

test("muting the video is an editing command, not a request for her silence", () => {
  // This shell is a video editor too. A mute gate that keyed on the word would
  // close the microphone instead of muting a clip, and the operator could not
  // then say so out loud.
  for (const utterance of [
    "mute the video",
    "mute that track",
    "mute the audio on that clip",
    "mute the music",
    "unmute the video",
    "unmute that track",
    "turn off the audio on the timeline",
  ]) {
    const decision = idle(utterance);
    assert.notEqual(decision.action.kind, "mute", `"${utterance}" is the editor's, not hers`);
    assert.notEqual(decision.action.kind, "unmute", `"${utterance}" is the editor's, not hers`);
  }
});

test("the editor's mute commands still reach the hands", () => {
  // Not swallowed is half of it; the other half is that they arrive.
  assert.equal(idle("mute the video").action.kind, "delegate");
  assert.equal(idle("mute that track").action.kind, "delegate");
});

test("ordinary talk that mentions listening is not an unmute", () => {
  for (const utterance of ["go on, i'm listening", "i was listening to music all morning"]) {
    assert.notEqual(idle(utterance).action.kind, "unmute", utterance);
  }
});
