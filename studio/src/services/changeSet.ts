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

/**
 * How much of the pending set is kept in memory.
 *
 * Both sides of every change are held in full so a reject can restore the file
 * exactly, which means the set is as large as the work done through it. An
 * agent turn can write a megabyte a side, so a long unreviewed session would
 * otherwise grow without limit inside the renderer.
 */
export const MAX_PENDING_CHANGES = 100;
export const MAX_PENDING_BYTES = 32 * 1024 * 1024;

/**
 * Age the oldest changes out of the set once it outgrows its budget.
 *
 * The rows that go are **accepted, not reverted** — that is the only safe
 * reading. The bytes are already on disk and they stay there; all that is lost
 * is the offer to put them back. The alternative, dropping the newest instead,
 * would leave the operator reviewing history while the edit they just watched
 * land went unlisted; and reverting anything to save memory would destroy work
 * nobody asked to destroy.
 *
 * Oldest means first written, not least recently written: the array is in
 * first-touch order and a repeat write to a path updates in place, so a file
 * the agent keeps returning to does not keep renewing its place in the queue.
 * It has been on the operator's screen the longest either way.
 */
export function trimChanges(changes: FileChange[]): { changes: FileChange[]; dropped: number } {
  let kept = changes;
  if (kept.length > MAX_PENDING_CHANGES) kept = kept.slice(kept.length - MAX_PENDING_CHANGES);

  let bytes = 0;
  for (const change of kept) bytes += change.before.length + change.after.length;
  let from = 0;
  // Never empty on size alone: one change larger than the whole budget is
  // still the change the operator is looking at.
  while (bytes > MAX_PENDING_BYTES && from < kept.length - 1) {
    bytes -= kept[from].before.length + kept[from].after.length;
    from += 1;
  }
  if (from > 0) kept = kept.slice(from);

  return { changes: kept, dropped: changes.length - kept.length };
}

/**
 * What the disk holds for a path right now. Null means nothing is there.
 * `modified` is the mtime a write can be made conditional on.
 */
export interface DiskState {
  content: string;
  modified?: string;
}

export type RejectPlan =
  /** Put `content` back, refusing if the file moved under us first. */
  | { action: "restore"; content: string; expectedModified: string | null | undefined }
  /** Remove a file the assistant created. */
  | { action: "delete" }
  /** Already in the state a reject was asking for; only the row is left to clear. */
  | { action: "already-gone" }
  | { action: "refuse"; reason: string };

/**
 * Decide what rejecting one change should actually do.
 *
 * This is the whole safety argument of the dock, so it is a function rather
 * than a branch inside an async handler: a reject is the only operation here
 * that destroys anything, and it must never destroy something it was not shown.
 *
 * The rule is that a row describes a *transition* — `before` became `after` —
 * and reject is only meaningful while the second half of that is still true. If
 * the file has moved on since (the operator edited and saved it, a later agent
 * turn touched it, git checked something out underneath), then `before` is no
 * longer the state immediately prior to what is on disk, and writing it back
 * would silently discard whatever came after. So that case refuses and says
 * why, and the operator opens the file and decides. Refusing costs them one
 * click; being wrong costs them their work.
 *
 * A file that is simply *gone* is treated differently in each direction, and
 * deliberately. If the assistant created it, gone is the outcome reject was
 * asking for — nothing to do. If the assistant edited a file that has since
 * been deleted, restoring `before` re-creates it, which destroys nothing and is
 * the plainest reading of "put it back"; `expectedModified: null` makes that
 * write refuse if the file reappears underneath in the meantime.
 */
export function planReject(change: FileChange, current: DiskState | null): RejectPlan {
  if (current && current.content !== change.after) {
    const { name } = splitPath(change.path);
    return {
      action: "refuse",
      reason: `${name} has changed since the assistant wrote it. Rejecting now would discard that too — open the file and decide.`,
    };
  }
  if (change.existedBefore) {
    // Three states, not two: an mtime to match, `null` for "must still be
    // absent", and `undefined` for a server that reported no mtime at all,
    // where an unconditional write beats refusing every reject.
    return { action: "restore", content: change.before, expectedModified: current ? current.modified : null };
  }
  return current ? { action: "delete" } : { action: "already-gone" };
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
