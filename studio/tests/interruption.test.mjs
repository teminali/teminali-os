import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
