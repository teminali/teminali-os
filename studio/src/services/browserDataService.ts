import { GatewayClient } from "./gatewayClient";

/**
 * What the browser panel remembers, read from and written to the gateway.
 *
 * The gateway owns the file (server/browser-data.js) because an agent CLI's
 * shim can reach the gateway and cannot reach this renderer: a store kept
 * here would be one the assistant could not read. The panel and its global
 * subscribers write one row at a time and read the whole thing back.
 */

export interface Bookmark {
  url: string;
  title: string;
  addedAt: string;
}

export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: string;
}

export type DownloadState = "completed" | "interrupted" | "cancelled";

export interface DownloadEntry {
  url: string;
  filename: string;
  /** Where the operator saved it; empty unless `state` is `completed`. */
  path: string;
  bytes: number;
  state: DownloadState;
  savedAt: string;
}

export interface BrowserData {
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  downloads: DownloadEntry[];
}


/** One profile inside another browser, and which of its lists exist. */
export interface ImportProfile {
  id: string;
  label: string;
  bookmarks: boolean;
  history: boolean;
}

/**
 * A browser this machine could import from.
 *
 * `available: false` is a real answer, not an error: Safari is discovered and
 * listed with the reason it cannot be read, because leaving it out entirely
 * only makes the operator wonder where it went.
 */
export interface ImportSource {
  id: string;
  label: string;
  family: "chromium" | "firefox" | "safari";
  available: boolean;
  reason: string | null;
  profiles: ImportProfile[];
}

export interface ImportSources {
  available: boolean;
  reason: string | null;
  sources: ImportSource[];
  /** Always unsupported today, carrying the reason the UI shows. */
  autofill: { supported: boolean; reason: string };
}

/** What an import did: what was read, what was new, and the lists as they now stand. */
export interface ImportResult {
  bookmarks: { added: number; skipped: number; total: number };
  history: { added: number; total: number };
  read: { bookmarks: number; history: number };
  data: BrowserData;
}

export class BrowserDataService {
  static async read(signal?: AbortSignal): Promise<BrowserData> {
    const response = await GatewayClient.request("/api/workspace/browser", { method: "GET", signal });
    await GatewayClient.expectOk(response);
    return (await response.json()) as BrowserData;
  }

  static async bookmark(url: string, title: string): Promise<Bookmark[]> {
    const response = await GatewayClient.request("/api/workspace/browser/bookmark", {
      method: "POST",
      body: JSON.stringify({ url, title }),
    });
    await GatewayClient.expectOk(response);
    return ((await response.json()) as { bookmarks: Bookmark[] }).bookmarks;
  }

  static async unbookmark(url: string): Promise<Bookmark[]> {
    const response = await GatewayClient.request("/api/workspace/browser/unbookmark", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    await GatewayClient.expectOk(response);
    return ((await response.json()) as { bookmarks: Bookmark[] }).bookmarks;
  }

  /** One navigation. The gateway folds a repeat of the newest row into it. */
  static async visit(url: string, title: string): Promise<HistoryEntry> {
    const response = await GatewayClient.request("/api/workspace/browser/visit", {
      method: "POST",
      body: JSON.stringify({ url, title }),
    });
    await GatewayClient.expectOk(response);
    return ((await response.json()) as { visit: HistoryEntry }).visit;
  }

  static async clearHistory(): Promise<void> {
    const response = await GatewayClient.request("/api/workspace/browser/history/clear", { method: "POST" });
    await GatewayClient.expectOk(response);
  }

  /** A download that has ended. Progress never comes this way — it is IPC. */
  static async recordDownload(entry: Omit<DownloadEntry, "savedAt">): Promise<DownloadEntry[]> {
    const response = await GatewayClient.request("/api/workspace/browser/download", {
      method: "POST",
      body: JSON.stringify(entry),
    });
    await GatewayClient.expectOk(response);
    return ((await response.json()) as { downloads: DownloadEntry[] }).downloads;
  }
  /** What is on this machine to import from. Reads directory entries, nothing else. */
  static async importSources(signal?: AbortSignal): Promise<ImportSources> {
    const response = await GatewayClient.request("/api/workspace/browser/import/sources", { method: "GET", signal });
    await GatewayClient.expectOk(response);
    return (await response.json()) as ImportSources;
  }

  /**
   * Reads one profile and folds it into the store.
   *
   * The renderer names a source and a profile, never a path: turning those two
   * into a location on disk is the gateway's job alone (server/browser-import.js).
   */
  static async runImport(request: {
    source: string;
    profile: string;
    bookmarks: boolean;
    history: boolean;
  }): Promise<ImportResult> {
    const response = await GatewayClient.request("/api/workspace/browser/import", {
      method: "POST",
      body: JSON.stringify(request),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as ImportResult;
  }
}
