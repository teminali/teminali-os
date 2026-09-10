/**
 * The one line that stands in for the whole Teminali OS assistant.
 *
 * The assistant has no chat surface: it reads, edits and runs behind the
 * scenes, and a single strip under Temi's orb is the only place a person sees
 * it happen. That makes the phrasing load-bearing rather than cosmetic — if the
 * line is wrong, or truncates the half that identifies the file, the operator
 * has no other way to find out what is going on.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  describeActivity,
  currentActivityPhrase,
  shortenTarget,
  summariseCommand,
  speakActivityPhrase,
  MAX_TARGET,
} from "../src/services/voice/activityPhrase.ts";

test("an item with no status is something that just started, not something finished", () => {
  const phrase = describeActivity({ id: "1", type: "read", timestamp: 0, file: "server.py" });
  assert.equal(phrase.verb, "Reading");
  assert.equal(phrase.state, "running");
});

test("a finished action is said in the past tense", () => {
  const phrase = describeActivity({ id: "1", type: "edit", timestamp: 0, file: "config.js", status: "success" });
  assert.equal(phrase.verb, "Wrote");
  assert.equal(phrase.state, "done");
});

test("create and delete outrank the item type, which reports both as edits", () => {
  const created = describeActivity({ id: "1", type: "edit", timestamp: 0, file: "a.ts", badge: "create" });
  assert.equal(created.verb, "Creating");
  const deleted = describeActivity({ id: "2", type: "edit", timestamp: 0, file: "a.ts", badge: "delete", status: "success" });
  assert.equal(deleted.verb, "Deleted");
});

test("truncation keeps the end of a path, which is the part that identifies it", () => {
  const long = "studio/src/services/voice/realtimeVoiceStatus.ts";
  const short = shortenTarget(long);
  assert.ok(short.length <= MAX_TARGET + 2, short);
  assert.ok(short.endsWith("realtimeVoiceStatus.ts"), short);
  // Two files in different deep trees must not render identically.
  assert.notEqual(shortenTarget("a/very/deep/tree/alpha.ts"), shortenTarget("a/very/deep/tree/beta.ts"));
});

test("a short path is left exactly as it is", () => {
  assert.equal(shortenTarget("server.py"), "server.py");
});

test("a command shows what was run, not its flags", () => {
  assert.equal(summariseCommand("npm run studio:test --silent --reporter=dot"), "npm run studio:test");
  assert.equal(summariseCommand(""), "a command");
});

test("nothing is shown when nothing is running", () => {
  const items = [{ id: "1", type: "read", timestamp: 1, file: "a.ts", status: "success" }];
  assert.equal(currentActivityPhrase(items, false), null);
});

test("the newest unfinished action wins, not the newest action", () => {
  const items = [
    { id: "1", type: "read", timestamp: 1, file: "old.ts", status: "running" },
    { id: "2", type: "edit", timestamp: 2, file: "done.ts", status: "success" },
  ];
  const phrase = currentActivityPhrase(items, true);
  assert.equal(phrase.target, "old.ts");
  assert.equal(phrase.verb, "Reading");
});

test("a run with nothing logged yet says so rather than showing an empty strip", () => {
  const phrase = currentActivityPhrase([], true);
  assert.equal(phrase.verb, "Thinking");
  assert.equal(phrase.icon, "think");
});

test("progress text is used when there are no activity items to draw on", () => {
  const phrase = currentActivityPhrase([], true, "resolving the dependency graph");
  assert.equal(phrase.verb, "Working");
  assert.match(phrase.target, /dependency/);
});

test("a failure is carried through so the strip can show it", () => {
  const phrase = describeActivity({ id: "1", type: "cmd", timestamp: 0, cmd: "npm test", status: "failed" });
  assert.equal(phrase.state, "failed");
});

test("the spoken form is the same sentence the eye is reading", () => {
  const phrase = describeActivity({ id: "1", type: "read", timestamp: 0, file: "server.py" });
  assert.equal(speakActivityPhrase(phrase), "Reading server.py.");
  assert.equal(speakActivityPhrase(null), "Nothing is running right now.");
});
