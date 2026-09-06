/**
 * Bringing bookmarks and history over from the browser the operator used before.
 *
 * The panel starts empty, which is the honest state of a new browser and also
 * the reason nobody uses one twice. This reads the lists another browser
 * already keeps on this machine and merges them into `browser-data.js`, so the
 * home page has the operator's own shortcuts on it the first time they open it.
 *
 * Two formats, because on a Mac that is all there are:
 *
 * - **Chromium** (Chrome, Brave, Edge, Chromium, Vivaldi, Arc, Opera) keeps
 *   bookmarks as plain JSON in `<profile>/Bookmarks` and history as SQLite in
 *   `<profile>/History`. The JSON half needs no database at all.
 * - **Firefox** keeps both in one SQLite file, `places.sqlite`.
 *
 * SQLite is read with `node:sqlite`, which Electron 44 bundles (Node 24.19.0 —
 * measured in the Electron runtime, not assumed). No native module, no new
 * dependency.
 *
 * ## What it will not do
 *
 * - **It never opens the live file.** Chrome and Edge are usually running and a
 *   browser holds its own database open. The file is copied to a scratch
 *   directory first — with its `-wal` sidecar, so pages written but not yet
 *   checkpointed come too — and the copy is what is opened, read-only, then
 *   deleted. This also means an import can never write a byte into another
 *   browser's profile.
 * - **It converts time inside SQL, never in JavaScript.** Chromium stores a
 *   visit as microseconds since 1601, a number like 13432985205915271 — larger
 *   than `Number.MAX_SAFE_INTEGER`, so `node:sqlite` throws `ERR_OUT_OF_RANGE`
 *   the moment such a column is read into a JS number. Every query below
 *   divides it down to seconds before it crosses that boundary.
 * - **It discovers by evidence, not by a list of vendors.** A browser counts as
 *   present only when a profile directory actually holds a `Bookmarks` or a
 *   `History` file. Four vendors have an Application Support folder on this
 *   machine containing nothing but `NativeMessagingHosts`, left behind by
 *   extensions; none of them is a browser anyone could import from.
 * - **It does not do Safari, and it says why.** `~/Library/Safari/History.db`
 *   is protected by TCC: reading it answers `unable to open database file`
 *   however correct the SQL is, until the app has Full Disk Access. Safari is
 *   therefore listed as an unavailable source carrying its reason — the same
 *   shape as `machine-search.js` answering `available: false` off macOS —
 *   rather than being offered and then failing.
 * - **It does not do autofill.** This browser has no autofill store to import
 *   into. Reading saved addresses and card details out of another browser to
 *   drop them into a void would be the worst of both: sensitive data moved for
 *   no benefit at all. The absence is reported so the UI can say so plainly.
 * - **It is bounded.** At most `IMPORT_LIMIT` rows of each kind are read,
 *   because that is what `browser-data.js` can hold; Edge's history on this
 *   machine is 40MB and nothing in the app would ever read the rest.
 */

import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * At most this many bookmarks and this many visits come across.
 *
 * The same number as `MAX_BOOKMARKS`/`MAX_HISTORY` in `browser-data.js`: rows
 * beyond the store's cap would be sanitised away on the very next write, so
 * reading them is work with nowhere to land.
 */
export const IMPORT_LIMIT = 500;

/** Seconds between 1601-01-01 and the Unix epoch — the Chromium offset. */
export const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;

/**
 * The Chromium family, by the directory each keeps its profiles in, relative
 * to `~/Library/Application Support`.
 *
 * Being on this list makes a browser *checkable*, not *present*: discovery
 * still requires a profile with real files in it.
 */
export const CHROMIUM_BROWSERS = Object.freeze([
  { id: "chrome", label: "Google Chrome", dir: "Google/Chrome" },
  { id: "brave", label: "Brave", dir: "BraveSoftware/Brave-Browser" },
  { id: "edge", label: "Microsoft Edge", dir: "Microsoft Edge" },
  { id: "chromium", label: "Chromium", dir: "Chromium" },
  { id: "vivaldi", label: "Vivaldi", dir: "Vivaldi" },
  { id: "arc", label: "Arc", dir: "Arc/User Data" },
  { id: "opera", label: "Opera", dir: "com.operasoftware.Opera" },
]);

/** Where Firefox keeps its profiles, relative to `~/Library/Application Support`. */
export const FIREFOX_DIR = "Firefox/Profiles";

/** Why Safari cannot be read, in words the operator can act on. */
export const SAFARI_REASON =
  "Safari's history is protected by macOS. Grant Teminali OS Full Disk Access in System Settings › Privacy & Security to import it.";

/** Why autofill is not offered, in words that are actually true. */
export const AUTOFILL_REASON =
  "Teminali OS has no autofill store yet, so there is nowhere for saved addresses or cards to go.";

/** A title is display text: one line, no control characters, bounded. */
function cleanTitle(value) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The same line the panel draws, and the same one `browser-data.js` re-checks. */
function isImportableUrl(url) {
  return typeof url === "string" && url.length <= 2048 && /^https?:\/\/\S+$/i.test(url);
}

/** Unix seconds to the ISO string the store keeps, or now when the row had no usable time. */
export function secondsToIso(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date().toISOString();
  const ms = seconds * 1000;
  // A row a day into the future is a corrupt row, not a prophecy.
  if (ms > Date.now() + 86_400_000) return new Date().toISOString();
  return new Date(ms).toISOString();
}

/**
 * Chromium's `date_added` arrives as a *string* of microseconds since 1601 —
 * a string precisely because the number does not survive a double. It is
 * divided as a BigInt and only then narrowed.
 */
export function chromiumStampToIso(value) {
  try {
    const micro = BigInt(typeof value === "string" || typeof value === "number" ? value : 0);
    if (micro <= 0n) return new Date().toISOString();
    return secondsToIso(Number(micro / 1_000_000n) - CHROMIUM_EPOCH_OFFSET_SECONDS);
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Walks a Chromium `Bookmarks` file into a flat, newest-first list.
 *
 * The file is a tree of three roots (`bookmark_bar`, `other`, `synced`) whose
 * nodes are either a `url` or a `folder` with `children`. Folders are walked
 * for their contents and the folder structure itself is dropped, because this
 * browser's bookmarks are one flat list: importing a shape nothing renders
 * would be importing a promise the panel cannot keep.
 */
export function flattenChromiumBookmarks(raw, limit = IMPORT_LIMIT) {
  const roots = raw && typeof raw === "object" && raw.roots && typeof raw.roots === "object" ? raw.roots : {};
  const found = [];
  const seen = new Set();

  const walk = (node, depth) => {
    // A profile with a cycle, or absurd nesting, is one we stop reading — not
    // one we recurse into until the stack goes.
    if (!node || typeof node !== "object" || depth > 32) return;
    if (node.type === "url" || (typeof node.url === "string" && !Array.isArray(node.children))) {
      if (!isImportableUrl(node.url) || seen.has(node.url)) return;
      seen.add(node.url);
      found.push({
        url: node.url,
        title: cleanTitle(node.name) || node.url,
        addedAt: chromiumStampToIso(node.date_added),
      });
      return;
    }
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child, depth + 1);
  };

  for (const key of ["bookmark_bar", "other", "synced"]) walk(roots[key], 0);
  // Newest first, so that a cap keeps what the operator kept most recently.
  found.sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0));
  return found.slice(0, limit);
}

/**
 * Opens a *copy* of a SQLite file and answers one query against it.
 *
 * The copy is the whole point: the source browser is usually running and holds
 * its database open, and an import must never be able to write into another
 * browser's profile. `-wal` and `-shm` come along when they exist.
 */
async function withSqliteCopy(sourcePath, read, deps = {}) {
  const {
    copyFileImpl = copyFile,
    mkdtempImpl = mkdtemp,
    rmImpl = rm,
    statImpl = stat,
    openImpl = (path) => new DatabaseSync(path, { readOnly: true }),
  } = deps;

  let scratch;
  try {
    scratch = await mkdtempImpl(join(tmpdir(), "teminali-import-"));
  } catch {
    return [];
  }
  const copyPath = join(scratch, "source.db");
  try {
    await copyFileImpl(sourcePath, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        await statImpl(`${sourcePath}${suffix}`);
        await copyFileImpl(`${sourcePath}${suffix}`, `${copyPath}${suffix}`);
      } catch {
        // No sidecar. The main file alone is a complete database.
      }
    }
    const database = openImpl(copyPath);
    try {
      return read(database) ?? [];
    } finally {
      try {
        database.close();
      } catch {
        /* Already closed. */
      }
    }
  } catch {
    // A profile that cannot be read reports nothing; it is not a failed import,
    // because the other source in the same run may well have worked.
    return [];
  } finally {
    try {
      await rmImpl(scratch, { recursive: true, force: true });
    } catch {
      /* The scratch directory outlives us; the OS will take it. */
    }
  }
}

/** Rows from any of the history queries, deduplicated by address, newest first. */
function normaliseVisits(rows) {
  const visits = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isImportableUrl(row?.url) || seen.has(row.url)) continue;
    seen.add(row.url);
    visits.push({
      url: row.url,
      title: cleanTitle(row.title) || row.url,
      visitedAt: secondsToIso(Number(row.visited)),
    });
  }
  return visits;
}

/** Chromium history: `urls`, newest visit first, the epoch narrowed inside SQL. */
export async function readChromiumHistory(historyPath, deps = {}, limit = IMPORT_LIMIT) {
  const rows = await withSqliteCopy(
    historyPath,
    (database) =>
      database
        .prepare(
          `select url, title, last_visit_time / 1000000 - ${CHROMIUM_EPOCH_OFFSET_SECONDS} as visited
           from urls where last_visit_time > 0 order by last_visit_time desc limit ?`,
        )
        .all(limit),
    deps,
  );
  return normaliseVisits(rows);
}

/** Firefox history: `moz_places`, whose time is already microseconds since the Unix epoch. */
export async function readFirefoxHistory(placesPath, deps = {}, limit = IMPORT_LIMIT) {
  const rows = await withSqliteCopy(
    placesPath,
    (database) =>
      database
        .prepare(
          `select url, title, last_visit_date / 1000000 as visited
           from moz_places where last_visit_date is not null and last_visit_date > 0
           order by last_visit_date desc limit ?`,
        )
        .all(limit),
    deps,
  );
  return normaliseVisits(rows);
}

/** Firefox bookmarks: `moz_bookmarks` joined to the place it points at. Type 1 is a bookmark. */
export async function readFirefoxBookmarks(placesPath, deps = {}, limit = IMPORT_LIMIT) {
  const rows = await withSqliteCopy(
    placesPath,
    (database) =>
      database
        .prepare(
          `select p.url as url, b.title as title, b.dateAdded / 1000000 as added
           from moz_bookmarks b join moz_places p on p.id = b.fk
           where b.type = 1 order by b.dateAdded desc limit ?`,
        )
        .all(limit),
    deps,
  );
  const bookmarks = [];
  const seen = new Set();
  for (const row of rows) {
    if (!isImportableUrl(row?.url) || seen.has(row.url)) continue;
    seen.add(row.url);
    bookmarks.push({
      url: row.url,
      title: cleanTitle(row.title) || row.url,
      addedAt: secondsToIso(Number(row.added)),
    });
  }
  return bookmarks;
}

/**
 * The display name a Chromium browser gives a profile directory.
 *
 * `Local State` holds `profile.info_cache["Profile 1"].name`, which is what the
 * operator sees in that browser's own profile menu — "Work" reads better than
 * "Profile 1". Its absence is not a problem; the directory name is a perfectly
 * good label.
 */
async function chromiumProfileNames(userDataDir, readFileImpl) {
  try {
    const state = JSON.parse(await readFileImpl(join(userDataDir, "Local State"), "utf8"));
    const cache = state?.profile?.info_cache;
    if (!cache || typeof cache !== "object") return {};
    const names = {};
    for (const [directory, info] of Object.entries(cache)) {
      const name = cleanTitle(info?.name);
      if (name) names[directory] = name;
    }
    return names;
  } catch {
    return {};
  }
}

async function exists(statImpl, path) {
  try {
    await statImpl(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * What can actually be imported from, on this machine, right now.
 *
 * Every path is proved with a `stat` before it is offered. A source with no
 * readable profile is left out entirely rather than listed and then failing.
 * Safari is the single exception — listed unavailable, carrying its reason,
 * because "why isn't Safari here?" is a question the operator would otherwise
 * have to come and ask us.
 */
export async function discoverImportSources(options = {}) {
  const {
    home = homedir(),
    platformName = platform(),
    statImpl = stat,
    readdirImpl = readdir,
    readFileImpl = readFile,
  } = options;

  const autofill = { supported: false, reason: AUTOFILL_REASON };

  if (platformName !== "darwin") {
    return {
      available: false,
      reason: "Importing from another browser is only supported on macOS so far.",
      sources: [],
      autofill,
    };
  }

  const support = join(home, "Library", "Application Support");
  const sources = [];

  for (const browser of CHROMIUM_BROWSERS) {
    const userDataDir = join(support, browser.dir);
    let entries;
    try {
      entries = await readdirImpl(userDataDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = await chromiumProfileNames(userDataDir, readFileImpl);
    const profiles = [];
    for (const entry of entries) {
      if (!entry.isDirectory?.()) continue;
      const directory = entry.name;
      if (directory !== "Default" && !directory.startsWith("Profile ")) continue;
      const profilePath = join(userDataDir, directory);
      const bookmarks = await exists(statImpl, join(profilePath, "Bookmarks"));
      const history = await exists(statImpl, join(profilePath, "History"));
      // Evidence, not vendor list: a directory with neither file is not a profile.
      if (!bookmarks && !history) continue;
      profiles.push({ id: directory, label: names[directory] || directory, bookmarks, history });
    }
    if (profiles.length > 0) {
      sources.push({ id: browser.id, label: browser.label, family: "chromium", available: true, reason: null, profiles });
    }
  }

  const firefoxRoot = join(support, FIREFOX_DIR);
  const firefoxProfiles = [];
  try {
    for (const entry of await readdirImpl(firefoxRoot, { withFileTypes: true })) {
      if (!entry.isDirectory?.()) continue;
      if (!(await exists(statImpl, join(firefoxRoot, entry.name, "places.sqlite")))) continue;
      // Firefox names a directory `xxxxxxxx.default-release`; the half after
      // the dot is the part the operator chose.
      const label = entry.name.includes(".") ? entry.name.slice(entry.name.indexOf(".") + 1) : entry.name;
      firefoxProfiles.push({ id: entry.name, label, bookmarks: true, history: true });
    }
  } catch {
    // No Firefox on this machine.
  }
  if (firefoxProfiles.length > 0) {
    sources.push({ id: "firefox", label: "Firefox", family: "firefox", available: true, reason: null, profiles: firefoxProfiles });
  }

  if (await exists(statImpl, join(home, "Library", "Safari", "History.db"))) {
    sources.push({ id: "safari", label: "Safari", family: "safari", available: false, reason: SAFARI_REASON, profiles: [] });
  }

  return { available: true, reason: null, sources, autofill };
}

/** An import that cannot proceed, carrying the code the route turns into a status. */
export class BrowserImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BrowserImportError";
    this.code = code;
  }
}

/**
 * A profile id is one directory name and nothing else.
 *
 * The renderer chooses which profile to read, so this is the boundary that
 * stops a chosen name from reaching out of the browser's own user-data
 * directory: no separator, no `..`, nothing but the characters a profile
 * directory is actually made of.
 */
export function isSafeProfileId(profileId) {
  return typeof profileId === "string" && /^[\w .-]{1,64}$/.test(profileId) && !profileId.includes("..");
}

/**
 * Reads one profile's lists.
 *
 * `kinds` is what the operator ticked. Asking for neither is not an error; it
 * is an import of nothing, and returning empty lists keeps the caller's shape
 * identical to every other outcome.
 */
export async function readImport(sourceId, profileId, options = {}) {
  const {
    home = homedir(),
    kinds = { bookmarks: true, history: true },
    limit = IMPORT_LIMIT,
    readFileImpl = readFile,
    ...sqliteDeps
  } = options;

  if (sourceId === "safari") throw new BrowserImportError("BROWSER_IMPORT_UNAVAILABLE", SAFARI_REASON);
  if (!isSafeProfileId(profileId)) {
    throw new BrowserImportError("BROWSER_IMPORT_PROFILE_INVALID", "That profile name is not one this can read.");
  }

  const support = join(home, "Library", "Application Support");

  if (sourceId === "firefox") {
    const places = join(support, FIREFOX_DIR, profileId, "places.sqlite");
    return {
      bookmarks: kinds.bookmarks ? await readFirefoxBookmarks(places, sqliteDeps, limit) : [],
      history: kinds.history ? await readFirefoxHistory(places, sqliteDeps, limit) : [],
    };
  }

  const browser = CHROMIUM_BROWSERS.find((candidate) => candidate.id === sourceId);
  if (!browser) {
    throw new BrowserImportError("BROWSER_IMPORT_SOURCE_UNKNOWN", "That browser is not one this can import from.");
  }

  const profilePath = join(support, browser.dir, profileId);
  const result = { bookmarks: [], history: [] };

  if (kinds.bookmarks) {
    try {
      result.bookmarks = flattenChromiumBookmarks(JSON.parse(await readFileImpl(join(profilePath, "Bookmarks"), "utf8")), limit);
    } catch {
      // A profile that never kept a bookmark has no file. Nothing found is the
      // honest answer, and the history half of the same run may still succeed.
    }
  }
  if (kinds.history) {
    result.history = await readChromiumHistory(join(profilePath, "History"), sqliteDeps, limit);
  }
  return result;
}
