import assert from "node:assert/strict";
import test from "node:test";
import { dialogueFromMessages, messagesFromDialogue, GREETING_ID } from "../src/utils/sessionDialogue.ts";

/**
 * The sequel to `chat-sessions.test.mjs`.
 *
 * That round fixed the store: `applySessionSwitch` saves the outgoing
 * transcript and loads the incoming one, and its tests prove it. The screen was
 * never wired to it — the voice stage kept the conversation in a `useState` of
 * its own — so clicking a chat still did nothing visible, for exactly the same
 * reason and with exactly the same symptom. These tests cover the mapping that
 * closes that gap.
 */

const greeting = [{ id: GREETING_ID, role: "assistant", content: "I'm right here with you." }];

test("an empty chat draws the greeting rather than an empty transcript", () => {
  // The landing hero is what "you have not started this chat" looks like, and
  // it is gated on the greeting being the only turn.
  assert.deepEqual(dialogueFromMessages([], greeting), greeting);
});

test("a chat with messages draws them, not the greeting", () => {
  const turns = dialogueFromMessages(
    [
      { id: "m1", role: "user", content: "what broke?", timestamp: "10:00" },
      { id: "m2", role: "assistant", content: "the sidebar", timestamp: "10:00" },
    ],
    greeting,
  );
  assert.deepEqual(turns.map((turn) => turn.content), ["what broke?", "the sidebar"]);
});

test("system messages are not drawn", () => {
  // The transcript has two columns and a system note belongs to neither.
  const turns = dialogueFromMessages(
    [{ id: "s1", role: "system", content: "run cancelled", timestamp: "10:00" }],
    greeting,
  );
  assert.deepEqual(turns, greeting, "nothing drawable is the same as nothing said");
});

test("the greeting is never stored", () => {
  /* If it were, a chat you had only looked at would hold one real message,
     stop counting as empty, and never show the landing screen again. */
  assert.deepEqual(messagesFromDialogue(greeting, []), []);
});

test("a turn still being spoken is not stored", () => {
  const stored = messagesFromDialogue(
    [{ id: "live-user", role: "user", content: "wait, I mean—", pending: true }],
    [],
  );
  assert.deepEqual(stored, [], "a half-spoken sentence is live state, not history");
});

test("round-tripping keeps per-turn telemetry the transcript never sees", () => {
  /* The stage knows who spoke and what they said. It does not know what the
     turn cost, and must not be able to erase it by re-rendering. */
  const previous = [
    { id: "m1", role: "user", content: "what broke?", timestamp: "10:00" },
    { id: "m2", role: "assistant", content: "the sidebar", timestamp: "10:01", costUsd: 0.42, tokensCount: 1200 },
  ];
  const stored = messagesFromDialogue(dialogueFromMessages(previous, greeting), previous);
  assert.deepEqual(stored, previous);
  assert.equal(stored[1].costUsd, 0.42);
  assert.equal(stored[1].tokensCount, 1200);
});

test("an edited turn keeps its telemetry and takes the new text", () => {
  const previous = [{ id: "m1", role: "assistant", content: "the sidebar", timestamp: "10:01", costUsd: 0.42 }];
  const stored = messagesFromDialogue([{ id: "m1", role: "assistant", content: "the voice stage" }], previous);
  assert.equal(stored[0].content, "the voice stage");
  assert.equal(stored[0].costUsd, 0.42);
});

test("a new turn is stored with a timestamp", () => {
  const stored = messagesFromDialogue([{ id: "asst-1", role: "assistant", content: "fixed" }], []);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].content, "fixed");
  assert.ok(stored[0].timestamp, "a stored message carries when it was said");
});

test("appending to a drawn greeting does not smuggle the greeting into storage", () => {
  /* The exact shape of every call site in the stage: `prev => [...prev, turn]`
     where `prev` is whatever was drawn — which, in a fresh chat, is the
     greeting. */
  const drawn = dialogueFromMessages([], greeting);
  const appended = [...drawn, { id: "u1", role: "user", content: "hello" }];
  const stored = messagesFromDialogue(appended, []);
  assert.deepEqual(stored.map((message) => message.content), ["hello"]);
});
