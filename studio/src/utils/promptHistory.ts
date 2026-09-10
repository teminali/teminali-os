/**
 * Up-arrow prompt history, the way a shell and both agent CLIs do it.
 *
 * Pure, and in `utils/` rather than inside the composer, because the studio
 * suite has no DOM: a ring buffer written inside a component is a ring buffer
 * nothing can test. What the composer keeps is a ref holding this state and
 * three calls into it.
 *
 * Two rules carry the whole feel of it:
 *
 *   1. **The draft is not lost.** Pressing Up with something half-written puts
 *      that text aside and hands it back when you walk past the newest entry.
 *      A history that eats the draft is one people stop pressing Up in.
 *   2. **Browsing is a position, not a mode.** `index` is `-1` until Up is
 *      pressed and returns to `-1` the moment a prompt is sent or the operator
 *      types — so there is no state to tear down and no way to be stuck in it.
 *
 * In memory, for the life of the window. Persisting it across restarts is a
 * separate decision with a storage key attached; this is deliberately not that.
 */

/** How many prompts are kept. Bash keeps 500; a chat composer is not a shell. */
export const HISTORY_LIMIT = 100;

export interface PromptHistory {
  /** Oldest first, newest last — the order Up walks backwards through. */
  readonly entries: readonly string[];
  /** Index into `entries` counted from the newest; `-1` means "not browsing". */
  readonly index: number;
  /** What was in the box when browsing began. */
  readonly draft: string;
}

export const EMPTY_HISTORY: PromptHistory = { entries: [], index: -1, draft: "" };

/**
 * Records a sent prompt and leaves browsing.
 *
 * A blank prompt is not history, and neither is the same prompt twice in a row:
 * pressing Up after re-sending something would otherwise walk through two
 * copies of it before reaching anything else.
 */
export function remember(history: PromptHistory, prompt: string): PromptHistory {
  const clean = prompt.trim();
  if (!clean) return history.index === -1 && !history.draft ? history : { ...history, index: -1, draft: "" };
  if (history.entries[history.entries.length - 1] === clean) {
    return { ...history, index: -1, draft: "" };
  }
  const entries = [...history.entries, clean].slice(-HISTORY_LIMIT);
  return { entries, index: -1, draft: "" };
}

/**
 * One step towards the older end.
 *
 * `current` is what is in the box right now; it becomes the draft on the first
 * step and is ignored on every step after, because by then the box holds an
 * entry rather than anything the operator wrote.
 *
 * Returns `null` when there is nowhere to go, which is the composer's signal to
 * let the keystroke through as ordinary caret movement.
 */
export function older(history: PromptHistory, current: string): { history: PromptHistory; value: string } | null {
  if (history.entries.length === 0) return null;
  const next = history.index + 1;
  if (next >= history.entries.length) return null;
  const draft = history.index === -1 ? current : history.draft;
  const value = history.entries[history.entries.length - 1 - next];
  return { history: { entries: history.entries, index: next, draft }, value };
}

/**
 * One step towards the newer end, and off the end back into the draft.
 *
 * Stepping past the newest entry is not a no-op: it restores what was being
 * typed and stops browsing, so Down is a way out rather than a wall.
 */
export function newer(history: PromptHistory): { history: PromptHistory; value: string } | null {
  if (history.index < 0) return null;
  const next = history.index - 1;
  if (next < 0) {
    return { history: { entries: history.entries, index: -1, draft: "" }, value: history.draft };
  }
  const value = history.entries[history.entries.length - 1 - next];
  return { history: { entries: history.entries, index: next, draft: history.draft }, value };
}

/** Leaves browsing without changing what is in the box — what typing does. */
export function stopBrowsing(history: PromptHistory): PromptHistory {
  if (history.index === -1 && !history.draft) return history;
  return { entries: history.entries, index: -1, draft: "" };
}

/**
 * Whether Up at this caret means history rather than "go up one line".
 *
 * A two-line draft has a line above the caret to move to, and stealing that
 * keystroke would make the composer unable to edit its own first line. History
 * only claims Up on the first line, and Down only on the last.
 */
export function atFirstLine(value: string, caret: number): boolean {
  return !value.slice(0, caret).includes("\n");
}

export function atLastLine(value: string, caret: number): boolean {
  return !value.slice(caret).includes("\n");
}
