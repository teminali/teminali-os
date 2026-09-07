import assert from "node:assert/strict";
import test from "node:test";
import { applySessionSwitch, rememberAgentSession, resumableAgentSession } from "../src/utils/chatSessions.ts";

/**
 * The operator, on the sidebar: "I do not know if these are chats or what, but
 * all I know when I click on them nothing happens." Clicking one moved the
 * highlight and left the transcript alone, which is indistinguishable from a
 * dead row.
 */

test("switching to an empty chat empties the transcript", () => {
  const sessions = [
    { id: "a", messages: [{ text: "hello" }] },
    { id: "b", messages: [] },
  ];
  const { messages } = applySessionSwitch(sessions, "a", "b", [{ text: "hello" }]);
  // The old rule kept the previous conversation on screen here, and that is
  // the whole of what "nothing happens" looked like.
  assert.deepEqual(messages, []);
});

test("the conversation being left is kept, not discarded", () => {
  const sessions = [
    { id: "a", messages: [] },
    { id: "b", messages: [{ text: "earlier" }] },
  ];
  const live = [{ text: "one" }, { text: "two" }];
  const first = applySessionSwitch(sessions, "a", "b", live);
  assert.deepEqual(first.messages, [{ text: "earlier" }]);
  assert.deepEqual(first.sessions.find((s) => s.id === "a").messages, live);

  // And going back finds it again.
  const back = applySessionSwitch(first.sessions, "b", "a", first.messages);
  assert.deepEqual(back.messages, live);
});

test("a chat that no longer exists opens empty rather than showing someone else's", () => {
  const sessions = [{ id: "a", messages: [{ text: "mine" }] }];
  const { messages } = applySessionSwitch(sessions, "a", "gone", [{ text: "mine" }]);
  assert.deepEqual(messages, []);
});

test("an agent thread is offered back to the same agent in the same chat", () => {
  const sessions = rememberAgentSession([{ id: "a", messages: [] }], "a", "run-1", "claude:sonnet");
  assert.equal(resumableAgentSession(sessions, "a", "claude:sonnet"), "run-1");
});

test("a thread belonging to another agent is not resumed", () => {
  const sessions = rememberAgentSession([{ id: "a", messages: [] }], "a", "run-1", "claude:sonnet");
  assert.equal(resumableAgentSession(sessions, "a", "codex:gpt"), null);
});

test("a thread belongs to its own chat, not to whichever chat is open", () => {
  const sessions = rememberAgentSession(
    [{ id: "a", messages: [] }, { id: "b", messages: [] }],
    "a",
    "run-1",
    "claude:sonnet",
  );
  assert.equal(resumableAgentSession(sessions, "b", "claude:sonnet"), null);
  assert.equal(resumableAgentSession(sessions, "a", "claude:sonnet"), "run-1");
});

test("with no agent selected there is nothing to resume", () => {
  const sessions = rememberAgentSession([{ id: "a", messages: [] }], "a", "run-1", "claude:sonnet");
  assert.equal(resumableAgentSession(sessions, "a", null), null);
});

test("forgetting a thread drops the key with it, so no stale key can match", () => {
  const started = rememberAgentSession([{ id: "a", messages: [] }], "a", "run-1", "claude:sonnet");
  const forgotten = rememberAgentSession(started, "a", null, "claude:sonnet");
  assert.equal(forgotten[0].agentSessionKey, null);
  assert.equal(resumableAgentSession(forgotten, "a", "claude:sonnet"), null);
});
