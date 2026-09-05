import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_EDIT_MAX_BYTES, createEditWatcher, editTargets, editsApplyTo, reverseEdits } from "../server/agent-edits.js";

const ROOT = "/workspace";

/**
 * A watcher over a fake disk, so the race the real one runs against can be
 * staged rather than hoped for: mutate `disk` between the running and the
 * completed event and the snapshot has lost, leave it and the snapshot has won.
 */
function harness(disk = {}) {
  const emitted = [];
  const watcher = createEditWatcher({
    root: ROOT,
    emit: (event) => emitted.push(event),
    read: (absolutePath) =>
      absolutePath in disk
        ? { existed: true, content: disk[absolutePath], size: disk[absolutePath].length, modified: "2026-09-06T00:00:00.000Z" }
        : { existed: false, content: "" },
  });
  return { watcher, emitted, disk };
}

const running = (id, name, input) => ({ type: "tool", id, name, input, status: "running" });
const completed = (id) => ({ type: "tool", id, status: "completed" });

/* ── editTargets ─────────────────────────────────────────────────────────── */

test("a Write names its file and offers nothing to reverse", () => {
  assert.deepEqual(editTargets("Write", { file_path: "/workspace/a.ts", content: "x" }), [
    { path: "/workspace/a.ts", edits: null },
  ]);
});

test("an Edit carries the substitution that undoes it", () => {
  assert.deepEqual(editTargets("Edit", { file_path: "/workspace/a.ts", old_string: "a", new_string: "b" }), [
    { path: "/workspace/a.ts", edits: [{ oldText: "a", newText: "b", replaceAll: false }] },
  ]);
});

test("a MultiEdit carries every substitution in order", () => {
  const [target] = editTargets("MultiEdit", {
    file_path: "/workspace/a.ts",
    edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d", replace_all: true }],
  });
  assert.equal(target.edits.length, 2);
  assert.equal(target.edits[1].replaceAll, true);
});

test("an Edit whose payload is malformed keeps the path and loses the inverse", () => {
  const [target] = editTargets("Edit", { file_path: "/workspace/a.ts", old_string: "a" });
  assert.equal(target.path, "/workspace/a.ts");
  assert.equal(target.edits, null);
});

test("Codex's file change is read in each shape it has been seen in", () => {
  const paths = (changes) => editTargets("Edit", { changes }).map((target) => target.path);
  assert.deepEqual(paths("/workspace/a.ts"), ["/workspace/a.ts"]);
  assert.deepEqual(paths(["/workspace/a.ts", "/workspace/b.ts"]), ["/workspace/a.ts", "/workspace/b.ts"]);
  assert.deepEqual(paths([{ path: "/workspace/a.ts", kind: "update" }]), ["/workspace/a.ts"]);
  assert.deepEqual(paths({ "/workspace/a.ts": { kind: "add" } }), ["/workspace/a.ts"]);
  assert.deepEqual(paths(null), []);
});

test("a tool that does not write is not watched", () => {
  assert.deepEqual(editTargets("Bash", { command: "rm -rf /" }), []);
  assert.deepEqual(editTargets("Read", { file_path: "/workspace/a.ts" }), []);
});

/* ── reverseEdits ────────────────────────────────────────────────────────── */

test("a substitution is undone on the text it produced", () => {
  assert.equal(reverseEdits("const b = 1;", [{ oldText: "a", newText: "b", replaceAll: false }]), "const a = 1;");
});

test("a replace-all is undone everywhere", () => {
  assert.equal(reverseEdits("b b b", [{ oldText: "a", newText: "b", replaceAll: true }]), "a a a");
});

test("multiple edits are undone last-first", () => {
  const edits = [{ oldText: "one", newText: "two", replaceAll: false }, { oldText: "two", newText: "three", replaceAll: false }];
  assert.equal(reverseEdits("three", edits), "one");
});

test("an ambiguous reversal is refused rather than guessed", () => {
  assert.equal(reverseEdits("b and b", [{ oldText: "a", newText: "b", replaceAll: false }]), null);
});

test("a deletion cannot be reversed, because the result no longer holds its site", () => {
  assert.equal(reverseEdits("clean", [{ oldText: "dirty", newText: "", replaceAll: false }]), null);
});

test("a substitution that is not in the result is refused", () => {
  assert.equal(reverseEdits("unrelated", [{ oldText: "a", newText: "b", replaceAll: false }]), null);
});

test("a replacement containing $& is treated as literal text, not a pattern", () => {
  assert.equal(editsApplyTo("keep a here", [{ oldText: "a", newText: "$&$1", replaceAll: false }]), true);
  assert.equal(reverseEdits("keep $&$1 here", [{ oldText: "a", newText: "$&$1", replaceAll: false }]), "keep a here");
});

test("editsApplyTo tells a pre-edit snapshot from a stale one", () => {
  const edits = [{ oldText: "a", newText: "b", replaceAll: false }];
  assert.equal(editsApplyTo("const a = 1;", edits), true);
  assert.equal(editsApplyTo("const b = 1;", edits), false);
});

/* ── the watcher ─────────────────────────────────────────────────────────── */

test("a Write reports both sides of the file it replaced", () => {
  const { watcher, emitted, disk } = harness({ "/workspace/a.ts": "old" });
  watcher.onTool(running("t1", "Write", { file_path: "/workspace/a.ts", content: "new" }));
  disk["/workspace/a.ts"] = "new";
  watcher.onTool(completed("t1"));
  assert.deepEqual(emitted, [{
    type: "edit", path: "a.ts", before: "old", after: "new", existedBefore: true, size: 3, modified: "2026-09-06T00:00:00.000Z",
  }]);
});

test("a Write that creates a file reports an empty before, and says so", () => {
  const { watcher, emitted, disk } = harness();
  watcher.onTool(running("t1", "Write", { file_path: "/workspace/new.ts", content: "hello" }));
  disk["/workspace/new.ts"] = "hello";
  watcher.onTool(completed("t1"));
  assert.equal(emitted[0].before, "");
  assert.equal(emitted[0].existedBefore, false);
});

test("an Edit whose snapshot won the race uses the snapshot", () => {
  const { watcher, emitted, disk } = harness({ "/workspace/a.ts": "const a = 1;\n// trailing" });
  watcher.onTool(running("t1", "Edit", { file_path: "/workspace/a.ts", old_string: "a", new_string: "b" }));
  disk["/workspace/a.ts"] = "const b = 1;\n// trailing";
  watcher.onTool(completed("t1"));
  assert.equal(emitted[0].before, "const a = 1;\n// trailing");
});

test("an Edit whose snapshot lost the race is recovered from the result", () => {
  // The write landed before the snapshot: both reads see the edited file.
  const { watcher, emitted } = harness({ "/workspace/a.ts": "const b = 1;" });
  watcher.onTool(running("t1", "Edit", { file_path: "/workspace/a.ts", old_string: "a", new_string: "b" }));
  watcher.onTool(completed("t1"));
  assert.equal(emitted[0].before, "const a = 1;");
  assert.equal(emitted[0].after, "const b = 1;");
  assert.equal(emitted[0].existedBefore, true);
});

test("an Edit that lost the race and cannot be reversed is dropped, not guessed", () => {
  const { watcher, emitted } = harness({ "/workspace/a.ts": "b and b" });
  watcher.onTool(running("t1", "Edit", { file_path: "/workspace/a.ts", old_string: "a", new_string: "b" }));
  watcher.onTool(completed("t1"));
  assert.deepEqual(emitted, []);
});

test("a Write whose snapshot lost the race is dropped rather than shown as an empty diff", () => {
  const { watcher, emitted } = harness({ "/workspace/a.ts": "new" });
  watcher.onTool(running("t1", "Write", { file_path: "/workspace/a.ts", content: "new" }));
  watcher.onTool(completed("t1"));
  assert.deepEqual(emitted, []);
});

test("a failed tool wrote nothing to review", () => {
  const { watcher, emitted, disk } = harness({ "/workspace/a.ts": "old" });
  watcher.onTool(running("t1", "Write", { file_path: "/workspace/a.ts", content: "new" }));
  disk["/workspace/a.ts"] = "new";
  watcher.onTool({ type: "tool", id: "t1", status: "error", isError: true });
  assert.deepEqual(emitted, []);
});

test("a file the agent deleted is not offered for review", () => {
  const { watcher, emitted, disk } = harness({ "/workspace/a.ts": "old" });
  watcher.onTool(running("t1", "Write", { file_path: "/workspace/a.ts", content: "new" }));
  delete disk["/workspace/a.ts"];
  watcher.onTool(completed("t1"));
  assert.deepEqual(emitted, []);
});

test("a path outside the workspace is never watched", () => {
  const { watcher, emitted, disk } = harness({ "/etc/passwd": "root" });
  watcher.onTool(running("t1", "Write", { file_path: "/etc/passwd", content: "owned" }));
  disk["/etc/passwd"] = "owned";
  watcher.onTool(completed("t1"));
  assert.deepEqual(emitted, []);
});

test("a path the workspace API could not write back is never watched", () => {
  // Reject restores by calling `writeWorkspaceFile`, which refuses anything
  // outside its text set — so a row for one would be a promise the dock
  // cannot keep.
  const { watcher, emitted, disk } = harness({ "/workspace/logo.png": "old" });
  watcher.onTool(running("t1", "Write", { file_path: "/workspace/logo.png", content: "new" }));
  disk["/workspace/logo.png"] = "new";
  watcher.onTool(completed("t1"));
  assert.deepEqual(emitted, []);
});

test("a file whose whole name is its extension is watched like any other text", () => {
  // This was the standing gap: `extname(".gitignore")` is "", so the write
  // path refused it and the dock could not record it. Both now admit it by
  // name, and the two must not drift apart again.
  const { watcher, emitted, disk } = harness({ "/workspace/.gitignore": "old" });
  watcher.onTool(running("t1", "Write", { file_path: "/workspace/.gitignore", content: "new" }));
  disk["/workspace/.gitignore"] = "new";
  watcher.onTool(completed("t1"));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].path, ".gitignore");
  assert.equal(emitted[0].before, "old");
});

test("a tool the turn never finished leaves nothing behind", () => {
  const { watcher, emitted, disk } = harness({ "/workspace/a.ts": "old" });
  watcher.onTool(running("t1", "Write", { file_path: "/workspace/a.ts", content: "new" }));
  watcher.close();
  disk["/workspace/a.ts"] = "new";
  watcher.onTool(completed("t1"));
  assert.deepEqual(emitted, []);
});

test("two tools in flight at once settle independently", () => {
  const { watcher, emitted, disk } = harness({ "/workspace/a.ts": "a-old", "/workspace/b.ts": "b-old" });
  watcher.onTool(running("t1", "Write", { file_path: "/workspace/a.ts", content: "a-new" }));
  watcher.onTool(running("t2", "Write", { file_path: "/workspace/b.ts", content: "b-new" }));
  disk["/workspace/b.ts"] = "b-new";
  watcher.onTool(completed("t2"));
  disk["/workspace/a.ts"] = "a-new";
  watcher.onTool(completed("t1"));
  assert.deepEqual(emitted.map((event) => event.path), ["b.ts", "a.ts"]);
});

test("a nested path is reported workspace-relative, as the workspace API addresses it", () => {
  const { watcher, emitted, disk } = harness({ "/workspace/src/deep/a.ts": "old" });
  watcher.onTool(running("t1", "Write", { file_path: "/workspace/src/deep/a.ts", content: "new" }));
  disk["/workspace/src/deep/a.ts"] = "new";
  watcher.onTool(completed("t1"));
  assert.equal(emitted[0].path, "src/deep/a.ts");
});

test("over the real filesystem, a Write is read, sized and stamped", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-edits-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");

  const emitted = [];
  const watcher = createEditWatcher({ root, emit: (event) => emitted.push(event) });
  watcher.onTool(running("t1", "Edit", { file_path: join(root, "src", "a.ts"), old_string: "1", new_string: "2" }));
  writeFileSync(join(root, "src", "a.ts"), "const a = 2;\n");
  watcher.onTool(completed("t1"));

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].path, "src/a.ts");
  assert.equal(emitted[0].before, "const a = 1;\n");
  assert.equal(emitted[0].after, "const a = 2;\n");
  assert.equal(emitted[0].size, 13);
  assert.match(emitted[0].modified, /^\d{4}-\d{2}-\d{2}T/);
});

test("the stream budget is a megabyte a side, not the workspace API's eight", () => {
  assert.equal(AGENT_EDIT_MAX_BYTES, 1024 * 1024);
});
