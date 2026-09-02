import assert from "node:assert/strict";
import test from "node:test";

import { diffChunks } from "../src/services/diff.ts";

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
