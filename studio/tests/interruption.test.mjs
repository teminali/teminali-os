import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runAgentTurn } from "../server/agent-cli.js";

test("Universal Interruption: aborting in-flight Claude Code turn terminates CLI process and keeps session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "teminali-interrupt-claude-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const mockBin = join(root, `mock-claude-${randomUUID()}.mjs`);
  writeFileSync(
    mockBin,
    `#!${process.execPath}\n` +
    `process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-123", model: "claude-sonnet-4-6" }) + "\\n");\n` +
    `process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Starting work..." } } }) + "\\n");\n` +
    `setTimeout(() => process.exit(0), 30000);\n`,
    { mode: 0o755 }
  );

  const controller = new AbortController();
  const events = [];
  let resolveSession;
  const sessionReady = new Promise((r) => { resolveSession = r; });

  const promise = runAgentTurn({
    engine: "claude",
    prompt: "Build an interruption module",
    root,
    bin: mockBin,
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "token") resolveSession();
    },
  });

  // Wait until session is established
  await sessionReady;

  // Operator interrupts with a new message!
  controller.abort();

  const outcome = await promise;
  assert.equal(outcome.reason, "AGENT_ABORTED", "Turn must be reported as aborted");
  assert.equal(outcome.sessionId, "claude-session-123", "Session ID must be preserved across interruption");
  assert.ok(events.some((e) => e.type === "session"), "Session event was received");
  assert.ok(events.some((e) => e.type === "token"), "First token was received before interruption");
});

test("Universal Interruption: aborting in-flight Codex turn terminates CLI process and keeps session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "teminali-interrupt-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const mockBin = join(root, `mock-codex-${randomUUID()}.mjs`);
  writeFileSync(
    mockBin,
    `#!${process.execPath}\n` +
    `process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-999" }) + "\\n");\n` +
    `process.stdout.write(JSON.stringify({ type: "item.started", item: { type: "agent_message" } }) + "\\n");\n` +
    `setTimeout(() => process.exit(0), 30000);\n`,
    { mode: 0o755 }
  );

  const controller = new AbortController();
  let resolveSession;
  const sessionReady = new Promise((r) => { resolveSession = r; });

  const promise = runAgentTurn({
    engine: "codex",
    prompt: "Optimize database indexes",
    root,
    bin: mockBin,
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "session") resolveSession();
    },
  });

  await sessionReady;

  // Interrupt!
  controller.abort();

  const outcome = await promise;
  assert.equal(outcome.reason, "AGENT_ABORTED");
  assert.equal(outcome.sessionId, "codex-thread-999", "Codex session/thread ID must be preserved");
});

test("Universal Interruption: turn sequencing prevents race conditions from stale aborted turns", () => {
  let activeTurnId = 0;
  const committedMessages = [];

  // Turn 1 starts
  activeTurnId += 1;
  const turn1Id = activeTurnId;

  // Turn 2 interrupts Turn 1
  activeTurnId += 1;
  const turn2Id = activeTurnId;

  // Turn 2 commits its token
  if (turn2Id === activeTurnId) {
    committedMessages.push({ turnId: turn2Id, text: "Turn 2 token" });
  }

  // Turn 1's late error/token arrives after abort
  if (turn1Id === activeTurnId) {
    committedMessages.push({ turnId: turn1Id, text: "Stale Turn 1 error" });
  }

  assert.equal(committedMessages.length, 1);
  assert.equal(committedMessages[0].turnId, 2);
  assert.equal(committedMessages[0].text, "Turn 2 token");
});

test("Universal Voice: filters out ambient sound captions like (keyboard clicking) and (upbeat music)", async () => {
  const { cleanTranscript, isNonSpeechOrBlank } = await import("../src/services/voice/transcriptRepair.ts");
  
  const ambientCaptions = [
    "(keyboard clicking)",
    "(upbeat music)",
    "[blank_audio]",
    "(gentle music)",
    "(typing sounds)",
    "[laughter]",
    "[silence]"
  ];

  for (const caption of ambientCaptions) {
    assert.equal(cleanTranscript(caption), "", `cleanTranscript should strip ${caption}`);
    assert.equal(isNonSpeechOrBlank(caption), true, `isNonSpeechOrBlank should be true for ${caption}`);
  }

  const validSentence = "Can you create a navbar component (keyboard clicking)";
  assert.equal(cleanTranscript(validSentence), "Can you create a navbar component");
  assert.equal(isNonSpeechOrBlank(validSentence), false);
});

test("Universal Voice: ignores coughs, keyboard typing, throat clearing, breathing and marks them as non-speech / noise", async () => {
  const { cleanTranscript, isNonSpeechOrBlank } = await import("../src/services/voice/transcriptRepair.ts");

  const nonSpeechSounds = [
    "(coughing)",
    "[cough]",
    "cough",
    "coughing",
    "coughs",
    "throat clearing",
    "throat clear",
    "keyboard clicking",
    "keyboard clicks",
    "keyboard typing",
    "typing sounds",
    "mouse clicks",
    "breathing",
    "heavy breathing",
    "sniffle",
  ];

  for (const sound of nonSpeechSounds) {
    assert.equal(isNonSpeechOrBlank(sound), true);
  }
});

test("Universal Voice: addressing gate rejects coughs, clicks, and unrelated ambient sounds", async () => {
  const { scoreAddressing } = await import("../src/services/voice/addressing.ts");

  const ambientSounds = [
    "coughing",
    "cough",
    "keyboard clicking",
    "throat clearing",
    "typing sounds",
    "mouse clicks",
  ];

  for (const sound of ambientSounds) {
    const scored = scoreAddressing(sound, {
      followUpWindow: false,
      requireWakeWord: false,
      wakeWords: ["temy"],
      speakerMatch: null,
      requireSpeakerMatch: false,
      hasProfile: false,
    });
    assert.equal(scored.verdict.directed, false);
  }
});

/* ── Stopping a turn ───────────────────────────────────────────────────────
   The report was "I cannot interrupt the chatbot on the go … it is either
   weak or just broken", and it was both. The stop button lived in
   `ThinkingIndicator`, which unmounts the moment a tool call or a token
   arrives — so it disappeared at exactly the point a run becomes worth
   stopping — and Escape was refused whenever a text field had focus, which is
   the composer, which is where focus is. What survives a stop is the subject
   of `src/services/interruption.ts`; these are its rules.
   ──────────────────────────────────────────────────────────────────────── */

const interruption = await import("../src/services/interruption.ts");
const { INTERRUPTED_NOTE, INTERRUPTED_TOOL_RESULT, interruptTurn, interruptsRun, keptPartialReply, settleRestoredTurns, settleRunningCalls } =
  interruption;

test("a stopped turn keeps what arrived and is marked as cut short", () => {
  const patch = interruptTurn({ role: "assistant", content: "The gateway binds to 4310 and" });

  assert.equal(patch.isStreaming, false);
  assert.equal(patch.cancelled, true, "the turn must be marked cancelled, not left looking complete");
  assert.equal(patch.content, "The gateway binds to 4310 and", "the partial reply is real work and is kept verbatim");
});

test("a stopped turn that produced nothing says so in its own words", () => {
  // An empty assistant message is what the *next* turn carries into the
  // model's history, so the note is content, not decoration.
  assert.equal(interruptTurn({ role: "assistant", content: "" }).content, INTERRUPTED_NOTE);
  assert.equal(interruptTurn({ role: "assistant", content: "   \n " }).content, INTERRUPTED_NOTE);
});

test("stopping settles every tool call that was still running", () => {
  const patch = interruptTurn({
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "a", name: "Read", arguments: {}, status: "completed", result: "ok" },
      { id: "b", name: "Bash", arguments: {}, status: "running" },
      { id: "c", name: "Grep", arguments: {}, status: "error", result: "no such file" },
    ],
  });

  // A spinner is read straight off `status`, so a call left running is a
  // spinner that turns forever under a turn that has finished.
  assert.deepEqual(
    patch.toolCalls.map((call) => call.status),
    ["completed", "error", "error"],
  );
  assert.equal(patch.toolCalls[1].result, INTERRUPTED_TOOL_RESULT);
  assert.equal(patch.toolCalls[0].result, "ok", "a settled call is not rewritten");
  assert.equal(patch.toolCalls[2].result, "no such file");
});

test("a turn with no tool calls does not get a toolCalls key", () => {
  // The store merges the patch by spread, so an explicit `undefined` would
  // erase a list rather than leave it alone.
  assert.equal("toolCalls" in interruptTurn({ role: "assistant", content: "hi" }), false);
  const untouched = [{ id: "a", name: "Read", arguments: {}, status: "completed" }];
  assert.equal(settleRunningCalls(untouched), untouched, "nothing running means the same array back");
});

test("stopping never rewrites the operator's own prompt", () => {
  // `updateLastMessageInEngine` writes to whatever sits last in the list, and
  // a stop landing a beat after a turn settled would otherwise edit the user.
  assert.deepEqual(interruptTurn({ role: "user", content: "run the tests" }), {});
  assert.deepEqual(interruptTurn({ role: "system", content: "context" }), {});
});

test("only a stopped turn with a partial answer earns the incomplete line", () => {
  assert.equal(keptPartialReply({ content: "half an answer", cancelled: true }), true);
  assert.equal(keptPartialReply({ content: INTERRUPTED_NOTE, cancelled: true }), false, "the note already says it");
  assert.equal(keptPartialReply({ content: "", cancelled: true }), false);
  assert.equal(keptPartialReply({ content: "a whole answer", cancelled: false }), false);
});

test("Escape stops the run from the composer, which is where focus actually is", () => {
  const composer = { key: "Escape", inTextField: true, inChat: true };
  assert.equal(interruptsRun(composer), true, "the composer is a textarea and it must not be exempt");

  const transcript = { key: "Escape", inTextField: false, inChat: true };
  assert.equal(interruptsRun(transcript), true);

  const nowhereInParticular = { key: "Escape", inTextField: false, inChat: false };
  assert.equal(interruptsRun(nowhereInParticular), true);
});

test("Escape belongs to a field that is not the chat", () => {
  // The terminal's command line, a search box, a settings input: Escape there
  // is that surface's key, not a chat interrupt.
  assert.equal(interruptsRun({ key: "Escape", inTextField: true, inChat: false }), false);
});

test("Escape already claimed by the composer's trigger menu does not also stop the run", () => {
  assert.equal(
    interruptsRun({ key: "Escape", defaultPrevented: true, inTextField: true, inChat: true }),
    false,
  );
});

test("Escape mid-composition belongs to the IME", () => {
  assert.equal(interruptsRun({ key: "Escape", isComposing: true, inTextField: true, inChat: true }), false);
});

test("no other key stops a run", () => {
  for (const key of ["Enter", "Esc", "escape", "Backspace", "k"]) {
    assert.equal(interruptsRun({ key, inTextField: false, inChat: true }), false, `${key} must not stop a run`);
  }
});

/* ── The controls, as rendered ─────────────────────────────────────────────
   The components are .tsx and the node runner cannot import JSX, so these
   read the source. Weaker than mounting them, and chosen over no check at
   all: each assertion is the exact shape of a defect that shipped. Same
   idiom as tests/composer-input.test.mjs.
   ──────────────────────────────────────────────────────────────────────── */

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the stop control is on screen for the whole turn, including a tool call", async () => {
  const watcher = await readSource("../src/components/chat/ProcessWatcher.tsx");
  assert.match(watcher, /onStop\?:\s*\(\)\s*=>\s*void/, "the process strip must accept a stop");
  assert.match(watcher, /\{isStreaming && onStop && \(/, "and draw it for as long as the turn is live");

  const block = await readSource("../src/components/chat/MessageBlock.tsx");
  assert.match(block, /<ProcessWatcher[\s\S]*?onStop=\{onStop\}[\s\S]*?\/>/, "and the turn must hand it down");

  // The waiting line unmounts as soon as a tool call or a token exists, so it
  // is not allowed to be the only place a stop lives.
  const thinking = await readSource("../src/components/chat/ThinkingIndicator.tsx");
  assert.doesNotMatch(thinking, /onStop/, "the waiting line no longer owns the stop");
});

test("typing a follow-up never takes the composer's stop button away", async () => {
  const composer = await readSource("../src/components/chat/Composer.tsx");
  assert.doesNotMatch(
    composer,
    /\{streaming \? \(\s*\n\s*value\.trim\(\) \?/,
    "the streaming branch must not choose between stop and send",
  );
  assert.match(composer, /onClick=\{onStop\}/, "the stop is unconditional while streaming");
});

test("the Escape handler no longer exempts text fields, and stop cancels the approval gate", async () => {
  const chat = await readSource("../src/components/chat/StudioChat.tsx");
  assert.doesNotMatch(
    chat,
    /typing = target && \/\^\(INPUT\|TEXTAREA\)/,
    "the rule that swallowed Escape in the composer is gone",
  );
  // A command waiting on a decision is part of the run: left pending it is a
  // dialog nobody can answer and an agent loop nobody can finish.
  assert.match(chat, /const stop = useCallback\(\(\) => \{[\s\S]*?cancelApproval\(\);/);
  assert.match(chat, /const stop = useCallback\(\(\) => \{[\s\S]*?abortRef\.current\?\.abort\(\);/);
});

test("Escape is wired once, by a hook every chat surface uses", async () => {
  const hook = await readSource("../src/hooks/useInterruptKey.ts");
  assert.match(hook, /interruptsRun\(stroke\)/, "the rule stays in services/interruption.ts");
  assert.match(hook, /window\.addEventListener\("keydown"/);
  assert.match(hook, /if \(!active\) return;/, "an idle surface must not swallow Escape from a live one");

  // Three surfaces, one listener implementation. Written out by hand they
  // drifted until Escape worked in none of them.
  //
  // The main chat's surface is the voice stage, not `StudioChat`: the hook was
  // armed there on `isStreaming`, which is that component's own chat lane and
  // which nothing on the stage sets — so Escape was dead on the one screen the
  // operator types into. `TemiVoiceStage` arms it on `isTaskRunning` and calls
  // `StudioChat`'s `stop` through `onStop`. See §6.43.
  for (const path of [
    "../src/components/voice/TemiVoiceStage.tsx",
    "../src/components/workspace/panels/AgentPane.tsx",
    "../src/components/workspace/panels/SideChatPane.tsx",
  ]) {
    const source = await readSource(path);
    assert.match(source, /useInterruptKey\(/, `${path} calls the shared hook`);
    assert.doesNotMatch(source, /addEventListener\("keydown", onKey\)/, `${path} has no copy of its own`);
  }

  // And exactly one owner per surface. Two listeners do not add up to a better
  // stop: whichever fires first calls `preventDefault`, and `interruptsRun`
  // then refuses the second, so registration order would decide how much of
  // the run actually stopped.
  const chat = await readSource("../src/components/chat/StudioChat.tsx");
  assert.doesNotMatch(chat, /^\s*useInterruptKey\(/m, "the column does not arm a second listener over the stage");
  assert.match(chat, /onStop=\{stop\}/, "and hands the stage its stop instead");
});

test("the stage stops the delegated run, the voice and the parent's lane", async () => {
  const stage = await readSource("../src/components/voice/TemiVoiceStage.tsx");
  // Stopping used to be two clicks deep in the activity dialog and reachable
  // by no key at all. One function is behind the button and the key, and it
  // stops all three things a run is made of on this surface.
  assert.match(stage, /const handleStopRun = useCallback\(\(\) => \{[\s\S]*?stopTTSPlayback\(\);/);
  assert.match(stage, /const handleStopRun = useCallback\(\(\) => \{[\s\S]*?TeminaliAgentBridge\.stopCurrentTask\(\);/);
  assert.match(stage, /const handleStopRun = useCallback\(\(\) => \{[\s\S]*?onStop\?\.\(\);/);
  assert.match(stage, /useInterruptKey\(isRunning, stageRef, handleStopRun\)/);
  assert.match(stage, /onStop=\{handleStopRun\}/, "and the composer's button is the same function");

  // A stop appears in the composer while a turn is in flight — beside send,
  // not instead of it, because a follow-up queues rather than killing the run.
  const composer = await readSource("../src/components/voice/TemiComposer.tsx");
  assert.match(composer, /\{isRunning && onStop && \([\s\S]*?aria-label="Stop"/);
  assert.doesNotMatch(
    composer,
    /onClick=\{onStop\}[\s\S]{0,240}?disabled=/,
    "stopping must not depend on the draft",
  );
  assert.match(composer, /aria-label="Stop"[\s\S]*?aria-label="Send"/, "both are drawn, in that order");
});

test("an agent tab and a side chat settle a stopped turn like the main chat", async () => {
  for (const path of [
    "../src/components/workspace/panels/AgentPane.tsx",
    "../src/components/workspace/panels/SideChatPane.tsx",
  ]) {
    const source = await readSource(path);
    // `isStreaming: false` alone left every running tool call spinning under a
    // finished turn, and the partial reply unmarked.
    assert.match(source, /const stop = \(\) => \{[\s\S]*?patchLast\(interruptTurn\);/, `${path} settles the turn`);
    assert.doesNotMatch(source, /const stop = \(\) => \{[\s\S]*?patchLast\(\{ isStreaming: false \}\)/, path);
    assert.match(source, /const stop = \(\) => \{[\s\S]*?abortRef\.current = null;/, `${path} releases the controller`);
  }
});

/* ── A restart is an interruption ─────────────────────────────────────────── */

/**
 * `isStreaming` is persisted with the message, so a turn in flight when the app
 * quit comes back marked live — a spinner saying "Working", a clock frozen at
 * the second the process died, and a stop button pointing at a run nobody
 * holds. The operator reads that as the agent being stuck. It is not: the app
 * was closed underneath it.
 */
test("a turn still marked live after a restart is recorded as stopped", () => {
  const restored = settleRestoredTurns([
    { id: "1", role: "user", content: "hello", isStreaming: false },
    { id: "2", role: "assistant", content: "The gateway binds to", isStreaming: true },
  ]);
  assert.equal(restored[1].isStreaming, false);
  assert.equal(restored[1].cancelled, true);
  // What arrived is kept: it is real work the operator asked for.
  assert.equal(restored[1].content, "The gateway binds to");
  assert.equal(keptPartialReply(restored[1]), true);
  // And the operator's own prompt is untouched.
  assert.deepEqual(restored[0], { id: "1", role: "user", content: "hello", isStreaming: false });
});

test("a turn that produced nothing says so rather than showing an empty reply", () => {
  const restored = settleRestoredTurns([{ id: "1", role: "assistant", content: "", isStreaming: true }]);
  assert.equal(restored[0].content, INTERRUPTED_NOTE);
  // The note is the whole content, so there is no second line repeating it.
  assert.equal(keptPartialReply(restored[0]), false);
});

test("a transcript with nothing live is returned untouched", () => {
  const messages = [{ id: "1", role: "assistant", content: "done", isStreaming: false }];
  // The same array, not a copy: this runs on every rehydrate.
  assert.equal(settleRestoredTurns(messages), messages);
  assert.equal(settleRestoredTurns(undefined), undefined);
  assert.deepEqual(settleRestoredTurns([]), []);
});

test("a tool call that was still running when the app died is settled too", () => {
  const restored = settleRestoredTurns([
    {
      id: "1",
      role: "assistant",
      content: "",
      isStreaming: true,
      toolCalls: [{ id: "t1", name: "read", status: "running" }],
    },
  ]);
  assert.notEqual(restored[0].toolCalls[0].status, "running");
});
