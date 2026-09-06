/**
 * What the browser panel writes down, decided without touching anything.
 *
 * Pure and dependency-free, for the same reason `address.ts` is: these are the
 * two rules that decide what ends up in the operator's history and downloads —
 * lists the assistant reads back and acts on — and a rule that can only be
 * exercised by driving Electron is a rule nobody exercises. The subscriptions
 * in `services/browserHistory.ts` and `services/browserDownloads.ts` are the
 * wiring around them and hold no policy of their own.
 */

import type { ActiveDownload } from "../store/browserStore";
import type { HistoryEntry } from "../services/browserDataService";
import type { BrowserDownload, BrowserViewState } from "../services/browserView";

/** The gateway's cap, mirrored so a long session cannot grow the cache past it. */
const MAX_CACHED_HISTORY = 500;

/** A page worth remembering, or null. The same line main and the gateway draw. */
export function visitOf(state: BrowserViewState | null | undefined): { url: string; title: string } | null {
  if (!state || state.closed) return null;
  // The whole of private browsing, on this side: a page on the in-memory
  // session is never written down. Decided here rather than in the
  // subscription because it is a rule, and rules in this codebase are testable.
  if (state.private) return null;
  // An error page is not a page the operator visited.
  if (state.error) return null;
  if (typeof state.url !== "string" || !/^https?:\/\/\S+$/i.test(state.url)) return null;
  return { url: state.url, title: state.title ?? "" };
}

/**
 * How a view's last recorded visit is remembered.
 *
 * Both halves, because one navigation reports itself several times and the
 * title arrives last: keying on the address alone would record the page under
 * whatever it was called before it had a name — usually the URL.
 */
export function visitKey(visit: { url: string; title: string }): string {
  return `${visit.url}\n${visit.title}`;
}

/**
 * Put the row the gateway just wrote at the head of the cached list.
 *
 * The same fold `recordVisit` does on disk: a visit to the address already at
 * the head refreshes that row instead of adding another, so the start/stop/
 * title repeats of one navigation stay one entry. Kept in step with the gateway
 * deliberately — the alternative is re-reading the whole file after every
 * navigation.
 */
export function foldVisit(history: HistoryEntry[], visit: HistoryEntry): HistoryEntry[] {
  const rest = history[0]?.url === visit.url ? history.slice(1) : history;
  return [visit, ...rest].slice(0, MAX_CACHED_HISTORY);
}

/** One page in the recent list, with how many times it was reached. */
export interface RecentVisit {
  url: string;
  title: string;
  /** The most recent visit — the one the age is measured from. */
  visitedAt: string;
  /** How many rows folded into this one. 1 when it was visited once. */
  visits: number;
}

/**
 * The recent list, folded.
 *
 * The gateway folds only a *repeat at the head* — the start/stop/title storm of
 * one navigation — which is exactly the wrong shape for a page you go back to.
 * A session of watching four videos leaves the same sign-in page interleaved
 * between them, and the home page then showed six identical rows: the same
 * title, the same host, six ages, and nothing distinguishing them. That is a
 * list nobody reads, and it pushed the pages the operator actually wanted off
 * the bottom.
 *
 * So the display folds by address and keeps the newest, with the count beside
 * it. The stored history is untouched — this is a view of it, and the assistant
 * still reads every row.
 */
export function foldRecent(history: HistoryEntry[], limit: number): RecentVisit[] {
  const byUrl = new Map<string, RecentVisit>();
  for (const entry of history) {
    const seen = byUrl.get(entry.url);
    if (!seen) {
      byUrl.set(entry.url, { url: entry.url, title: entry.title, visitedAt: entry.visitedAt, visits: 1 });
      continue;
    }
    seen.visits += 1;
    // The list arrives newest-first, but a stored file is not a promise: keep
    // the later stamp and the title that came with it either way.
    if (entry.visitedAt > seen.visitedAt) {
      seen.visitedAt = entry.visitedAt;
      seen.title = entry.title;
    }
  }
  return [...byUrl.values()]
    .sort((a, b) => (a.visitedAt < b.visitedAt ? 1 : a.visitedAt > b.visitedAt ? -1 : 0))
    .slice(0, limit);
}

/**
 * Which heading a visit belongs under: Today, Yesterday, or Earlier.
 *
 * Three buckets, not a date per row. A list of twelve pages from one afternoon
 * does not need twelve dates, and "26m" already answers "how long ago" for the
 * only rows where the answer is interesting.
 */
export function visitDay(iso: string, now: number = Date.now()): "Today" | "Yesterday" | "Earlier" {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "Earlier";
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (then >= midnight.getTime()) return "Today";
  if (then >= midnight.getTime() - 86_400_000) return "Yesterday";
  return "Earlier";
}

/** A file that has ended, in the shape the gateway stores. */
export interface DownloadRecord {
  url: string;
  filename: string;
  path: string;
  bytes: number;
  state: "completed" | "interrupted";
}

export type DownloadAction =
  /** Still arriving: it belongs in the cache of downloads in flight, not on disk. */
  | { kind: "active"; id: string; download: ActiveDownload }
  /** It ended with an outcome worth keeping. */
  | { kind: "record"; id: string; entry: DownloadRecord }
  /** It ended with nothing worth keeping — take it off the in-flight list. */
  | { kind: "drop"; id: string };

/**
 * What one download event means.
 *
 * `done` rather than the state word, because an `interrupted` mid-flight can
 * still resume and only the final one is an outcome. `cancelled` is dropped
 * rather than recorded: it is what dismissing Electron's own save dialog
 * reports, and a row for a file the operator declined is noise on their home
 * page that they never asked for and cannot explain.
 *
 * A private download ends the same way a cancelled one does — dropped, not
 * recorded. The file is on disk, because the operator chose where to put it;
 * the *list* of what was fetched is the thing a private tab promises not to
 * keep, and that list is what this writes.
 */
export function downloadAction(download: BrowserDownload | null | undefined): DownloadAction | null {
  if (!download?.downloadId) return null;
  const id = download.downloadId;
  if (!download.done) {
    return {
      kind: "active",
      id,
      download: {
        filename: download.filename,
        received: download.received,
        total: download.total,
        state: download.state === "paused" ? "paused" : "progressing",
      },
    };
  }
  if (download.private) return { kind: "drop", id };
  if (download.state !== "completed" && download.state !== "interrupted") return { kind: "drop", id };
  return {
    kind: "record",
    id,
    entry: {
      url: download.url,
      filename: download.filename,
      path: download.path,
      bytes: download.received,
      state: download.state,
    },
  };
}
