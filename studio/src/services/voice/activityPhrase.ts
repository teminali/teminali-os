/**
 * What the Teminali OS assistant is doing, in words a person would use.
 *
 * The assistant works behind the scenes now — it has no chat surface of its
 * own, and the only trace of it is one small line in the composer's project
 * bar. That line is the entire window onto a process that might run for
 * minutes, so it has to carry the thing a person actually wants to know
 * ("reading `server.py`") and never the thing they don't (a tool name, a JSON
 * payload, a path six segments deep).
 *
 * Pure and free of React on purpose: the phrasing is the part worth testing,
 * and it is reused by the spoken narration, where "Reading server dot py" has
 * to come out of the same sentence the eye is reading.
 */

import type { AssistantActivityItem } from "../../store/assistantActivityStore";

export interface ActivityPhrase {
  /** The present-participle verb: "Reading", "Writing", "Running". */
  verb: string;
  /** What it is being done to, already shortened for a narrow line. */
  target: string;
  /**
   * The same thing unshortened, for a tooltip.
   *
   * The strip used to hang `title={target}` off the target span, which showed
   * the elided string back — a tooltip whose entire job is to recover what the
   * elision took. Absent when nothing was elided, so a caller can tell the two
   * cases apart rather than comparing strings.
   */
  full?: string;
  /** Which icon the ticker should show. */
  icon: "read" | "edit" | "run" | "test" | "think";
  /** Whether this is still happening, finished, or went wrong. */
  state: "running" | "done" | "failed";
}

/** The longest a target may be before the middle is elided. */
export const MAX_TARGET = 34;

/**
 * Keep the end of a path, which is the part that identifies it. A truncation
 * that kept the front would render every file in a deep tree identically.
 */
export function shortenTarget(value: string, max = MAX_TARGET): string {
  const text = (value || "").trim();
  if (text.length <= max) return text;
  const segments = text.split("/");
  if (segments.length > 1) {
    const tail = segments[segments.length - 1];
    if (tail.length <= max - 2) return `…/${tail}`;
    return `…${tail.slice(-(max - 1))}`;
  }
  return `${text.slice(0, max - 1)}…`;
}

/**
 * The first meaningful word of a command, so "npm run studio:test --silent"
 * reads as "npm run studio:test" rather than filling the line with flags.
 */
export function summariseCommand(cmd: string): string {
  const words = (cmd || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "a command";
  return shortenTarget(words.slice(0, 3).join(" "));
}

/**
 * What fits on the line, and what it stands for.
 *
 * `full` is left off when nothing was lost, so a tooltip that would repeat the
 * visible text simply does not appear.
 */
function elide(raw: string | null | undefined, shorten: (value: string) => string = shortenTarget) {
  const text = (raw || "").trim();
  const target = shorten(text);
  return !text || target === text ? { target } : { target, full: text };
}

const VERBS: Record<string, { running: string; done: string }> = {
  read: { running: "Reading", done: "Read" },
  edit: { running: "Writing", done: "Wrote" },
  cmd: { running: "Running", done: "Ran" },
  test: { running: "Testing", done: "Tested" },
};

/**
 * Turn one activity item into a line.
 *
 * `status` is trusted when present and assumed to be "running" when absent,
 * because an item with no status is one the assistant has only just started —
 * the store logs on entry, not on exit.
 */
export function describeActivity(item: AssistantActivityItem | null | undefined): ActivityPhrase | null {
  if (!item) return null;
  const state: ActivityPhrase["state"] =
    item.status === "failed" ? "failed" : item.status === "success" ? "done" : "running";

  // A delete reads as a delete whatever the item type says it is.
  if (item.badge === "delete") {
    return { verb: state === "running" ? "Deleting" : "Deleted", ...elide(item.file), icon: "edit", state };
  }
  if (item.badge === "create") {
    return { verb: state === "running" ? "Creating" : "Created", ...elide(item.file), icon: "edit", state };
  }

  const verbs = VERBS[item.type] || VERBS.cmd;
  const verb = state === "running" ? verbs.running : verbs.done;

  if (item.type === "cmd") {
    return { verb, ...elide(item.cmd || item.desc, summariseCommand), icon: "run", state };
  }
  if (item.type === "test") {
    return { verb, ...(item.desc ? elide(item.desc) : { target: "the suite" }), icon: "test", state };
  }
  return { verb, ...elide(item.file || item.desc), icon: item.type === "read" ? "read" : "edit", state };
}

/**
 * The line to show right now.
 *
 * A run with no activity yet is still a run — the assistant is thinking, and
 * saying so is better than an empty strip that looks like nothing is happening.
 * When no run is in flight there is deliberately nothing to say: the ticker is
 * a window onto work, not a permanent fixture.
 *
 * Newest first, whichever end the caller appends to. This used to reverse the
 * list and take the first match, which is only correct if items arrive
 * oldest-first — and `assistantActivityStore.logAction` *prepends*, so with two
 * steps in flight the strip named the older one and stayed there while the
 * assistant moved on. Sorting rather than trusting the caller's order is the
 * same defence `runProgressFromActivity` already takes, and it costs one pass
 * over at most fifty rows.
 */
export function currentActivityPhrase(
  items: readonly AssistantActivityItem[],
  isRunning: boolean,
  latestProgress?: string | null,
): ActivityPhrase | null {
  if (!isRunning) return null;
  const newestFirst = [...items].sort((a, b) => b.timestamp - a.timestamp);
  const running = newestFirst.find((item) => !item.status || item.status === "running");
  const phrase = describeActivity(running || newestFirst[0]);
  if (phrase && (running || phrase.state === "running")) return phrase;
  if (latestProgress) return { verb: "Working", ...elide(latestProgress), icon: "think", state: "running" };
  return { verb: "Thinking", target: "", icon: "think", state: "running" };
}

/** The same line as a sentence Temi can speak, when asked what is going on. */
export function speakActivityPhrase(phrase: ActivityPhrase | null): string {
  if (!phrase) return "Nothing is running right now.";
  if (!phrase.target) return `${phrase.verb} now.`;
  return `${phrase.verb} ${phrase.target}.`;
}
