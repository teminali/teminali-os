/**
 * "Open the last project", "the one from yesterday", "the last video project".
 *
 * The data behind all three phrasings already exists: `projects.js` keeps the
 * recents as `{ path, name, openedAt, kind }`, most-recent-first, with `kind`
 * re-read from the marker file on disk rather than trusted from the store. What
 * was missing was a way to turn a sentence into one of those entries.
 *
 * Rules, not a model call. A phrase like this has three axes at most — how far
 * back, what sort of project, and what it is called — and each of them is a
 * filter over a list of twelve. Asking a model would cost a round trip to be
 * less predictable than `openedAt` already is.
 *
 * Pure, and in its own module, so `tests/project-phrase.test.mjs` can drive it
 * without a gateway — the same reason `changeSet.ts` sits outside the store
 * that holds it.
 *
 * ## Two things this cannot know, and says so rather than guessing
 *
 * **The list is short.** `MAX_RECENT_PROJECTS` is 12, so a project worked on
 * last week may genuinely have fallen off the end. A miss is reported as "not
 * in the recents", never resolved to the nearest survivor.
 *
 * **`openedAt` is when a project was opened, not when it was worked on.** A
 * session that starts at 23:00 and runs past midnight is stamped the previous
 * day, so "yesterday" can name the work you did after midnight this morning.
 */

/** Words that mean "the kind of project", mapped to the `kind` they select. */
const KIND_WORDS = new Map([
  ["video", "video"], ["videos", "video"], ["edit", "video"], ["edits", "video"],
  ["movie", "video"], ["timeline", "video"], ["cut", "video"],
  ["code", "code"], ["coding", "code"], ["repo", "code"], ["repository", "code"],
]);

/** Words that mean "count back this many calendar days from today". */
const DAY_WORDS = new Map([
  ["today", 0], ["yesterday", 1],
]);

/** Words that mean "one further back than the newest". */
const SECOND_WORDS = new Set(["second", "2nd", "before"]);

/**
 * Noise. Every one of these is a way of saying "index 0", which is where the
 * search starts anyway, or scaffolding around the part that carries meaning.
 * Stripping them is what leaves a name behind when the phrase contains one.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "at", "back", "for", "from", "go", "i", "in", "last", "latest",
  "me", "most", "my", "on", "one", "open", "please", "previous", "project", "projects",
  "recent", "recently", "reopen", "switch", "that", "the", "to", "up", "was", "we", "were",
  "with", "work", "worked", "working", "yesterdays",
]);

function words(phrase) {
  return String(phrase ?? "")
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter(Boolean);
}

/** The calendar day `iso` fell on, as an offset in days back from `now`'s day. */
function daysBefore(iso, now) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const startOf = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((startOf(now) - startOf(then)) / 86_400_000);
}

/**
 * One recent project, or null with a reason the operator can act on.
 *
 * `recent` is the list exactly as `listRecentProjects` returns it —
 * most-recent-first. `currentPath` is dropped from the candidates because
 * "open the last project" is never a request for the one already open; a
 * phrase naming it by name gets told that, rather than a silent miss.
 */
export function resolveProjectPhrase(phrase, recent, { now = new Date(), currentPath = "" } = {}) {
  const entries = Array.isArray(recent) ? recent : [];
  if (entries.length === 0) {
    return { project: null, reason: "There are no recent projects to open." };
  }

  const spoken = words(phrase);
  const kind = spoken.map((word) => KIND_WORDS.get(word)).find(Boolean) ?? null;
  const dayBack = spoken.map((word) => DAY_WORDS.get(word)).find((value) => value !== undefined) ?? null;
  const wantsSecond = spoken.some((word) => SECOND_WORDS.has(word));
  const nameTokens = spoken.filter((word) =>
    !STOP_WORDS.has(word) && !KIND_WORDS.has(word) && !DAY_WORDS.has(word) && !SECOND_WORDS.has(word));

  const current = String(currentPath ?? "");
  const named = (entry) => nameTokens.some((token) =>
    entry.name?.toLowerCase().includes(token) || entry.path?.toLowerCase().endsWith(`/${token}`));

  /*
    The one already open is a candidate only when the phrase names it. Without
    this, "open the last project" resolves to the project on screen and the
    tool reports success having done nothing.
  */
  let candidates = entries.filter((entry) => entry.path !== current || (nameTokens.length > 0 && named(entry)));
  if (candidates.length === 0) {
    return { project: null, reason: "The only recent project is the one already open." };
  }

  if (kind) {
    candidates = candidates.filter((entry) => entry.kind === kind);
    if (candidates.length === 0) {
      return { project: null, reason: `No recent project is a ${kind} project. The list holds the last ${entries.length}.` };
    }
  }

  if (dayBack !== null) {
    candidates = candidates.filter((entry) => daysBefore(entry.openedAt, now) === dayBack);
    if (candidates.length === 0) {
      return {
        project: null,
        reason: dayBack === 0
          ? "No recent project was opened today."
          : "No recent project was opened yesterday — and a project can drop off the end of a twelve-entry list, so it may simply no longer be recorded.",
      };
    }
  }

  if (nameTokens.length > 0) {
    const byName = candidates.filter(named);
    // A name that matches nothing is not a reason to hand back an unrelated
    // project: the operator said a word, and it meant something to them.
    if (byName.length === 0 && !kind && dayBack === null) {
      return { project: null, reason: `Nothing in the recent projects is called "${nameTokens.join(" ")}".` };
    }
    if (byName.length > 0) candidates = byName;
  }

  const index = wantsSecond && candidates.length > 1 ? 1 : 0;
  return { project: candidates[index], reason: "" };
}
