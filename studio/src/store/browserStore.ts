/**
 * One cache of what the browser remembers.
 *
 * The gateway owns the file (`server/browser-data.js`) because the agent has
 * to be able to read it, so this store is not a source of truth — it is the
 * renderer's copy of one, kept because a pane cannot await a fetch on every
 * render and because several panes read the same three lists at once. Every
 * mutation goes to the gateway first and adopts the list it answers with,
 * rather than editing here and hoping the write lands.
 *
 * Deliberately NOT persisted, and deliberately not in `panelStore`. Persisting
 * it would give a restart two disagreeing copies of the same bookmarks, and
 * the one on disk here would be the stale one.
 *
 * `active` is the exception: downloads in flight are IPC from main, not gateway
 * rows, and they exist only while the file is arriving. See
 * `services/browserDownloads.ts` for why progress never touches the store on
 * disk.
 */

import { create } from "zustand";
import { foldVisit } from "../utils/browserRecording";
import {
  BrowserDataService,
  type Bookmark,
  type DownloadEntry,
  type HistoryEntry,
} from "../services/browserDataService";

/** A download that has not finished, as main reports it. */
export interface ActiveDownload {
  filename: string;
  /** Bytes so far. */
  received: number;
  /** Total bytes, or 0 when the server did not say. */
  total: number;
  state: "progressing" | "paused";
}

interface BrowserState {
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  downloads: DownloadEntry[];
  /** Keyed by the download id main assigned. */
  active: Record<string, ActiveDownload>;
  /** Whether the first read has come back — an empty home before it is not "nothing kept". */
  loaded: boolean;

  load: () => Promise<void>;
  /** A page was shown. Written by the global subscriber, never by a pane. */
  visit: (url: string, title: string) => Promise<void>;
  bookmark: (url: string, title: string) => Promise<void>;
  unbookmark: (url: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  /** A download that has ended. Only ever called on `done`. */
  record: (entry: Omit<DownloadEntry, "savedAt">) => Promise<void>;
  /** A download is in flight, or has moved. */
  setActive: (id: string, download: ActiveDownload) => void;
  clearActive: (id: string) => void;
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  bookmarks: [],
  history: [],
  downloads: [],
  active: {},
  loaded: false,

  load: async () => {
    try {
      const data = await BrowserDataService.read();
      set({ bookmarks: data.bookmarks, history: data.history, downloads: data.downloads, loaded: true });
    } catch {
      // A gateway that is not up yet is not an error worth a banner in a home
      // page — the next navigation, star or download reloads it.
      set({ loaded: true });
    }
  },

  visit: async (url, title) => {
    try {
      const visit = await BrowserDataService.visit(url, title);
      set({ history: foldVisit(get().history, visit) });
    } catch {
      // A navigation must not fail because the gateway is restarting; the
      // next one, or the next `load`, brings the list back into agreement.
    }
  },

  bookmark: async (url, title) => {
    const bookmarks = await BrowserDataService.bookmark(url, title);
    set({ bookmarks });
  },

  unbookmark: async (url) => {
    const bookmarks = await BrowserDataService.unbookmark(url);
    set({ bookmarks });
  },

  clearHistory: async () => {
    await BrowserDataService.clearHistory();
    set({ history: [] });
  },

  record: async (entry) => {
    const downloads = await BrowserDataService.recordDownload(entry);
    set({ downloads });
  },

  setActive: (id, download) => set({ active: { ...get().active, [id]: download } }),

  clearActive: (id) => {
    const active = { ...get().active };
    delete active[id];
    set({ active });
  },
}));

/** Is this address kept? The star asks on every state event, so it stays cheap. */
export function isBookmarked(bookmarks: Bookmark[], url: string | null | undefined): boolean {
  return Boolean(url) && bookmarks.some((bookmark) => bookmark.url === url);
}
