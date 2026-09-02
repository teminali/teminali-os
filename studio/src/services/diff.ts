/**
 * Line-level diffing.
 *
 * Lives outside the modal that renders it because it is pure logic with a
 * contract worth testing, and a .tsx file cannot be imported by the node test
 * runner. The modal used to show two hardcoded hunks describing invented edits
 * to a file the operator had not touched; this computes the real one.
 */

export interface DiffLine {
  type: "addition" | "deletion" | "context";
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

export interface DiffChunk {
  id: string;
  header: string;
  lines: DiffLine[];
  isApplied: boolean;
}

/** Above this, an O(n·m) table would lock the renderer rather than help. */
export const MAX_DIFF_LINES = 4_000;

/* ── Diffing ──────────────────────────────────────────────────────────────── */

/**
 * A line-level diff, grouped into hunks with three lines of context.
 *
 * This is a longest-common-subsequence walk rather than a naive line-by-line
 * comparison: the naive version reports every line after an inserted one as
 * changed, which turns a one-line addition into a diff of the whole file.
 *
 * Bounded at 4,000 lines a side. LCS is O(n·m), and a large generated file
 * would otherwise lock the renderer while the operator waits to see one edit.
 */
export function diffChunks(oldCode: string, newCode: string, contextLines = 3): DiffChunk[] {
  const before = (oldCode ?? "").split("\n");
  const after = (newCode ?? "").split("\n");
  if (before.length > 4_000 || after.length > 4_000) {
    return [
      {
        id: "too-large",
        header: `@@ ${before.length} → ${after.length} lines @@`,
        isApplied: true,
        lines: [{ type: "context", content: "This file is too large to diff inline." }],
      },
    ];
  }

  // LCS table over line indices.
  const table: number[][] = Array.from({ length: before.length + 1 }, () => new Array(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      all.push({ type: "context", oldLineNumber: i + 1, newLineNumber: j + 1, content: before[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      all.push({ type: "deletion", oldLineNumber: i + 1, content: before[i] });
      i += 1;
    } else {
      all.push({ type: "addition", newLineNumber: j + 1, content: after[j] });
      j += 1;
    }
  }
  while (i < before.length) all.push({ type: "deletion", oldLineNumber: i + 1, content: before[i++] });
  while (j < after.length) all.push({ type: "addition", newLineNumber: j + 1, content: after[j++] });

  // Group changes into hunks, keeping `contextLines` either side. Unchanged
  // stretches between hunks are dropped — that is what makes a diff readable.
  const changed = all.map((line) => line.type !== "context");
  const keep = new Set<number>();
  for (let index = 0; index < all.length; index += 1) {
    if (!changed[index]) continue;
    for (let k = Math.max(0, index - contextLines); k <= Math.min(all.length - 1, index + contextLines); k += 1) {
      keep.add(k);
    }
  }
  if (keep.size === 0) return [];

  const chunks: DiffChunk[] = [];
  let current: DiffLine[] = [];
  let chunkStart = 0;
  for (let index = 0; index < all.length; index += 1) {
    if (keep.has(index)) {
      if (current.length === 0) chunkStart = index;
      current.push(all[index]);
      continue;
    }
    if (current.length > 0) {
      chunks.push(makeChunk(chunks.length, current, chunkStart));
      current = [];
    }
  }
  if (current.length > 0) chunks.push(makeChunk(chunks.length, current, chunkStart));
  return chunks;
}

function makeChunk(index: number, lines: DiffLine[], _start: number): DiffChunk {
  const firstOld = lines.find((line) => line.oldLineNumber !== undefined)?.oldLineNumber ?? 0;
  const firstNew = lines.find((line) => line.newLineNumber !== undefined)?.newLineNumber ?? 0;
  const oldCount = lines.filter((line) => line.type !== "addition").length;
  const newCount = lines.filter((line) => line.type !== "deletion").length;
  return {
    id: `chunk_${index + 1}`,
    header: `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`,
    isApplied: true,
    lines,
  };
}
