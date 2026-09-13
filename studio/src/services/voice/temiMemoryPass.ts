import { absorb, consolidate, defaultMemoryId, type MemoryAtom } from "./temiMemory.ts";
import { extractMemories, type CompleteFn, type TranscriptTurn } from "./temiMemoryExtract.ts";

/**
 * The post-session pass: everything that happens to Temi's memory, happening
 * once, after she has stopped talking.
 *
 * Read the store, read the conversation, decide what was worth keeping, fold it
 * in, forget what time has taken, write it back. Five steps, and the only
 * interesting thing about them is WHEN they run, which is never during a turn
 * and never during a session. That is the DESIGN.md §6.48 latency contract, and
 * this file is where it is either kept or broken.
 *
 * Nothing here is on the live path, so it can be slow, and it is: one model call
 * over a whole transcript. Being slow is the point. The alternative design, a
 * tool she calls mid-sentence to remember something, was rejected precisely
 * because it converts this cost into latency he can hear.
 */

export interface MemoryPassOptions {
  /** The conversation that just ended. Committed turns only, not live captions. */
  turns: readonly TranscriptTurn[];
  complete: CompleteFn;
  now?: number;
  /** Injected so a pass runs identically twice under test. */
  newId?: () => string;
  /**
   * The store, handed in rather than imported, exactly as `complete` is.
   *
   * Required, with no default, and that is worth a line. A default would mean
   * importing `temiMemoryStore.ts`, which imports the gateway client, which
   * these services cannot pull in: they are loaded as TypeScript directly by
   * `node --test`, so an import here is a browser dependency every future test
   * of this file has to stand up first. Keeping them as arguments is also the
   * more honest shape. This function replaces the whole store, and a call site
   * that has to name the thing it is about to overwrite is a call site where
   * that is visible.
   *
   * `load` must be the read that THROWS, not the one that swallows. See
   * `loadTemiMemory`.
   */
  load: () => Promise<MemoryAtom[]>;
  save: (atoms: readonly MemoryAtom[]) => Promise<MemoryAtom[]>;
}

/**
 * Why the pass did what it did, which is the only way to tell a session that
 * held nothing worth keeping from one where the model was unreachable. Both
 * write nothing; only one of them is fine.
 */
export type MemoryPassOutcome =
  | "saved"
  | "no-transcript"
  | "load-failed"
  | "extraction-failed"
  | "nothing-changed"
  | "save-failed";

export interface MemoryPassReport {
  outcome: MemoryPassOutcome;
  /** New memories laid down. */
  laid: number;
  /** Existing memories he brought back up. */
  rehearsed: number;
  /** Anchors displaced by a newer answer to the same question. */
  superseded: number;
  /** Memories that lost their detail this pass. */
  faded: number;
  /** Memories that left. */
  forgotten: number;
  /** What the store holds now. */
  kept: number;
}

const EMPTY: Omit<MemoryPassReport, "outcome"> = {
  laid: 0,
  rehearsed: 0,
  superseded: 0,
  faded: 0,
  forgotten: 0,
  kept: 0,
};

/**
 * Runs the pass. Never throws, whatever happens, because the only caller is a
 * teardown and there is nobody left to catch.
 *
 * Every failure path writes NOTHING, and that is deliberate in a way worth
 * spelling out, because it is not the obvious choice in two places.
 *
 * A failed LOAD could plausibly be treated as an empty store: this might be the
 * first run. It is not treated that way, because a save replaces the store
 * wholesale, so guessing wrong once destroys everything she has, silently, and
 * the pass reports success while doing it. The two cases are indistinguishable
 * from here and only one of them is recoverable, so it declines.
 *
 * A failed EXTRACTION could plausibly still consolidate: the store loaded fine,
 * time has genuinely passed, and decay is real whether or not a model answered.
 * It does not, for a smaller reason. Forgetting deferred costs nothing, because
 * `selectForRecall` ranks by retention and never chooses a dead atom, so an
 * expired memory is invisible from the moment it expires and merely lingers on
 * disk until the next good pass. Writing on a failure path to achieve something
 * that is already true is how a write path gets exercised only when something
 * is already wrong.
 */
export async function runMemoryPass(options: MemoryPassOptions): Promise<MemoryPassReport> {
  const now = options.now ?? Date.now();
  const turns = options.turns.filter((t) => typeof t?.content === "string" && t.content.trim().length > 0);
  if (turns.length === 0) return { outcome: "no-transcript", ...EMPTY };

  let existing: MemoryAtom[];
  try {
    existing = await options.load();
  } catch {
    return { outcome: "load-failed", ...EMPTY };
  }

  let candidates;
  try {
    candidates = await extractMemories(turns, options.complete);
  } catch {
    return { outcome: "extraction-failed", ...EMPTY, kept: existing.length };
  }

  const absorbed = absorb(existing, candidates, now, options.newId ?? defaultMemoryId);
  const settled = consolidate(absorbed.atoms, now);

  const counts = {
    laid: absorbed.laid.length,
    rehearsed: absorbed.rehearsed.length,
    superseded: absorbed.superseded.length,
    faded: settled.faded.length,
    forgotten: settled.forgotten.length,
    kept: settled.kept.length,
  };

  // Nothing happened, so nothing is written. A quiet session should not rewrite
  // the file, both because the write is pointless and because a store whose
  // mtime changes every time he opens the voice screen tells you nothing about
  // when he was last actually remembered.
  const changed =
    counts.laid > 0 || counts.rehearsed > 0 || counts.superseded > 0 || counts.faded > 0 || counts.forgotten > 0;
  if (!changed) return { outcome: "nothing-changed", ...counts };

  try {
    const stored = await options.save(settled.kept);
    return { outcome: "saved", ...counts, kept: stored.length };
  } catch {
    return { outcome: "save-failed", ...counts, kept: existing.length };
  }
}

/**
 * One line for the console, because this is the only window onto a thing that
 * happens when nobody is watching.
 *
 * Deliberately readable rather than structured: the pass runs on a teardown,
 * the numbers are small, and the question anyone actually has when they look is
 * "did she keep anything from that conversation".
 */
export function formatMemoryPass(report: MemoryPassReport): string {
  if (report.outcome !== "saved" && report.outcome !== "nothing-changed") {
    return `[temi-memory] ${report.outcome}, nothing written`;
  }
  return (
    `[temi-memory] ${report.outcome}: +${report.laid} new, ${report.rehearsed} again, ` +
    `${report.superseded} superseded, ${report.faded} faded, ${report.forgotten} forgotten, ${report.kept} held`
  );
}
