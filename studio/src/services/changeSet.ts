/**
 * The pending change set — what the assistant wrote to disk this session, and
 * has not yet been accepted or rejected.
 *
 * Pure, and outside the store that holds it, for the same reason `diff.ts` is
 * outside the modal that renders it: the arithmetic of "what changed and by how
 * much" has a contract worth testing, and the node test runner cannot import a
 * `.tsx`. See tests/change-review.test.mjs.
 *
 * The rule that makes accept/reject honest: `before` is captured once, from the
 * first edit to that path, and never overwritten. Two successive edits to one
 * file collapse into a single reviewable change whose `before` is still what
 * was on disk when the turn started — so rejecting restores the file the
 * operator actually had, not the state halfway through the turn.
 */

// The `.ts` extension is carried deliberately: tests/change-review.test.mjs
// imports this module through the node test runner, which resolves the
// specifier literally. Vite and `tsc` (allowImportingTsExtensions) both accept it.
import { diffChunks, MAX_DIFF_LINES } from "./diff.ts";

export type ChangeOrigin = "live-edit" | "agent" | "manual";

export interface FileChange {
  /** Workspace-relative path, as the workspace API addresses it. */
  path: string;
  /** Content on disk before the assistant touched it; "" for a new file. */
  before: string;
  /** Content the assistant wrote. */
  after: string;
  /** False when the assistant created the file, which changes what reject means. */
  existedBefore: boolean;
  additions: number;
  deletions: number;
  /** True when the file was too large to diff exactly and the counts are trimmed estimates. */
  approximate: boolean;
  origin: ChangeOrigin;
  /** The assistant turn that produced it, so a change can be traced back. */
  requestId: string | null;
  recordedAt: string;
}

export interface ChangeTotals {
  files: number;
  additions: number;
  deletions: number;
  approximate: boolean;
}

/**
 * Line counts for one edit.
 *
 * Exact through `diffChunks` — a longest-common-subsequence walk — for anything
 * inside its bound. Past that bound an LCS would lock the renderer, so the
 * counts come from trimming the common head and tail and counting what is left.
 * That over-counts a multi-hunk edit, which is why it is flagged rather than
 * quietly reported as a measurement.
 */
export function countChangedLines(before: string, after: string): {
  additions: number;
  deletions: number;
  approximate: boolean;
} {
  const oldLines = (before ?? "").split("\n");
  const newLines = (after ?? "").split("\n");

  if (oldLines.length <= MAX_DIFF_LINES && newLines.length <= MAX_DIFF_LINES) {
    let additions = 0;
    let deletions = 0;
    for (const chunk of diffChunks(before ?? "", after ?? "")) {
      for (const line of chunk.lines) {
        if (line.type === "addition") additions += 1;
        else if (line.type === "deletion") deletions += 1;
      }
    }
    return { additions, deletions, approximate: false };
  }

  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  return {
    additions: Math.max(0, newLines.length - head - tail),
    deletions: Math.max(0, oldLines.length - head - tail),
    approximate: true,
  };
}

export interface RecordChangeInput {
  path: string;
  before: string;
  after: string;
  existedBefore?: boolean;
  origin?: ChangeOrigin;
  requestId?: string | null;
  recordedAt?: string;
}

/**
 * Fold one write into the pending set.
 *
 * A second write to the same path replaces the `after` and keeps the original
 * `before`. A write that lands the file back on its original content drops out
 * of the set entirely — there is nothing to accept or reject about a file that
 * did not, in the end, change.
 */
export function recordChange(changes: FileChange[], input: RecordChangeInput): FileChange[] {
  const existing = changes.find((change) => change.path === input.path);
  const before = existing ? existing.before : (input.before ?? "");
  const existedBefore = existing ? existing.existedBefore : input.existedBefore ?? before.length > 0;
  const after = input.after ?? "";

  if (before === after && existedBefore) {
    return changes.filter((change) => change.path !== input.path);
  }

  const counts = countChangedLines(before, after);
  const change: FileChange = {
    path: input.path,
    before,
    after,
    existedBefore,
    ...counts,
    origin: input.origin ?? existing?.origin ?? "live-edit",
    requestId: input.requestId ?? existing?.requestId ?? null,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };

  return existing
    ? changes.map((entry) => (entry.path === input.path ? change : entry))
    : [...changes, change];
}

export function changeTotals(changes: FileChange[]): ChangeTotals {
  return {
    files: changes.length,
    additions: changes.reduce((total, change) => total + change.additions, 0),
    deletions: changes.reduce((total, change) => total + change.deletions, 0),
    approximate: changes.some((change) => change.approximate),
  };
}

/** `src/components/chat/Composer.tsx` → `Composer.tsx` + `src/components/chat`. */
export function splitPath(path: string): { name: string; directory: string } {
  const segments = path.split("/").filter(Boolean);
  const name = segments.pop() ?? path;
  return { name, directory: segments.join("/") };
}
