import assert from "node:assert/strict";
import test from "node:test";
import { changeTotals, countChangedLines, recordChange, splitPath } from "../src/services/changeSet.ts";
import { classifyCall, groupActivity, pathOf } from "../src/services/activityGroups.ts";

const call = (name, args = {}, status = "completed") => ({ id: `${name}-${Math.random()}`, name, arguments: args, status });

test("line counts come from the real diff, not from a length delta", () => {
  const before = "one\ntwo\nthree\n";
  const after = "one\ntwo point five\nthree\n";
  assert.deepEqual(countChangedLines(before, after), { additions: 1, deletions: 1, approximate: false });

  assert.deepEqual(countChangedLines("", "a\nb\n"), { additions: 2, deletions: 0, approximate: false });
  assert.deepEqual(countChangedLines("same\n", "same\n"), { additions: 0, deletions: 0, approximate: false });
});

test("a second edit to one file keeps the ORIGINAL before, so reject restores what the turn started from", () => {
  let changes = recordChange([], { path: "src/a.ts", before: "v1\n", after: "v2\n", existedBefore: true });
  changes = recordChange(changes, { path: "src/a.ts", before: "v2\n", after: "v3\n", existedBefore: true });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].before, "v1\n");
  assert.equal(changes[0].after, "v3\n");
});

test("an edit that lands the file back on its original content is not a change", () => {
  let changes = recordChange([], { path: "src/a.ts", before: "v1\n", after: "v2\n", existedBefore: true });
  changes = recordChange(changes, { path: "src/a.ts", before: "v2\n", after: "v1\n", existedBefore: true });
  assert.deepEqual(changes, []);
});

test("a created file is marked as created, so rejecting it means removal rather than an empty file", () => {
  const [change] = recordChange([], { path: "src/new.ts", before: "", after: "export const a = 1;\n", existedBefore: false });
  assert.equal(change.existedBefore, false);
  // A file that did not exist and now holds one line is still a change, even
  // though `before` and the empty string are the same thing.
  assert.ok(change.additions > 0);
});

test("totals add up across files", () => {
  let changes = recordChange([], { path: "a.ts", before: "x\n", after: "y\n", existedBefore: true });
  changes = recordChange(changes, { path: "b.ts", before: "x\n", after: "x\ny\n", existedBefore: true });
  const totals = changeTotals(changes);
  assert.equal(totals.files, 2);
  assert.ok(totals.additions >= 2);
  assert.equal(totals.approximate, false);
});

test("a path splits into the name the row shows and the directory beside it", () => {
  assert.deepEqual(splitPath("studio/server/releases.js"), { name: "releases.js", directory: "studio/server" });
  assert.deepEqual(splitPath("README.md"), { name: "README.md", directory: "" });
});

test("tool calls are classified by what they do, including when the name says nothing", () => {
  assert.equal(classifyCall(call("frontier.run_command", { command: "ls" })), "run");
  assert.equal(classifyCall(call("Edit", { path: "a.ts", content: "x" })), "edit");
  assert.equal(classifyCall(call("Grep", { pattern: "todo" })), "explore");
  assert.equal(classifyCall(call("mystery", { command: "ls" })), "run");
  assert.equal(classifyCall(call("mystery", {})), "other");
  assert.equal(pathOf(call("Read", { file_path: "src/App.tsx" })), "src/App.tsx");
});

test("consecutive calls of a kind collapse into one row, and the order between kinds survives", () => {
  const groups = groupActivity([
    call("Bash", { command: "ls" }),
    call("Bash", { command: "pwd" }),
    call("Read", { path: "src/App.tsx" }),
    call("Grep", { pattern: "useVoice" }),
    call("Bash", { command: "npm test" }),
  ]);

  assert.deepEqual(groups.map((group) => group.label), [
    "Ran 2 commands",
    "Explored 1 file, 1 search",
    "Ran npm test",
  ]);
  assert.deepEqual(groups.map((group) => group.kind), ["run", "explore", "run"]);
});

test("a group that is still working says so in the present tense", () => {
  const [group] = groupActivity([call("Bash", { command: "ls" }, "running"), call("Bash", { command: "pwd" }, "running")]);
  assert.equal(group.label, "Running 2 commands");
  assert.equal(group.status, "running");

  const [failed] = groupActivity([call("Bash", { command: "ls" }, "error")]);
  assert.equal(failed.status, "error");
});

test("an edit group names the file when there is only one, and counts them when there are several", () => {
  const single = groupActivity([call("Write", { path: "studio/electron/main.cjs", content: "x" })]);
  assert.equal(single[0].label, "Edited main.cjs");

  const many = groupActivity([
    call("Write", { path: "a.ts", content: "x" }),
    call("Write", { path: "b.ts", content: "x" }),
  ]);
  assert.equal(many[0].label, "Edited 2 files");
});
