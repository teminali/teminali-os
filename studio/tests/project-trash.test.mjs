/**
 * The one control in Teminali OS that removes something from the disk.
 *
 * `trashRefusalReason` is the whole of its judgement, and it is a pure function
 * precisely so this file can reach it — the IPC handler around it needs a live
 * Electron and a real Trash, and so is not testable on this machine at all.
 *
 * The cases that matter are the ones where a path looks like a project and is
 * not: the home folder, something above it, the disk root, and anything
 * relative, which is not a path so much as a question about where the process
 * is standing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { trashRefusalReason } from "../electron/projectTrash.cjs";

const HOME = "/Users/teminali";

test("an ordinary project directory may be trashed", () => {
  assert.equal(trashRefusalReason("/Users/teminali/Documents/my_projects/thing", { home: HOME }), null);
});

test("a project outside the home folder may be trashed too", () => {
  // No allowlist of parent directories: people keep code on other volumes.
  assert.equal(trashRefusalReason("/Volumes/Work/checkouts/thing", { home: HOME }), null);
});

test("the home folder itself is not a project", () => {
  const reason = trashRefusalReason(HOME, { home: HOME });
  assert.match(reason, /home folder/);
});

test("a directory above the home folder is refused, and says which", () => {
  const reason = trashRefusalReason("/Users", { home: HOME });
  assert.match(reason, /contains your home folder/);
  assert.match(reason, /\/Users/);
});

test("the disk root is refused", () => {
  assert.match(trashRefusalReason("/", { home: HOME }), /disk root/);
});

test("a trailing slash does not smuggle the home folder past the check", () => {
  // `/Users/teminali/` and `/Users/teminali` are one directory; a rule that
  // compares strings without normalising would allow one of them.
  assert.match(trashRefusalReason(`${HOME}/`, { home: HOME }), /home folder/);
  assert.match(trashRefusalReason("//", { home: HOME }), /disk root|home folder/);
});

test("a relative path is refused rather than resolved", () => {
  // Resolving it against the main process's working directory is how a delete
  // lands somewhere nobody chose.
  assert.match(trashRefusalReason("my_projects/thing", { home: HOME }), /absolute path/);
  assert.match(trashRefusalReason("../../thing", { home: HOME }), /absolute path/);
});

test("an empty or missing path is refused without pretending to know why", () => {
  assert.match(trashRefusalReason("", { home: HOME }), /No project path/);
  assert.match(trashRefusalReason("   ", { home: HOME }), /No project path/);
  assert.match(trashRefusalReason(undefined, { home: HOME }), /No project path/);
  assert.match(trashRefusalReason(null, { home: HOME }), /No project path/);
});

test("a sibling of the home folder whose name starts the same is not confused for it", () => {
  // `/Users/teminali-backup` starts with `/Users/teminali`, and a `startsWith`
  // without the separator would read it as the home folder.
  assert.equal(trashRefusalReason("/Users/teminali-backup", { home: HOME }), null);
});

test("with no home known, only the root and the malformed are refused", () => {
  assert.equal(trashRefusalReason("/Users/teminali", {}), null);
  assert.match(trashRefusalReason("/", {}), /disk root/);
});
