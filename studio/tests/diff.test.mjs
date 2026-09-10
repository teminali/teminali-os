import assert from "node:assert/strict";
import test from "node:test";

import { diffChunks, diffLineCounts } from "../src/services/diff.ts";

const lines = (n, from = 1) => Array.from({ length: n }, (_, i) => `line${i + from}`).join("\n");

test("identical files produce no hunks at all", () => {
  assert.deepEqual(diffChunks(lines(10), lines(10)), []);
});

test("a one-line change is one hunk, not a diff of the whole file", () => {
  const before = lines(20);
  const after = before.split("\n").map((line, i) => (i === 9 ? "CHANGED" : line)).join("\n");
  const chunks = diffChunks(before, after);

  assert.equal(chunks.length, 1);
  // 3 lines of context either side, plus the deletion and the addition.
  assert.equal(chunks[0].lines.filter((l) => l.type === "deletion").length, 1);
  assert.equal(chunks[0].lines.filter((l) => l.type === "addition").length, 1);
  assert.equal(chunks[0].lines.filter((l) => l.type === "context").length, 6);
});

test("an insertion does not mark every following line as changed", () => {
  // This is what a naive line-by-line comparison gets wrong: inserting one line
  // shifts everything after it, and a positional compare then reports the
  // entire remainder of the file as modified.
  const before = lines(30);
  const after = ["line1", "INSERTED", ...lines(29, 2).split("\n")].join("\n");

  const chunks = diffChunks(before, after);
  const additions = chunks.flatMap((c) => c.lines).filter((l) => l.type === "addition");
  const deletions = chunks.flatMap((c) => c.lines).filter((l) => l.type === "deletion");

  assert.equal(additions.length, 1, "one line was inserted, so one line was added");
  assert.equal(deletions.length, 0, "nothing was deleted");
  assert.equal(additions[0].content, "INSERTED");
});

test("distant changes become separate hunks, and the middle is dropped", () => {
  const before = lines(60);
  const after = before
    .split("\n")
    .map((line, i) => (i === 2 || i === 55 ? `${line}!` : line))
    .join("\n");

  const chunks = diffChunks(before, after);
  assert.equal(chunks.length, 2, "two edits 50 lines apart are two hunks");
  // The unchanged middle is what makes a diff readable; it must not be included.
  const rendered = chunks.flatMap((c) => c.lines).length;
  assert.ok(rendered < 25, `only context around the edits is kept, got ${rendered} lines`);
});

test("hunk headers carry real line numbers", () => {
  const before = lines(20);
  const after = before.split("\n").map((line, i) => (i === 9 ? "CHANGED" : line)).join("\n");
  const [chunk] = diffChunks(before, after);
  assert.match(chunk.header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  assert.match(chunk.header, /-7,/, "the hunk starts three lines of context before line 10");
});

test("deletions and additions at the file edges are not lost", () => {
  const head = diffChunks("gone\n" + lines(5), lines(5));
  assert.equal(head.flatMap((c) => c.lines).filter((l) => l.type === "deletion").length, 1);

  const tail = diffChunks(lines(5), lines(5) + "\nappended");
  assert.equal(tail.flatMap((c) => c.lines).filter((l) => l.type === "addition").length, 1);
});

test("an empty side is handled rather than throwing", () => {
  assert.equal(diffChunks("", "a\nb").flatMap((c) => c.lines).filter((l) => l.type === "addition").length, 2);
  assert.equal(diffChunks("a\nb", "").flatMap((c) => c.lines).filter((l) => l.type === "deletion").length, 2);
  assert.deepEqual(diffChunks("", ""), []);
});

test("a file too large to diff says so instead of locking up", () => {
  const huge = lines(5_000);
  const chunks = diffChunks(huge, `${huge}\nextra`);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].id, "too-large");
  assert.match(chunks[0].lines[0].content, /too large/);
});

/* ── diffLineCounts ───────────────────────────────────────────────────────── */

test("an unchanged file counts nothing", () => {
  assert.deepEqual(diffLineCounts(lines(10), lines(10)), { added: 0, removed: 0, exact: true });
});

test("a one-line change is one added and one removed, not the whole file", () => {
  const before = lines(200);
  const after = before.split("\n").map((line, i) => (i === 99 ? "CHANGED" : line)).join("\n");
  assert.deepEqual(diffLineCounts(before, after), { added: 1, removed: 1, exact: true });
});

test("an insertion in the middle does not report every line after it as changed", () => {
  const before = lines(50);
  const rows = before.split("\n");
  rows.splice(20, 0, "inserted");
  assert.deepEqual(diffLineCounts(before, rows.join("\n")), { added: 1, removed: 0, exact: true });
});

test("a new file is all additions", () => {
  assert.deepEqual(diffLineCounts("", lines(4)), { added: 4, removed: 0, exact: true });
  assert.deepEqual(diffLineCounts(null, lines(4)), { added: 4, removed: 0, exact: true });
  assert.deepEqual(diffLineCounts(undefined, "one line"), { added: 1, removed: 0, exact: true });
});

test("emptying a file is all removals", () => {
  assert.deepEqual(diffLineCounts(lines(3), ""), { added: 0, removed: 3, exact: true });
});

test("nothing at all is nothing, not one empty line", () => {
  assert.deepEqual(diffLineCounts("", ""), { added: 0, removed: 0, exact: true });
});

test("a trailing newline is not a phantom added line", () => {
  assert.deepEqual(diffLineCounts("a\nb", "a\nb\n"), { added: 0, removed: 0, exact: true });
  assert.deepEqual(diffLineCounts("a\nb\n", "a\nb\nc\n"), { added: 1, removed: 0, exact: true });
});

test("windows line endings count the same as unix ones", () => {
  assert.deepEqual(diffLineCounts("a\r\nb\r\n", "a\nb\nc\n"), { added: 1, removed: 0, exact: true });
});

test("a replaced block counts both sides", () => {
  const before = ["keep", "old one", "old two", "old three", "tail"].join("\n");
  const after = ["keep", "new one", "tail"].join("\n");
  assert.deepEqual(diffLineCounts(before, after), { added: 1, removed: 3, exact: true });
});

test("two files with no common head or tail are counted whole", () => {
  assert.deepEqual(diffLineCounts("alpha", "beta"), { added: 1, removed: 1, exact: true });
});

test("a rewrite too large to match line-for-line says so instead of guessing", () => {
  const before = Array.from({ length: 2_500 }, (_, i) => `old${i}`).join("\n");
  const after = Array.from({ length: 2_400 }, (_, i) => `new${i}`).join("\n");
  const counts = diffLineCounts(before, after);
  assert.equal(counts.exact, false);
  assert.equal(counts.added, 2_400);
  assert.equal(counts.removed, 2_500);
});

test("a small edit inside a huge file is still counted exactly", () => {
  const rows = Array.from({ length: 20_000 }, (_, i) => `line${i}`);
  const before = rows.join("\n");
  rows[12_345] = "touched";
  assert.deepEqual(diffLineCounts(before, rows.join("\n")), { added: 1, removed: 1, exact: true });
});
