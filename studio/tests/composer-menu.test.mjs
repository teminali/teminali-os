import assert from "node:assert/strict";
import test from "node:test";

import { readTrigger, scoreMatch } from "../src/utils/composerTrigger.ts";

/**
 * The composer's placeholder advertises "/ for skills, @ for context". These
 * pin the two rules that decide whether that feels like an editor or like a
 * menu that keeps interrupting you.
 */

test("a trigger opens at the start of a token", () => {
  assert.deepEqual(readTrigger("/", 1), { kind: "skill", at: 0, query: "" });
  assert.deepEqual(readTrigger("@", 1), { kind: "file", at: 0, query: "" });
  assert.deepEqual(readTrigger("look at @App", 12), { kind: "file", at: 8, query: "App" });
});

test("punctuation inside a word is not a trigger", () => {
  // The single most annoying failure mode: a menu popping open every time you
  // type a path or an email address.
  assert.equal(readTrigger("src/App.tsx", 11), null);
  assert.equal(readTrigger("user@host.com", 13), null);
  assert.equal(readTrigger("a/b", 3), null);
});

test("a space closes the trigger", () => {
  assert.equal(readTrigger("@App and then", 13), null);
  assert.equal(readTrigger("/skill ", 7), null);
});

test("a newline closes the trigger", () => {
  assert.equal(readTrigger("@App\nnext line", 14), null);
});

test("the trigger tracks the caret, not the end of the text", () => {
  // Typing in the middle of an existing prompt must open the menu for the
  // token under the caret, not for something later in the string.
  const value = "@Rea and @Other";
  assert.deepEqual(readTrigger(value, 4), { kind: "file", at: 0, query: "Rea" });
});

test("deleting back past the trigger character closes the menu", () => {
  assert.deepEqual(readTrigger("@a", 2), { kind: "file", at: 0, query: "a" });
  assert.deepEqual(readTrigger("@", 1), { kind: "file", at: 0, query: "" });
  assert.equal(readTrigger("", 0), null);
});

test("matching is a subsequence, the way a file picker behaves", () => {
  assert.ok(scoreMatch("src/App.tsx", "sAT") !== null, "sAT should find src/App.tsx");
  assert.ok(scoreMatch("src/App.tsx", "app") !== null);
  assert.equal(scoreMatch("src/App.tsx", "zzz"), null);
  assert.equal(scoreMatch("anything", ""), 0, "an empty query matches everything equally");
});

test("the obvious answer ranks first", () => {
  const query = "app";
  const exact = scoreMatch("App.tsx", query);
  const buried = scoreMatch("src/components/wrapper/unrelated-appendix.ts", query);
  assert.ok(exact !== null && buried !== null);
  assert.ok(exact > buried, "a start-of-segment match beats one buried mid-word");
});

test("consecutive characters score above scattered ones", () => {
  const together = scoreMatch("readme.md", "read");
  const scattered = scoreMatch("r-e-a-d-me.md", "read");
  assert.ok(together !== null && scattered !== null);
  assert.ok(together > scattered);
});
