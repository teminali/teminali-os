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
}
