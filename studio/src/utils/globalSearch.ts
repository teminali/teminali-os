/**
 * What "search" means when it is asked to cover the whole application.
 *
 * The sidebar's search was a grep with a name that overpromised: it said
 * "Search across all" and answered only with lines inside text files. Every
 * other thing an operator looks for by typing its name — a chat they had, a
 * page they kept, a file by its filename, a panel, a skill, a project — was
 * unreachable from the one box in the app that is *called* search.
 *
 * This file is the part of that which is a rule rather than a screen: how a
 * typed fragment scores against a candidate, and therefore what comes first.
 * It is pure and dependency-free so the ordering can be exercised without
 * standing up a workspace, a gateway and a browser store — the ordering being
 * the whole of the experience, since a list where the obvious answer is
 * eleventh is a list that failed.
 *
 * Deliberately **not** fuzzy in the subsequence sense. `gls` matching
 * `GlobalSearchView` reads as clever until it also matches forty other things
 * and buries the file actually called `gls.ts`. Four tiers — equal, prefix,
 * word start, contains — are what a person can predict, and predictability is
 * what makes a search box worth typing into twice.
 */

import type React from "react";

/** Every kind of thing the search can return, in the order sections are drawn. */
export type ResultKind =
  | "panel"
  | "skill"
  | "project"
  | "file"
  | "machine"
  | "code"
  | "chat"
  | "bookmark"
  | "history"
  | "download"
  | "web";

export interface SearchHit {
  id: string;
  kind: ResultKind;
  /** What the row is called. */
  title: string;
  /** The line under or beside it: a path, a host, a snippet. */
  detail: string;
  /** What opening it does. Held here so ranking and rendering stay one list. */
  open: () => void;
  /**
   * A mark of its own, where the kind's icon is not specific enough.
   *
   * A panel row wears the panel's own glyph — the same one its tab wears —
   * because "Browser" and "Benchmark" are told apart by their marks long
   * before their labels are read.
   */
  glyph?: React.ReactNode;
  score: number;
}

/**
 * How well `text` answers `query`. Zero means it does not.
 *
 * The tiers are worth more than the near misses inside them, so a prefix match
 * always beats a mid-word one however much shorter the other candidate is. The
 * length term only settles ties: between two things that both start with what
 * was typed, the shorter one is the more complete answer.
 */
export function scoreText(query: string, text: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const hay = text.toLowerCase();
  const at = hay.indexOf(needle);
  if (at === -1) return 0;

  const tier =
    hay === needle ? 1000
    : at === 0 ? 800
    // A word start: after a space, a slash, a dash, a dot or an underscore.
    : /[\s/\-_.]/.test(hay[at - 1]) ? 600
    : 400;
  // At most 99, so it can never lift a candidate into the tier above.
  return tier + Math.max(0, 99 - Math.min(99, hay.length));
}

/**
 * The best score across several fields — a title and a path, say.
 *
 * Best rather than sum: a query that matches the title exactly and the path
 * incidentally is a title match, and adding the two would let a long path full
 * of coincidences outrank the thing the operator named.
 */
export function scoreFields(query: string, ...fields: (string | null | undefined)[]): number {
  let best = 0;
  for (const field of fields) {
    if (!field) continue;
    const score = scoreText(query, field);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Highest first, and stable within a score.
 *
 * Stability matters more than it looks: the sections are built in a fixed
 * order, so two equally good answers keep the order their sources were asked
 * in rather than swapping places as the query is typed.
 */
export function rankHits(hits: SearchHit[], limit: number): SearchHit[] {
  return hits
    .filter((hit) => hit.score > 0)
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => (b.hit.score - a.hit.score) || (a.index - b.index))
    .slice(0, limit)
    .map((entry) => entry.hit);
}

/** Which scopes a kind belongs to, so one tab can cover several sources. */
export const SCOPES = {
  all: null,
  files: new Set<ResultKind>(["file", "machine", "code"]),
  chats: new Set<ResultKind>(["chat"]),
  web: new Set<ResultKind>(["bookmark", "history", "download", "web"]),
  actions: new Set<ResultKind>(["panel", "skill", "project"]),
} as const;

export type SearchScope = keyof typeof SCOPES;

export function inScope(kind: ResultKind, scope: SearchScope): boolean {
  const kinds = SCOPES[scope];
  return kinds === null || kinds.has(kind);
}

/** The section a kind is drawn under, and the order sections appear in. */
export const SECTIONS: readonly { kind: ResultKind; label: string }[] = [
  { kind: "panel", label: "Panels" },
  { kind: "skill", label: "Skills" },
  { kind: "project", label: "Projects" },
  { kind: "file", label: "Files" },
  { kind: "machine", label: "On this machine" },
  { kind: "code", label: "In files" },
  { kind: "chat", label: "Chats" },
  { kind: "bookmark", label: "Bookmarks" },
  { kind: "history", label: "History" },
  { kind: "download", label: "Downloads" },
  { kind: "web", label: "Search the web" },
];

/**
 * Cut the ranked list into the sections that have anything in them.
 *
 * A section with no hits is not drawn at all rather than drawn empty: a
 * heading over nothing teaches that the search looked somewhere and found
 * nothing, when in fact it is the one place it did not need to look.
 */
export function sectionsOf(hits: SearchHit[], perSection: number): { label: string; kind: ResultKind; hits: SearchHit[] }[] {
  return SECTIONS.map((section) => ({
    ...section,
    hits: hits.filter((hit) => hit.kind === section.kind).slice(0, perSection),
  })).filter((section) => section.hits.length > 0);
}
