import assert from "node:assert/strict";
import test from "node:test";
import {
  agentSessionKeyFor,
  applySessionSwitch,
  forkSession,
  rememberAgentSession,
  restampWorkspace,
  resumableAgentSession,
  workspaceLabel,
} from "../src/utils/chatSessions.ts";

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

/* ── The thread the next turn will be on ───────────────────────────────────
   The operator asked for two things the interface could not do: keep the
   conversation when they change model inside one CLI, and branch it on purpose.
   Both are decided by these functions, and neither is visible in the suite
   otherwise — the studio tests have no DOM, so the menu that shows this cannot
   be rendered here. */

test("the key is the engine, so moving between models of one CLI keeps the thread", () => {
  // The old key was `engine:model`, and every model switch mid-task therefore
  // threw the conversation away without ever saying so.
  const started = rememberAgentSession(
    [{ id: "a", messages: [] }],
    "a",
    "run-1",
    agentSessionKeyFor({ engine: "claude", model: "sonnet" }),
  );
  assert.equal(resumableAgentSession(started, "a", agentSessionKeyFor({ engine: "claude", model: "opus" })), "run-1");
});

test("a thread stored under the old engine:model key still names its engine", () => {
  // Written by a build that keyed on the model. Read by one that does not: the
  // upgrade must keep the conversation, not silently drop it on the next turn.
  const legacy = [{ id: "a", messages: [], agentSessionId: "run-1", agentSessionKey: "claude:sonnet" }];
  assert.equal(resumableAgentSession(legacy, "a", "claude"), "run-1");
  assert.equal(resumableAgentSession(legacy, "a", "codex"), null);
});

test("switching engine still starts fresh, because the other CLI cannot read the thread", () => {
  const started = rememberAgentSession([{ id: "a", messages: [] }], "a", "run-1", "claude");
  assert.equal(resumableAgentSession(started, "a", "codex"), null);
});

test("the local lane has no thread of its own to resume", () => {
  // Not a CLI, so there is no session id anywhere to offer back. Null is the
  // honest answer and it is what stops a Frontier turn resuming a Codex one.
  assert.equal(agentSessionKeyFor(null), null);
  assert.equal(agentSessionKeyFor(undefined), null);
});

test("a fork carries the transcript and the thread, and is armed to branch", () => {
  const source = { id: "a", title: "Alpha", messages: [{ text: "one" }], agentSessionId: "run-1", agentSessionKey: "claude" };
  const fork = forkSession(source, "b", [{ text: "one" }, { text: "two" }]);
  assert.equal(fork.id, "b");
  // The live transcript, not the stored one: the store passes what is on
  // screen, which is everything said since this chat was last left.
  assert.deepEqual(fork.messages, [{ text: "one" }, { text: "two" }]);
  // Both chats hold the same id. They are one thread until the copy takes a
  // turn, and that turn is the one that branches.
  assert.equal(fork.agentSessionId, "run-1");
  assert.equal(fork.agentForkPending, true);
});

test("forking a chat that never started a thread arms nothing", () => {
  const fork = forkSession({ id: "a", title: "Alpha", messages: [] }, "b", []);
  assert.equal(fork.agentForkPending, false);
  // Branching nothing is just a fresh thread, which is what its first turn
  // already opens — sending `--fork-session` with no id would fail the turn.
  assert.equal(fork.agentSessionId, undefined);
});

test("the turn that reports the forked id disarms the fork", () => {
  const fork = forkSession({ id: "a", messages: [], agentSessionId: "run-1", agentSessionKey: "claude" }, "b", []);
  const settled = rememberAgentSession([fork], "b", "run-2", "claude");
  // Staying armed would branch the branch on the next turn, and every turn
  // after it, so a conversation could never be continued again.
  assert.equal(settled[0].agentForkPending, false);
  assert.equal(resumableAgentSession(settled, "b", "claude"), "run-2");
});

test("starting fresh forgets the thread and disarms the fork with it", () => {
  const fork = forkSession({ id: "a", messages: [], agentSessionId: "run-1", agentSessionKey: "claude" }, "b", []);
  const fresh = rememberAgentSession([fork], "b", null, "claude");
  assert.equal(fresh[0].agentSessionId, null);
  assert.equal(fresh[0].agentForkPending, false);
  assert.equal(resumableAgentSession(fresh, "b", "claude"), null);
});

test("a fork leaves the chat it came from exactly as it was", () => {
  const source = { id: "a", messages: [{ text: "one" }], agentSessionId: "run-1", agentSessionKey: "claude" };
  const before = JSON.stringify(source);
  forkSession(source, "b", [{ text: "one" }]);
  // The whole point of branching rather than continuing: the parent keeps its
  // thread, so its own next turn still extends the conversation it is showing.
  assert.equal(JSON.stringify(source), before);
});

/* ── Where the chat says it is, and where the turn actually runs ───────────
   Reported as a mismatch: the composer chip read "4K Video Downloader+" while
   the sidebar filed that same chat under "teminaliCode". The chip was right.
   The chat lane sends no cwd, so the gateway resolves the turn against its own
   workspace root — the value the chip renders. The stale half was the chat's
   stamp, written once at creation and never again. */

test("opening another repository moves the chat that is open with it", () => {
  const sessions = [{ id: "a", workspace: "teminaliCode" }, { id: "b", workspace: "teminaliCode" }];
  const moved = restampWorkspace(sessions, "a", "/Users/x/projects/4K Video Downloader+");
  assert.equal(moved[0].workspace, "4K Video Downloader+");
  // Only the chat you are in. The others were not moved and did not run there.
  assert.equal(moved[1].workspace, "teminaliCode");
});

test("a root with nothing in it files the chat under the group for chats whose repo is gone", () => {
  assert.equal(workspaceLabel(""), "No Repo");
  assert.equal(workspaceLabel("/"), "No Repo");
  // A trailing slash names the same folder, and must not become a group of its own.
  assert.equal(workspaceLabel("/Users/x/teminaliCode/"), "teminaliCode");
});
