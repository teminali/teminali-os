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
