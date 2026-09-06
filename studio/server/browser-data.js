import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * What the browser panel remembers: bookmarks, history and downloads.
 *
 * One JSON file in the gateway rather than a store in the renderer, and the
 * reason is the agent. "Our AI assistant access to all that" is in the same
 * sentence as the features, and a renderer-only store is one the agent
 * routes cannot read — the gateway is the only process both the panel and an
 * agent CLI's shim can reach. Same shape as `projects.js`: read the whole
 * file, sanitise every entry, write it back atomically.
 *
 * Nothing here talks to Electron. Where a download was saved is decided by
 * the operator in Electron's own save dialog and *reported* here afterwards;
 * this file records what came back and never chooses a path.
 */

export const MAX_BOOKMARKS = 500;
export const MAX_HISTORY = 500;
export const MAX_DOWNLOADS = 200;
const MAX_URL_CHARS = 2048;
const MAX_TITLE_CHARS = 200;
const MAX_FILENAME_CHARS = 255;
const MAX_PATH_CHARS = 4096;

export const DOWNLOAD_STATES = Object.freeze(["completed", "interrupted", "cancelled"]);

/** A page the panel could have shown. The same line main draws: http(s) and nothing else. */
export function isBrowsableUrl(url) {
  return typeof url === "string" && url.length <= MAX_URL_CHARS && /^https?:\/\/\S+$/i.test(url);
}

/** A title is display text: one line, no control characters, bounded. */
function cleanTitle(value) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
}

function cleanTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();
}

function cleanBookmark(entry) {
  if (!entry || !isBrowsableUrl(entry.url)) return null;
  return { url: entry.url, title: cleanTitle(entry.title) || entry.url, addedAt: cleanTimestamp(entry.addedAt) };
}

function cleanVisit(entry) {
  if (!entry || !isBrowsableUrl(entry.url)) return null;
  return { url: entry.url, title: cleanTitle(entry.title) || entry.url, visitedAt: cleanTimestamp(entry.visitedAt) };
}

function cleanDownload(entry) {
  if (!entry || !isBrowsableUrl(entry.url)) return null;
  const filename = cleanTitle(entry.filename).slice(0, MAX_FILENAME_CHARS);
  if (!filename) return null;
  const state = DOWNLOAD_STATES.includes(entry.state) ? entry.state : "interrupted";
  const path = state === "completed" && typeof entry.path === "string" && entry.path && !entry.path.includes("\0")
    ? entry.path.slice(0, MAX_PATH_CHARS)
    : "";
  const bytes = Number.isFinite(entry.bytes) && entry.bytes >= 0 ? Math.floor(entry.bytes) : 0;
  return { url: entry.url, filename, path, bytes, state, savedAt: cleanTimestamp(entry.savedAt) };
}

/** The file as the routes may trust it. Every entry is rebuilt; nothing unknown survives. */
export function sanitizeBrowserData(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const bookmarks = [];
  const seenBookmark = new Set();
  for (const entry of Array.isArray(source.bookmarks) ? source.bookmarks : []) {
    const clean = cleanBookmark(entry);
    if (!clean || seenBookmark.has(clean.url)) continue;
    seenBookmark.add(clean.url);
    bookmarks.push(clean);
    if (bookmarks.length >= MAX_BOOKMARKS) break;
  }
  const history = [];
  for (const entry of Array.isArray(source.history) ? source.history : []) {
    const clean = cleanVisit(entry);
    if (!clean) continue;
    history.push(clean);
    if (history.length >= MAX_HISTORY) break;
  }
  const downloads = [];
  for (const entry of Array.isArray(source.downloads) ? source.downloads : []) {
    const clean = cleanDownload(entry);
    if (!clean) continue;
    downloads.push(clean);
    if (downloads.length >= MAX_DOWNLOADS) break;
  }
  return { bookmarks, history, downloads };
}

async function readStore(storePath) {
  try {
    return sanitizeBrowserData(JSON.parse(await readFile(storePath, "utf8")));
  } catch {
    return { bookmarks: [], history: [], downloads: [] };
  }
}

async function writeStore(storePath, data) {
  await mkdir(dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, storePath);
  return data;
}

export async function readBrowserData(storePath) {
  return readStore(storePath);
}

/** Adds, or re-titles, a bookmark. Newest first; the same address is one bookmark. */
export async function addBookmark(storePath, { url, title }) {
  if (!isBrowsableUrl(url)) throw new Error("BROWSER_URL_INVALID");
  const data = await readStore(storePath);
  const entry = { url, title: cleanTitle(title) || url, addedAt: new Date().toISOString() };
  const existing = data.bookmarks.find((bookmark) => bookmark.url === url);
  // A bookmark's age is when it was first kept, not when it was last renamed.
  if (existing) entry.addedAt = existing.addedAt;
  data.bookmarks = [entry, ...data.bookmarks.filter((bookmark) => bookmark.url !== url)].slice(0, MAX_BOOKMARKS);
  await writeStore(storePath, data);
  return data.bookmarks;
}

export async function removeBookmark(storePath, url) {
  const data = await readStore(storePath);
  data.bookmarks = data.bookmarks.filter((bookmark) => bookmark.url !== url);
  await writeStore(storePath, data);
  return data.bookmarks;
}

/**
 * Records a page the panel showed.
 *
 * A navigation reports itself several times — start, stop, then the title
 * once the page has one — so a visit to the address already at the head of
 * the list refreshes that row rather than adding another. Newest first,
 * capped: history is what the operator was doing lately, not an archive.
 */
export async function recordVisit(storePath, { url, title }) {
  if (!isBrowsableUrl(url)) throw new Error("BROWSER_URL_INVALID");
  const data = await readStore(storePath);
  const now = new Date().toISOString();
  const head = data.history[0];
  if (head && head.url === url) {
    head.title = cleanTitle(title) || head.title || url;
    head.visitedAt = now;
  } else {
    data.history.unshift({ url, title: cleanTitle(title) || url, visitedAt: now });
    data.history = data.history.slice(0, MAX_HISTORY);
  }
  await writeStore(storePath, data);
  return data.history[0];
}

export async function clearHistory(storePath) {
  const data = await readStore(storePath);
  data.history = [];
  await writeStore(storePath, data);
  return data.history;
}

/**
 * Records a download that has finished, however it finished.
 *
 * Only the end of a download reaches the gateway. Progress is an IPC event
 * between main and the renderer — `item.on("updated")` fires constantly and a
 * store rewritten on each tick would be a store rewritten a hundred times per
 * file. The path is kept only for a completed file; a cancelled or
 * interrupted one has no file worth pointing at.
 */
export async function recordDownload(storePath, download) {
  const entry = cleanDownload({ ...download, savedAt: new Date().toISOString() });
  if (!entry) throw new Error("BROWSER_DOWNLOAD_INVALID");
  const data = await readStore(storePath);
  data.downloads = [entry, ...data.downloads].slice(0, MAX_DOWNLOADS);
  await writeStore(storePath, data);
  return data.downloads;
}

/**
 * The history the agent asked for: newest first, optionally narrowed to rows
 * whose address or title contains `query`, case-insensitively.
 */
export function searchHistory(history, query, limit = 50) {
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_HISTORY) : 50;
  const rows = needle
    ? history.filter((entry) => entry.url.toLowerCase().includes(needle) || entry.title.toLowerCase().includes(needle))
    : history;
  return rows.slice(0, cap);
}
