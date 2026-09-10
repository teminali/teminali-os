import assert from "node:assert/strict";
import test from "node:test";

import { classifyTurnIntent } from "../src/services/voice/turnIntent.ts";
import { EchoGuard, stripSelfEcho } from "../src/services/voice/echoGuard.ts";
import { describeToolCall, summariseProgress, summariseOutcome, speakablePath } from "../src/services/voice/progressNarration.ts";
import {
  planSpokenDigest,
  fallbackDigest,
  tidyDigest,
  digestPrompt,
  digestSource,
  digestBudgetMs,
  DigestStream,
  DIGEST_INPUT_CHARS,
  DIGEST_BUDGET_BASE_MS,
  DIGEST_BUDGET_PER_CHAR_MS,
} from "../src/services/voice/spokenDigest.ts";
import { scoreAddressing } from "../src/services/voice/addressing.ts";

/* ── Turn intent ──────────────────────────────────────────────────────────── */

const busy = { busy: true, speaking: false };
const talking = { busy: true, speaking: true };
const idle = { busy: false, speaking: false };

test("encouragement while a run is in flight does not become an instruction", () => {
  for (const line of ["Excellent, excellent, great, keep going.", "nice", "okay cool carry on", "sawa endelea", "love it, go ahead"]) {
    assert.equal(classifyTurnIntent(line, busy).intent, "acknowledge", line);
  }
});

test("the same words with nothing running go to the chat", () => {
  assert.equal(classifyTurnIntent("yes", idle).intent, "instruction");
  assert.equal(classifyTurnIntent("keep going", idle).intent, "instruction");
});

test("status questions are answered, not sent", () => {
  for (const line of [
    "How's it going?",
    "is it live on GitHub and Vercel yet",
    "are you done",
    "what are you doing now",
    "any update?",
    "did the tests pass",
    "where are we at",
    "umefika wapi",
  ]) {
    assert.equal(classifyTurnIntent(line, busy).intent, "status", line);
  }
});

test("a bare stop cancels; a stop with an object is an instruction", () => {
  assert.equal(classifyTurnIntent("stop", busy).intent, "stop");
  assert.equal(classifyTurnIntent("okay wait, hold on", talking).intent, "stop");
  assert.equal(classifyTurnIntent("no no no stop", busy).intent, "stop");
  // "stop talking" deliberately no longer cancels: it asks for quiet, and the
  // run it was narrating carries on. See the `hush` intent in turnIntent.ts.
  assert.equal(classifyTurnIntent("Temy, stop talking", talking).intent, "hush");
  assert.equal(classifyTurnIntent("stop the dev server and restart it", busy).intent, "instruction");
  assert.equal(classifyTurnIntent("stop", idle).intent, "stop");
});

test("a request for quiet survives the qualifier people attach to it", () => {
  // §6.30 finding 3. "quiet" was a hush and "quiet for a second" was a new
  // task, because a phrase set has to consume the whole utterance and nobody
  // says the bare word. The tail is stripped, so the wording stops mattering.
  for (const line of [
    "quiet for a second", "be quiet for a second", "quiet for a sec",
    "quiet for a minute", "shut up for a moment", "stop talking for a bit",
    "nyamaza kidogo",
  ]) {
    assert.equal(classifyTurnIntent(line, talking).intent, "hush", line);
  }
});

test("calling a run off is a stop however the abandonment is worded", () => {
  // §6.30 finding 4. "never mind" was in the set and "drop it" was not, so the
  // compound was consumed halfway, failed, and reached the agent as fresh work
  // — the operator asking for the run to end got another one.
  for (const line of [
    "never mind, drop it", "drop it", "forget about it", "skip it",
    "let it go", "don't bother", "cancel that for now",
    "wait a second", "hold on a sec", "subiri kidogo",
  ]) {
    assert.equal(classifyTurnIntent(line, busy).intent, "stop", line);
  }
});

test("a qualifier tail is never a verdict on its own", () => {
  // Stripping must not empty the utterance, and must not reach past a verb's
  // object: "skip it" abandons the run, "skip the slow tests" is work.
  assert.equal(classifyTurnIntent("for a second", busy).intent, "instruction");
  assert.equal(classifyTurnIntent("a minute", busy).intent, "instruction");
  assert.equal(classifyTurnIntent("drop the users table", busy).intent, "instruction");
  assert.equal(classifyTurnIntent("skip the slow tests for now", busy).intent, "instruction");
  assert.equal(classifyTurnIntent("keep going for a bit", busy).intent, "acknowledge");
});

test("a new instruction during a run is still an instruction", () => {
  assert.equal(classifyTurnIntent("also rename the component to VoicePanel", busy).intent, "instruction");
  assert.equal(classifyTurnIntent("make the orb bigger", talking).intent, "instruction");
  assert.equal(classifyTurnIntent("great, now add a dark mode toggle", busy).intent, "instruction");
});

/* ── Self-echo guard ──────────────────────────────────────────────────────── */

const spoken = ["I'll run the test suite now and report back.", "Editing Composer dot tsx."];

test("the assistant's own words coming back through the microphone are dropped", () => {
  const verdict = stripSelfEcho("I'll run the test suite now and report back", spoken, "speaking");
  assert.equal(verdict.echoed, true);
  assert.equal(verdict.text, "");
});

test("an echoed tail followed by real speech keeps only the real speech", () => {
  const verdict = stripSelfEcho("run the test suite now and report back also check the build", spoken, "speaking");
  assert.equal(verdict.echoed, true);
  assert.equal(verdict.text, "also check the build");
});

test("a person repeating the assistant's question as an answer gets through once it is quiet", () => {
  const asked = ["Should I run the tests?"];
  const quiet = stripSelfEcho("run the tests", asked, "quiet");
  assert.equal(quiet.echoed, false);
  assert.equal(quiet.text, "run the tests");
  // But the same words while the assistant is mid-sentence are echo.
  const during = stripSelfEcho("run the tests", asked, "speaking");
  assert.equal(during.echoed, true);
});

test("unrelated speech is untouched whatever the phase", () => {
  for (const phase of ["speaking", "tail", "quiet"]) {
    const verdict = stripSelfEcho("open the settings panel please", spoken, phase);
    assert.equal(verdict.echoed, false, phase);
    assert.equal(verdict.text, "open the settings panel please");
  }
});

test("EchoGuard forgets lines after the window and tracks the tail after speech ends", () => {
  const guard = new EchoGuard();
  guard.remember("Reading the composer now.", 1000);
  assert.equal(guard.phase(1500), "speaking");
  guard.markEnded(2000);
  assert.equal(guard.phase(2500), "tail");
  assert.equal(guard.phase(2000 + 5000), "quiet");
  assert.deepEqual(guard.recent(3000), ["Reading the composer now."]);
  assert.deepEqual(guard.recent(1000 + 40_000), []);
});

/* ── Progress narration ───────────────────────────────────────────────────── */

test("tool calls narrate as one plain present-tense line", () => {
  assert.equal(
    describeToolCall({ id: "1", name: "Read", arguments: { file_path: "/x/studio/src/components/chat/Composer.tsx" }, status: "running" }),
    "Reading Composer dot tsx.",
  );
  assert.equal(
    describeToolCall({ id: "2", name: "Edit", arguments: { file_path: "src/hooks/useVoice.ts" }, status: "running" }),
    "Editing useVoice dot ts.",
  );
  assert.equal(describeToolCall({ id: "3", name: "Bash", arguments: { command: "npm test" }, status: "running" }), "Running the tests.");
  assert.equal(describeToolCall({ id: "4", name: "Grep", arguments: { pattern: "commitTurn" }, status: "running" }), "Searching for commitTurn.");
  assert.equal(describeToolCall({ id: "5", name: "Read", arguments: { file_path: "a.ts" }, status: "completed" }), null);
});

test("a finished test run reports its outcome", () => {
  assert.equal(
    describeToolCall({ id: "6", name: "Bash", arguments: { command: "npm test" }, status: "completed", result: "ℹ tests 871\nℹ pass 871\nℹ fail 0" }),
    "Tests passed.",
  );
  assert.equal(
    describeToolCall({ id: "7", name: "Bash", arguments: { command: "npm test" }, status: "completed", result: "3 failing\nAssertionError" }),
    "Tests failed — looking at that.",
  );
});

test("a status answer is short and built from what actually happened", () => {
  const run = {
    startedAt: 100_000,
    engine: "claude",
    lastText: "I'm updating the voice engine so that praise no longer cancels a run.",
    toolCalls: [
      { id: "1", name: "Read", arguments: { file_path: "conversation.ts" }, status: "completed" },
      { id: "2", name: "Read", arguments: { file_path: "addressing.ts" }, status: "completed" },
      { id: "3", name: "Edit", arguments: { file_path: "conversation.ts" }, status: "completed" },
      { id: "4", name: "Bash", arguments: { command: "npm test" }, status: "running" },
    ],
  };
  const summary = summariseProgress(run, 100_000 + 95_000);
  assert.match(summary, /about 2 minutes in/i);
  assert.match(summary, /read 2 files/);
  assert.match(summary, /edited conversation dot ts/);
  assert.match(summary, /Right now: running the tests/);
  assert.ok(summary.split(/[.!?]\s/).length <= 4, summary);
});

test("with no tool calls yet the status answer falls back to the latest note", () => {
  const summary = summariseProgress({ startedAt: 0, engine: "frontier", lastText: "Looking at how the composer renders the orb. Then I'll change it.", toolCalls: [] }, 12_000);
  assert.match(summary, /Looking at how the composer renders the orb\./);
  assert.doesNotMatch(summary, /Then I'll/);
});

test("the outcome line names what changed", () => {
  const line = summariseOutcome({
    startedAt: 0,
    engine: "codex",
    lastText: "All green.",
    toolCalls: [{ id: "1", name: "Write", arguments: { path: "src/voice/echoGuard.ts" }, status: "completed" }],
  });
  assert.equal(line, "Done. I changed echoGuard dot ts. All green.");
  assert.equal(speakablePath("/a/b/my-file_name.test.ts"), "my file name dot test dot ts");
});

/* ── Spoken digest ────────────────────────────────────────────────────────── */

test("a short remainder is read out; a long one is summarised with a spoken fallback", () => {
  assert.equal(planSpokenDigest("").mode, "silent");
  assert.deepEqual(planSpokenDigest("Two files changed. Tests pass."), { mode: "verbatim", fallback: "Two files changed. Tests pass." });
  const long = `${"The migration touches the schema, the repository layer and both API routes. ".repeat(8)}Nothing else changed.`;
  const plan = planSpokenDigest(long);
  assert.equal(plan.mode, "summarise");
  assert.equal(plan.fallback, "The migration touches the schema, the repository layer and both API routes. The rest is in the chat.");
  assert.equal(planSpokenDigest(long, false).mode, "verbatim");
});

test("digest prompt and tidy keep the model on a short leash", () => {
  assert.match(digestPrompt("hello"), /at most two short sentences/i);
  assert.equal(tidyDigest("Summary: I **fixed** the `echo` bug and the tests pass."), "I fixed the echo bug and the tests pass.");
  assert.equal(tidyDigest("ok"), "");
  assert.equal(fallbackDigest("Short one. Then more."), "Short one. The rest is in the chat.");
});

test("the model is shown the head and tail of the remainder, code fences dropped", () => {
  assert.equal(digestSource("  a  b \n\n c "), "a b c");
  assert.equal(digestSource("Done.\n```ts\nconst x = 1;\n```\nNext."), "Done. (code) Next.");
  const long = `${"Head sentence number one. ".repeat(60)}END-MARKER ${"tail words ".repeat(40)}`;
  const shown = digestSource(long);
  assert.ok(shown.length <= DIGEST_INPUT_CHARS + " […] ".length, `shown ${shown.length} chars`);
  assert.ok(shown.startsWith("Head sentence number one."));
  assert.ok(shown.includes(" […] "));
  assert.ok(shown.endsWith("tail words"));
  assert.ok(!shown.includes("END-MARKER"));
  // The prompt can never carry more than the bounded source.
  const prompt = digestPrompt("x".repeat(20_000));
  assert.ok(prompt.length < 400 + DIGEST_INPUT_CHARS, `prompt ${prompt.length} chars`);
});

test("the first-sentence budget grows with what the model is shown, then caps", () => {
  assert.equal(digestBudgetMs(0), DIGEST_BUDGET_BASE_MS);
  assert.equal(digestBudgetMs(320), DIGEST_BUDGET_BASE_MS + 320 * DIGEST_BUDGET_PER_CHAR_MS);
  assert.equal(digestBudgetMs(DIGEST_INPUT_CHARS), DIGEST_BUDGET_BASE_MS + DIGEST_INPUT_CHARS * DIGEST_BUDGET_PER_CHAR_MS);
  assert.equal(digestBudgetMs(10_000), digestBudgetMs(DIGEST_INPUT_CHARS));
  assert.equal(digestBudgetMs(-5), DIGEST_BUDGET_BASE_MS);
});

test("a streamed digest is spoken sentence by sentence and stops at two", () => {
  const stream = new DigestStream();
  assert.deepEqual(stream.push("Summary: I **fixed** the `echo` bug"), []);
  assert.deepEqual(stream.push(" and the tests pass. Next"), ["I fixed the echo bug and the tests pass."]);
  assert.equal(stream.done, false);
  assert.equal(stream.spokenSentences, 1);
  assert.deepEqual(stream.push(" I will wire the panel. And then some more."), ["Next I will wire the panel."]);
  assert.equal(stream.done, true);
  assert.equal(stream.spokenSentences, 2);
  assert.deepEqual(stream.push(" Ignored."), []);
  // A cut digest flushes nothing: the half sentence it was stopped in stays unsaid.
  assert.deepEqual(stream.finish(), []);
});

test("a digest that ends mid-sentence is flushed; a code fence or a ramble ends it", () => {
  const short = new DigestStream();
  assert.deepEqual(short.push("Two files changed"), []);
  assert.deepEqual(short.finish(), ["Two files changed"]);
  assert.equal(short.spokenSentences, 1);
  // Decimal points are not sentence ends.
  const decimal = new DigestStream();
  assert.deepEqual(decimal.push("Rate is now 1.15 not 1.02. Done"), ["Rate is now 1.15 not 1.02."]);
  const fenced = new DigestStream();
  assert.deepEqual(fenced.push("I added the route. Here it is:\n```ts\nx\n```"), ["I added the route.", "Here it is:"]);
  assert.equal(fenced.done, true);
  const ramble = new DigestStream();
  assert.deepEqual(ramble.push(`${"word ".repeat(100)}end. More.`), []);
  assert.equal(ramble.done, true);
  assert.equal(ramble.spokenSentences, 0);
});

/* ── Addressing in an open hands-free session ─────────────────────────────── */

const openSession = {
  assistantAskedQuestion: false,
  msSinceAssistantTurn: 60_000,
  speakerMatch: null,
  hasProfile: false,
  requireWakeWord: false,
  requireSpeakerMatch: false,
  wakeWords: ["temy", "teminali"],
  windowFocused: true,
};

test("in an open session an ordinary sentence is for the assistant without a model call", () => {
  for (const line of ["what does this component do", "that table needs another column", "make the orb a bit smaller", "can we ship this today"]) {
    const { verdict, needsClassifier } = scoreAddressing(line, openSession);
    assert.equal(verdict.directed, true, line);
    assert.equal(needsClassifier, false, line);
  }
});

test("talking to someone else is still dropped in an open session", () => {
  const { verdict } = scoreAddressing("tell her I'll be there in ten minutes", openSession);
  assert.equal(verdict.directed, false);
});

test("a lone stray word in an open session is not a turn unless it answers a question", () => {
  assert.equal(scoreAddressing("okay", openSession).verdict.directed, false);
  assert.equal(
    scoreAddressing("okay", { ...openSession, assistantAskedQuestion: true, msSinceAssistantTurn: 800 }).verdict.directed,
    true,
  );
});

/* ── Host wiring ──────────────────────────────────────────────────────────── */

// `useVoice` rebuilds the engine's host by hand, one method at a time, so a
// method added to `VoiceHost` and passed by the chat can still never reach the
// engine. That is how "how's it going?" got its canned fallback in the
// 2026-09-05 live check: `progressSummary` was declared, implemented, passed —
// and not forwarded. Every member of the interface must be forwarded.
test("useVoice forwards every VoiceHost method to the engine", async () => {
  const { readFile } = await import("node:fs/promises");
  const contract = await readFile(new URL("../src/services/voice/conversation.ts", import.meta.url), "utf8");
  const hook = await readFile(new URL("../src/hooks/useVoice.ts", import.meta.url), "utf8");
  const block = contract.match(/export interface VoiceHost \{([\s\S]*?)\n\}/);
  assert.ok(block, "VoiceHost interface not found");
  const members = [...block[1].matchAll(/^  (\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(members.includes("progressSummary"), "expected progressSummary on VoiceHost");
  for (const name of members) {
    assert.match(hook, new RegExp(`hostRef\\.current\\.${name}\\b`), `useVoice does not forward VoiceHost.${name}`);
  }
});

/* ── Microphone lifecycle ─────────────────────────────────────────────────── */

// `awaitingFinal` is what stops `onClose` from reopening the microphone while a
// final transcript is still expected. Setting it without arming a way out is how
// the session went deaf on 2026-09-05 while the UI still showed voice mode live:
// the one-shot branch set the flag and relied entirely on a result that an empty
// transcription never delivered.
async function conversationSource() {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL("../src/services/voice/conversation.ts", import.meta.url), "utf8");
}

test("every path that waits for a final transcript arms a fallback", async () => {
  const lines = (await conversationSource()).split("\n");
  const setters = lines.flatMap((line, i) => (/this\.awaitingFinal = true;/.test(line) ? [i] : []));
  assert.ok(setters.length >= 2, `expected the streaming and one-shot waits, found ${setters.length}`);
  for (const index of setters) {
    assert.match(
      lines.slice(index, index + 6).join("\n"),
      /this\.armFinalFallback\(/,
      `awaitingFinal set at line ${index + 1} without arming a fallback`,
    );
  }
});

test("the fallback clears the latch whatever state it fires in", async () => {
  const body = (await conversationSource()).match(/private armFinalFallback\([\s\S]*?\n  \}/);
  assert.ok(body, "armFinalFallback not found");
  assert.doesNotMatch(
    body[0],
    /this\.state === "deciding"/,
    "the fallback must not depend on the state still being deciding",
  );
  assert.match(body[0], /this\.awaitingFinal = false;/);
  assert.match(body[0], /this\.reopenDeferred/, "the fallback must reopen a microphone onClose declined to reopen");
});

test("onClose records a deferred reopen instead of dropping it", async () => {
  const source = await conversationSource();
  const handlers = [...source.matchAll(/onClose: \(\) => \{([\s\S]*?)\n {10}\},/g)].map((m) => m[1]);
  assert.equal(handlers.length, 2, `expected both listen sites, found ${handlers.length}`);
  for (const handler of handlers) {
    assert.match(handler, /this\.reopenDeferred = true;/, "onClose drops the reopen when a final is outstanding");
  }
});
