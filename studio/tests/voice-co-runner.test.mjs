/**
 * The voice lane's own agent, and the routing that reaches it.
 *
 * The operator's complaint was that speaking during a run destroyed the run:
 * every utterance that was not praise, a status check or a stop went to the
 * chat as a new instruction, so asking what the work was doing replaced the
 * work. These pin the three intents that fixed it and the digest the answer is
 * built from.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { classifyTurnIntent } from "../src/services/voice/turnIntent.ts";
import { runDigest, explainPrompt, tidyAnswer, explainRun, MAX_CALLS, MAX_SENTENCES } from "../src/services/voice/coRunner.ts";

const busy = { busy: true, speaking: false };
const speaking = { busy: false, speaking: true };
const idle = { busy: false, speaking: false };
const intentOf = (text, ctx = busy) => classifyTurnIntent(text, ctx).intent;

/* ── Silence is not cancellation ───────────────────────────────────────── */

test("asking for quiet does not cancel the work", () => {
  // These were all in the stop set, so telling the assistant to be quiet
  // cancelled the build it was narrating.
  for (const text of [
    "stop talking", "stop speaking", "be quiet", "keep quiet", "shut up",
    "hush", "shh", "silence", "mute", "no more talking", "stop narrating",
    "nyamaza", "acha kuongea",
  ]) {
    assert.equal(intentOf(text), "hush", `"${text}" should ask for quiet, not cancel`);
  }
});

test("a bare stop still stops the work", () => {
  // §6.8's doctrine is unchanged: these are about the run, not the voice.
  for (const text of ["stop", "stop it", "cancel", "cancel that", "wait", "hold on", "abort"]) {
    assert.equal(intentOf(text), "stop", `"${text}" should still cancel`);
  }
});

test("stopping a thing is neither — it is a task", () => {
  assert.equal(intentOf("stop the dev server"), "instruction");
});

/* ── Say that again ────────────────────────────────────────────────────── */

test("a repeat is recognised and never reaches the chat", () => {
  for (const text of [
    "say that again", "say it again", "repeat that", "come again", "one more time",
    "what did you say", "sorry what", "pardon", "i didn't catch that", "rudia", "sema tena",
  ]) {
    assert.equal(intentOf(text), "repeat", `"${text}" should repeat`);
  }
});

test("a repeat is still a repeat while the assistant is only speaking", () => {
  assert.equal(intentOf("say that again", speaking), "repeat");
});

/* ── Questions about the run ───────────────────────────────────────────── */

test("a question about the work in flight is explained, not sent to the chat", () => {
  for (const text of [
    "why did you edit that one?",
    "what was that command?",
    "what is that file for",
    "why that step",
    "what does that error mean",
    "which one is it running",
  ]) {
    assert.equal(intentOf(text), "explain", `"${text}" should be explained locally`);
  }
});

test("an imperative is a task however much it says 'that'", () => {
  // The veto that keeps real work reaching the chat.
  for (const text of ["rename that file", "delete that test", "run that command again", "fix that error"]) {
    assert.equal(intentOf(text), "instruction", `"${text}" is work`);
  }
});

test("a question about the world is not a question about the run", () => {
  // Deixis is the test. Swallowing these into a run digest would be worse
  // than interrupting, because the operator would get a wrong answer.
  for (const text of ["what is the capital of france", "how do i write a for loop", "who wrote this language"]) {
    assert.equal(intentOf(text), "instruction", `"${text}" belongs to the chat`);
  }
});

test("nothing running means nothing to explain", () => {
  assert.equal(intentOf("why did you edit that one?", idle), "instruction");
});

test("a status check still beats an explanation", () => {
  assert.equal(intentOf("how's it going?"), "status");
});

/* ── The digest the answer is built from ───────────────────────────────── */

const call = (over) => ({ id: "1", name: "Read", arguments: { file_path: "src/app.ts" }, status: "completed", ...over });
const run = (over) => ({ startedAt: 1000, engine: "frontier", toolCalls: [call({})], lastText: "", ...over });

test("the digest names what ran and how it went", () => {
  const text = runDigest(
    run({ toolCalls: [call({}), call({ name: "Bash", arguments: { command: "npm test" }, status: "error" })] }),
    31_000,
  );
  assert.match(text, /30 seconds/);
  assert.match(text, /npm test/);
  assert.match(text, /failed/);
});

test("a run that has done nothing says so rather than inventing a step", () => {
  assert.match(runDigest(run({ toolCalls: [] }), 1000), /has not run any tools yet/);
});

test("the digest is bounded, because a local window is small", () => {
  const many = Array.from({ length: 40 }, (_, i) => call({ id: String(i), name: `Tool${i}` }));
  const text = runDigest(run({ toolCalls: many }), 1000);
  assert.match(text, /28 earlier ones omitted/);
  assert.equal(text.includes("Tool39"), true, "the most recent step is kept");
  assert.equal(text.includes("Tool0 "), false, "the oldest is not");
  assert.equal((text.match(/^\d+\. /gm) ?? []).length, MAX_CALLS);
});

test("the prompt forbids inventing what the digest does not contain", () => {
  const prompt = explainPrompt("why that file?", run({}), 1000);
  assert.match(prompt, /why that file\?/);
  assert.match(prompt, /cannot see that part yet/);
  assert.match(prompt, /already running/);
});

/* ── The answer ────────────────────────────────────────────────────────── */

test("a spoken answer is trimmed to something sayable", () => {
  assert.equal(tidyAnswer("One. Two. Three. Four. Five."), "One. Two. Three.");
  assert.equal(tidyAnswer("**Bold** and `code`"), "Bold and code");
  assert.equal(tidyAnswer("Before ```js\nconst x = 1;\n``` after"), "Before after");
  assert.equal(tidyAnswer("   "), "");
  assert.equal(tidyAnswer("Just one sentence").split(".").length <= MAX_SENTENCES + 1, true);
});

test("the model answers when it can", async () => {
  const got = await explainRun("why that file?", run({}), {
    complete: async () => "It is reading the entry point to find the route table.",
    now: () => 1000,
  });
  assert.equal(got.source, "model");
  assert.match(got.text, /entry point/);
});

test("a missing model still owes the operator an answer", async () => {
  const got = await explainRun("why that file?", run({}), { now: () => 1000 });
  assert.equal(got.source, "rules");
  assert.ok(got.text.length > 0);
});

test("a model that throws, stalls or says nothing falls back to the rules", async () => {
  for (const complete of [
    async () => { throw new Error("no model"); },
    async () => "",
    async () => "   ",
  ]) {
    const got = await explainRun("why that file?", run({}), { complete, now: () => 1000 });
    assert.equal(got.source, "rules");
    assert.ok(got.text.length > 0);
  }
});

test("a slow model does not hold the microphone", async () => {
  const got = await explainRun("why that file?", run({}), {
    complete: (_p, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve("too late"), 5000);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
      }),
    now: () => 1000,
    timeoutMs: 40,
  });
  // The assertion is that it abandoned the model, not how many milliseconds
  // that took: a wall-clock bound flakes when the suite runs files in
  // parallel, and `source` says the same thing without a clock.
  assert.equal(got.source, "rules");
  assert.ok(got.text.length > 0);
});
