/**
 * Up-arrow prompt history.
 *
 * The composer is a textarea, so none of this can be checked by rendering it —
 * which is why the ring lives in `utils/promptHistory.ts` and this file is the
 * whole of its coverage. The cases below are the ones a history gets wrong:
 * eating the draft, storing the same prompt twice, and stealing Up from a
 * multi-line edit.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  atFirstLine,
  atLastLine,
  newer,
  older,
  remember,
  stopBrowsing,
} from "../src/utils/promptHistory.ts";

const fill = (...prompts) => prompts.reduce((history, prompt) => remember(history, prompt), EMPTY_HISTORY);

test("an empty history has nowhere to go", () => {
  assert.equal(older(EMPTY_HISTORY, "draft"), null);
  assert.equal(newer(EMPTY_HISTORY), null);
});

test("Up walks backwards from the newest prompt", () => {
  const history = fill("first", "second", "third");
  const one = older(history, "");
  assert.equal(one.value, "third");
  const two = older(one.history, "");
  assert.equal(two.value, "second");
  const three = older(two.history, "");
  assert.equal(three.value, "first");
  assert.equal(older(three.history, ""), null, "the oldest entry is the end of the walk");
});

test("the draft is put aside and handed back", () => {
  const history = fill("earlier");
  const up = older(history, "half-written");
  assert.equal(up.value, "earlier");
  const down = newer(up.history);
  assert.equal(down.value, "half-written");
  assert.equal(down.history.index, -1, "walking past the newest entry ends browsing");
  assert.equal(down.history.draft, "", "and lets the draft go");
});

test("only the first Up captures the draft", () => {
  const history = fill("a", "b");
  const one = older(history, "mine");
  const two = older(one.history, "b");
  assert.equal(two.history.draft, "mine", "the entry now in the box is not a draft");
  assert.equal(newer(newer(two.history).history).value, "mine");
});

test("Down does nothing while not browsing", () => {
  assert.equal(newer(fill("a")), null);
});

test("a blank prompt is not history", () => {
  assert.deepEqual(remember(EMPTY_HISTORY, "   ").entries, []);
});

test("the same prompt twice in a row is stored once", () => {
  const history = fill("build it", "build it");
  assert.deepEqual(history.entries, ["build it"]);
  // But not the same prompt with something in between — that is a real repeat.
  assert.deepEqual(fill("a", "b", "a").entries, ["a", "b", "a"]);
});

test("prompts are trimmed and sending ends browsing", () => {
  const browsing = older(fill("old"), "").history;
  const after = remember(browsing, "  new  ");
  assert.deepEqual(after.entries, ["old", "new"]);
  assert.equal(after.index, -1);
  assert.equal(after.draft, "");
});

test("the ring is capped and keeps the newest", () => {
  let history = EMPTY_HISTORY;
  for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) history = remember(history, `prompt ${index}`);
  assert.equal(history.entries.length, HISTORY_LIMIT);
  assert.equal(history.entries[history.entries.length - 1], `prompt ${HISTORY_LIMIT + 9}`);
  assert.equal(history.entries[0], "prompt 10");
});

test("typing leaves browsing without disturbing the entries", () => {
  const browsing = older(fill("a", "b"), "draft").history;
  const typed = stopBrowsing(browsing);
  assert.deepEqual(typed.entries, ["a", "b"]);
  assert.equal(typed.index, -1);
  assert.equal(stopBrowsing(EMPTY_HISTORY), EMPTY_HISTORY, "and allocates nothing when idle");
});

test("Up is history only on the first line, Down only on the last", () => {
  const value = "one\ntwo";
  assert.equal(atFirstLine(value, 1), true);
  assert.equal(atFirstLine(value, 5), false, "there is a line above to move to");
  assert.equal(atLastLine(value, 5), true);
  assert.equal(atLastLine(value, 1), false);
  assert.equal(atFirstLine("", 0), true);
  assert.equal(atLastLine("", 0), true);
});
