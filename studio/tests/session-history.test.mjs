import assert from "node:assert/strict";
import test from "node:test";

/**
 * The title bar's back/forward arrows.
 *
 * The store is a zustand hook and cannot be imported outside React, so the
 * navigation logic is exercised here against the same reducer shape the store
 * implements. What is being pinned is the browser-history contract — the part
 * that is easy to get subtly wrong and impossible to notice until you are lost.
 */

const LIMIT = 50;

/** `bootedInto` mirrors the store, which starts on a session nobody navigated to. */
function createNav(bootedInto = null) {
  let state = { activeSessionId: bootedInto, sessionHistory: [], sessionHistoryIndex: -1 };

  return {
    get: () => ({ ...state }),
    visit(id) {
      if (state.activeSessionId === id) return;
      const seeded =
        state.sessionHistory.length === 0 && state.activeSessionId
          ? [state.activeSessionId]
          : state.sessionHistory;
      const truncated = seeded.slice(
        0,
        state.sessionHistory.length === 0 ? seeded.length : state.sessionHistoryIndex + 1,
      );
      const history = [...truncated, id].slice(-LIMIT);
      state = { activeSessionId: id, sessionHistory: history, sessionHistoryIndex: history.length - 1 };
    },
    back() {
      const target = state.sessionHistoryIndex - 1;
      const id = state.sessionHistory[target];
      if (target < 0 || !id) return;
      state = { ...state, activeSessionId: id, sessionHistoryIndex: target };
    },
    forward() {
      const target = state.sessionHistoryIndex + 1;
      const id = state.sessionHistory[target];
      if (!id) return;
      state = { ...state, activeSessionId: id, sessionHistoryIndex: target };
    },
  };
}

test("back and forward walk the visit stack", () => {
  const nav = createNav();
  nav.visit("a");
  nav.visit("b");
  nav.visit("c");

  nav.back();
  assert.equal(nav.get().activeSessionId, "b");
  nav.back();
  assert.equal(nav.get().activeSessionId, "a");
  nav.forward();
  assert.equal(nav.get().activeSessionId, "b");
});

test("visiting after going back discards the forward path", () => {
  // The rule that makes this history rather than a carousel: once you branch,
  // the chats you had gone forward to are no longer ahead of you.
  const nav = createNav();
  nav.visit("a");
  nav.visit("b");
  nav.visit("c");
  nav.back(); // at b
  nav.visit("d");

  assert.deepEqual(nav.get().sessionHistory, ["a", "b", "d"]);
  assert.equal(nav.get().sessionHistoryIndex, 2);
  nav.forward();
  assert.equal(nav.get().activeSessionId, "d", "there is nothing ahead of d");
});

test("reopening the current chat is not a navigation", () => {
  // Otherwise the stack fills with duplicates and back appears to do nothing.
  const nav = createNav();
  nav.visit("a");
  nav.visit("a");
  nav.visit("a");
  assert.deepEqual(nav.get().sessionHistory, ["a"]);
});

test("the arrows do nothing at the ends rather than wrapping", () => {
  const nav = createNav();
  nav.visit("a");

  nav.back();
  assert.equal(nav.get().activeSessionId, "a");
  assert.equal(nav.get().sessionHistoryIndex, 0);

  nav.forward();
  assert.equal(nav.get().activeSessionId, "a");
});

test("going back and forward returns you exactly where you were", () => {
  const nav = createNav();
  for (const id of ["a", "b", "c", "d"]) nav.visit(id);
  const before = nav.get();
  nav.back();
  nav.back();
  nav.forward();
  nav.forward();
  assert.deepEqual(nav.get(), before);
});

test("the stack is bounded and keeps the recent past", () => {
  const nav = createNav();
  for (let i = 0; i < LIMIT + 20; i += 1) nav.visit(`s${i}`);
  const { sessionHistory, sessionHistoryIndex } = nav.get();
  assert.equal(sessionHistory.length, LIMIT);
  assert.equal(sessionHistory.at(-1), `s${LIMIT + 19}`);
  assert.equal(sessionHistoryIndex, LIMIT - 1, "the index must stay inside the trimmed stack");
});

test("enabled-state matches what the arrows can actually do", () => {
  const canBack = (s) => s.sessionHistoryIndex > 0;
  const canForward = (s) => s.sessionHistoryIndex >= 0 && s.sessionHistoryIndex < s.sessionHistory.length - 1;

  const nav = createNav();
  assert.equal(canBack(nav.get()), false, "nothing visited yet");
  assert.equal(canForward(nav.get()), false);

  nav.visit("a");
  assert.equal(canBack(nav.get()), false, "one entry is not somewhere to go back from");

  nav.visit("b");
  assert.equal(canBack(nav.get()), true);
  assert.equal(canForward(nav.get()), false);

  nav.back();
  assert.equal(canForward(nav.get()), true);
});

test("the chat the app booted into is reachable with Back", () => {
  // The store boots with an activeSessionId nobody navigated to. Without
  // seeding it, the first switch builds a one-entry stack and Back stays
  // disabled — which is exactly what the running app did.
  const nav = createNav("booted-chat");
  nav.visit("second");

  assert.deepEqual(nav.get().sessionHistory, ["booted-chat", "second"]);
  assert.equal(nav.get().sessionHistoryIndex, 1, "Back must be available after one switch");

  nav.back();
  assert.equal(nav.get().activeSessionId, "booted-chat");
});

test("seeding happens once, not on every later switch", () => {
  const nav = createNav("booted-chat");
  nav.visit("b");
  nav.visit("c");
  assert.deepEqual(nav.get().sessionHistory, ["booted-chat", "b", "c"]);
});
