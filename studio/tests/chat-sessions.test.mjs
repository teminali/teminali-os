import assert from "node:assert/strict";
import test from "node:test";
import { applySessionSwitch } from "../src/utils/chatSessions.ts";

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
