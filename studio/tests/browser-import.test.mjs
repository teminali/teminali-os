import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTOFILL_REASON,
  CHROMIUM_EPOCH_OFFSET_SECONDS,
  chromiumStampToIso,
  discoverImportSources,
  flattenChromiumBookmarks,
  isSafeProfileId,
  readChromiumHistory,
  readFirefoxBookmarks,
  readFirefoxHistory,
  readImport,
  secondsToIso,
} from "../server/browser-import.js";

/**
 * Importing reads another application's files, so what is pinned here is
 * mostly what it must *not* do: never open the live database, never let a
 * profile name become a path, never let a 1601-epoch microsecond value reach a
 * JS number, and never claim a browser is importable without evidence on disk.
 *
 * The SQLite cases build real databases with the real schemas and read them
 * back through the real code path. A fake `openImpl` would have proved the
 * plumbing and not the SQL, and the SQL is where the bugs are.
 */

async function scratch() {
  return mkdtemp(join(tmpdir(), "import-test-"));
}

/* ── Time never crosses the boundary as a big number ──────────────────────── */

test("a Chromium timestamp larger than MAX_SAFE_INTEGER survives the conversion", () => {
  // The real value read off this machine's Chrome. As a Number it is already
  // past 2^53, which is why it is stored and converted as a BigInt.
  const raw = "13432985205915271";
  assert.ok(Number(raw) > Number.MAX_SAFE_INTEGER);
  const iso = chromiumStampToIso(raw);
  assert.equal(iso, "2026-09-04T08:46:45.000Z");
});

test("a missing, zero or nonsense stamp becomes now rather than 1601", () => {
  const floor = Date.now() - 5_000;
  for (const value of [undefined, null, 0, "0", "not a number", {}]) {
    assert.ok(Date.parse(chromiumStampToIso(value)) >= floor, `${String(value)} fell back wrongly`);
  }
});

test("a visit dated in the future is treated as corrupt, not as a prophecy", () => {
  const tomorrow = Math.floor(Date.now() / 1000) + 86_400 * 3;
  assert.ok(Date.parse(secondsToIso(tomorrow)) <= Date.now() + 1000);
});

/* ── The bookmark tree ────────────────────────────────────────────────────── */

const stamp = (iso) => String((BigInt(Date.parse(iso)) / 1000n + BigInt(CHROMIUM_EPOCH_OFFSET_SECONDS)) * 1_000_000n);

test("bookmarks come out of every root, flattened, newest first", () => {
  const raw = {
    roots: {
      bookmark_bar: {
        type: "folder",
        children: [
          { type: "url", name: "Old", url: "https://old.example", date_added: stamp("2020-01-01T00:00:00Z") },
          {
            type: "folder",
            name: "Nested",
            children: [{ type: "url", name: "New", url: "https://new.example", date_added: stamp("2024-01-01T00:00:00Z") }],
          },
        ],
      },
      other: { type: "folder", children: [{ type: "url", name: "Other", url: "https://other.example", date_added: stamp("2022-01-01T00:00:00Z") }] },
      synced: { type: "folder", children: [] },
    },
  };
  const found = flattenChromiumBookmarks(raw);
  assert.deepEqual(
    found.map((bookmark) => bookmark.title),
    ["New", "Other", "Old"],
  );
  // A folder is walked for its contents; the folder itself is not a bookmark.
  assert.ok(!found.some((bookmark) => bookmark.title === "Nested"));
});

test("the same address twice is one bookmark, and anything that is not http(s) is none", () => {
  const found = flattenChromiumBookmarks({
    roots: {
      bookmark_bar: {
        children: [
          { type: "url", name: "One", url: "https://same.example", date_added: stamp("2024-01-01T00:00:00Z") },
          { type: "url", name: "Two", url: "https://same.example", date_added: stamp("2023-01-01T00:00:00Z") },
          { type: "url", name: "Script", url: "javascript:alert(1)", date_added: stamp("2024-01-01T00:00:00Z") },
          { type: "url", name: "File", url: "file:///etc/passwd", date_added: stamp("2024-01-01T00:00:00Z") },
          { type: "url", name: "Chrome", url: "chrome://settings", date_added: stamp("2024-01-01T00:00:00Z") },
        ],
      },
    },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].url, "https://same.example");
});

test("a cyclic bookmark tree is stopped rather than followed until the stack goes", () => {
  const loop = { type: "folder", children: [] };
  loop.children.push(loop);
  loop.children.push({ type: "url", name: "Deep", url: "https://deep.example", date_added: stamp("2024-01-01T00:00:00Z") });
  // The depth guard is what makes this return at all.
  const found = flattenChromiumBookmarks({ roots: { bookmark_bar: loop } });
  assert.equal(found.length, 1);
});

test("a Bookmarks file that is not a bookmarks file is no bookmarks, not a throw", () => {
  for (const raw of [null, {}, [], { roots: "nope" }, { roots: {} }]) {
    assert.deepEqual(flattenChromiumBookmarks(raw), []);
  }
});

test("the cap is honoured, and it keeps the newest", () => {
  const children = Array.from({ length: 40 }, (_, index) => ({
    type: "url",
    name: `#${index}`,
    url: `https://example.com/${index}`,
    date_added: stamp(`20${20 + Math.floor(index / 12)}-0${(index % 9) + 1}-01T00:00:00Z`),
  }));
  const found = flattenChromiumBookmarks({ roots: { bookmark_bar: { children } } }, 5);
  assert.equal(found.length, 5);
  for (let index = 1; index < found.length; index += 1) {
    assert.ok(found[index - 1].addedAt >= found[index].addedAt, "not newest-first");
  }
});

/* ── A profile name can never become a path ───────────────────────────────── */

test("a profile id is one directory name and nothing else", () => {
  for (const good of ["Default", "Profile 1", "Profile 10", "a-b_c.d"]) {
    assert.equal(isSafeProfileId(good), true, good);
  }
  for (const bad of [
    "../../../etc",
    "Default/../../Library",
    "/absolute",
    "..",
    "with/slash",
    "",
    null,
    undefined,
    42,
    "x".repeat(65),
  ]) {
    assert.equal(isSafeProfileId(bad), false, String(bad));
  }
});

test("a traversing profile is refused before anything is read", async () => {
  await assert.rejects(() => readImport("chrome", "../../../../etc", { home: "/nowhere" }), (error) => {
    assert.equal(error.code, "BROWSER_IMPORT_PROFILE_INVALID");
    return true;
  });
});

test("a browser that is not on the list is refused by name", async () => {
  await assert.rejects(() => readImport("netscape", "Default", { home: "/nowhere" }), (error) => {
    assert.equal(error.code, "BROWSER_IMPORT_SOURCE_UNKNOWN");
    return true;
  });
});

test("Safari refuses with the reason, rather than failing at the file", async () => {
  await assert.rejects(() => readImport("safari", "Default", { home: "/nowhere" }), (error) => {
    assert.equal(error.code, "BROWSER_IMPORT_UNAVAILABLE");
    assert.match(error.message, /Full Disk Access/);
    return true;
  });
});

/* ── Real databases, real SQL ─────────────────────────────────────────────── */

test("Chromium history is read from a copy, with the 1601 epoch narrowed in SQL", async () => {
  const dir = await scratch();
  try {
    const path = join(dir, "History");
    const database = new DatabaseSync(path);
    database.exec("create table urls (id integer primary key, url text, title text, last_visit_time integer)");
    // The literal is the true shape of the column: microseconds since 1601,
    // well past 2^53. Reading it into a JS number would throw ERR_OUT_OF_RANGE.
    database.exec(`insert into urls (url, title, last_visit_time) values
      ('https://newer.example', 'Newer', 13432985205915271),
      ('https://older.example', 'Older', 13000000000000000),
      ('javascript:alert(1)', 'Hostile', 13432985205915271),
      ('https://never.example', 'Never visited', 0)`);
    database.close();

    const rows = await readChromiumHistory(path);
    assert.deepEqual(
      rows.map((row) => row.url),
      ["https://newer.example", "https://older.example"],
    );
    assert.equal(rows[0].visitedAt, "2026-09-04T08:46:45.000Z");
    assert.equal(rows[0].title, "Newer");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the source database is never opened — only a copy of it is", async () => {
  const dir = await scratch();
  try {
    const path = join(dir, "History");
    const database = new DatabaseSync(path);
    database.exec("create table urls (id integer primary key, url text, title text, last_visit_time integer)");
    database.exec("insert into urls (url, title, last_visit_time) values ('https://a.example','A',13432985205915271)");
    database.close();

    const opened = [];
    const rows = await readChromiumHistory(path, {
      openImpl: (candidate) => {
        opened.push(candidate);
        return new DatabaseSync(candidate, { readOnly: true });
      },
    });
    assert.equal(rows.length, 1);
    assert.equal(opened.length, 1);
    assert.notEqual(opened[0], path, "the live file was opened");
    assert.match(opened[0], /teminali-import-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a profile that cannot be read reports nothing rather than throwing", async () => {
  const rows = await readChromiumHistory(join(await scratch(), "does-not-exist"));
  assert.deepEqual(rows, []);
});

test("Firefox history and bookmarks are read out of places.sqlite", async () => {
  const dir = await scratch();
  try {
    const path = join(dir, "places.sqlite");
    const database = new DatabaseSync(path);
    database.exec("create table moz_places (id integer primary key, url text, title text, last_visit_date integer)");
    database.exec("create table moz_bookmarks (id integer primary key, type integer, fk integer, title text, dateAdded integer)");
    // Firefox counts microseconds from the Unix epoch, not from 1601.
    const micro = (iso) => Date.parse(iso) * 1000;
    database.exec(`insert into moz_places (id, url, title, last_visit_date) values
      (1, 'https://fox.example', 'Fox', ${micro("2024-06-01T12:00:00Z")}),
      (2, 'https://old.example', 'Old', ${micro("2021-01-01T00:00:00Z")}),
      (3, 'https://unvisited.example', 'Unvisited', null)`);
    database.exec(`insert into moz_bookmarks (type, fk, title, dateAdded) values
      (1, 1, 'Fox bookmark', ${micro("2024-05-01T00:00:00Z")}),
      (2, 2, 'A folder, not a bookmark', ${micro("2024-05-02T00:00:00Z")})`);
    database.close();

    const history = await readFirefoxHistory(path);
    assert.deepEqual(history.map((row) => row.url), ["https://fox.example", "https://old.example"]);
    assert.equal(history[0].visitedAt, "2024-06-01T12:00:00.000Z");

    const bookmarks = await readFirefoxBookmarks(path);
    assert.equal(bookmarks.length, 1, "a folder row (type 2) is not a bookmark");
    assert.equal(bookmarks[0].url, "https://fox.example");
    assert.equal(bookmarks[0].addedAt, "2024-05-01T00:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── Discovery is evidence, not a list of vendors ─────────────────────────── */

async function fakeHome() {
  const home = await scratch();
  const support = join(home, "Library", "Application Support");
  // A real Chrome profile: bookmarks and history.
  const chrome = join(support, "Google", "Chrome");
  await mkdir(join(chrome, "Default"), { recursive: true });
  await writeFile(join(chrome, "Default", "Bookmarks"), JSON.stringify({ roots: {} }), "utf8");
  await writeFile(join(chrome, "Default", "History"), "", "utf8");
  // A second profile with history only, and a display name in Local State.
  await mkdir(join(chrome, "Profile 1"), { recursive: true });
  await writeFile(join(chrome, "Profile 1", "History"), "", "utf8");
  await writeFile(
    join(chrome, "Local State"),
    JSON.stringify({ profile: { info_cache: { "Profile 1": { name: "Work" } } } }),
    "utf8",
  );
  // A directory that is not a profile, and must not be offered as one.
  await mkdir(join(chrome, "ShaderCache"), { recursive: true });
  // A vendor folder holding nothing but an extension's leftovers — exactly what
  // Brave, Chromium, Vivaldi and Arc look like on this machine.
  await mkdir(join(support, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"), { recursive: true });
  return home;
}

test("a browser is offered only when a profile really holds its files", async () => {
  const home = await fakeHome();
  try {
    const found = await discoverImportSources({ home, platformName: "darwin" });
    assert.equal(found.available, true);
    const ids = found.sources.map((source) => source.id);
    assert.ok(ids.includes("chrome"));
    // Present as a folder, absent as a browser.
    assert.ok(!ids.includes("brave"), "a NativeMessagingHosts-only folder was offered as a browser");

    const chrome = found.sources.find((source) => source.id === "chrome");
    assert.deepEqual(chrome.profiles.map((profile) => profile.id), ["Default", "Profile 1"]);
    // The name from Local State, not the directory name.
    assert.equal(chrome.profiles[1].label, "Work");
    assert.deepEqual(
      chrome.profiles.map((profile) => [profile.bookmarks, profile.history]),
      [[true, true], [false, true]],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Safari is listed as unavailable with its reason, not hidden", async () => {
  const home = await fakeHome();
  try {
    await mkdir(join(home, "Library", "Safari"), { recursive: true });
    await writeFile(join(home, "Library", "Safari", "History.db"), "", "utf8");
    const found = await discoverImportSources({ home, platformName: "darwin" });
    const safari = found.sources.find((source) => source.id === "safari");
    assert.ok(safari, "Safari was hidden rather than explained");
    assert.equal(safari.available, false);
    assert.match(safari.reason, /Full Disk Access/);
    assert.deepEqual(safari.profiles, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("autofill is always reported unsupported, with the reason why", async () => {
  const home = await fakeHome();
  try {
    const found = await discoverImportSources({ home, platformName: "darwin" });
    assert.equal(found.autofill.supported, false);
    assert.equal(found.autofill.reason, AUTOFILL_REASON);
    assert.match(found.autofill.reason, /nowhere/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a platform this cannot read says so instead of offering nothing", async () => {
  for (const platformName of ["win32", "linux"]) {
    const found = await discoverImportSources({ home: "/nowhere", platformName });
    assert.equal(found.available, false);
    assert.match(found.reason, /macOS/);
    assert.deepEqual(found.sources, []);
    // Even here the autofill answer is the true one.
    assert.equal(found.autofill.supported, false);
  }
});

/* ── One profile, end to end ──────────────────────────────────────────────── */

test("reading a profile takes bookmarks from JSON and history from SQLite", async () => {
  const home = await scratch();
  try {
    const profile = join(home, "Library", "Application Support", "Google", "Chrome", "Default");
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, "Bookmarks"),
      JSON.stringify({
        roots: { bookmark_bar: { children: [{ type: "url", name: "Kept", url: "https://kept.example", date_added: stamp("2024-03-03T00:00:00Z") }] } },
      }),
      "utf8",
    );
    const database = new DatabaseSync(join(profile, "History"));
    database.exec("create table urls (id integer primary key, url text, title text, last_visit_time integer)");
    database.exec("insert into urls (url, title, last_visit_time) values ('https://seen.example','Seen',13432985205915271)");
    database.close();

    const both = await readImport("chrome", "Default", { home });
    assert.deepEqual(both.bookmarks.map((entry) => entry.url), ["https://kept.example"]);
    assert.deepEqual(both.history.map((entry) => entry.url), ["https://seen.example"]);

    // Ticking one box reads one list, and does not quietly read the other.
    const onlyHistory = await readImport("chrome", "Default", { home, kinds: { bookmarks: false, history: true } });
    assert.deepEqual(onlyHistory.bookmarks, []);
    assert.equal(onlyHistory.history.length, 1);

    const neither = await readImport("chrome", "Default", { home, kinds: { bookmarks: false, history: false } });
    assert.deepEqual(neither, { bookmarks: [], history: [] });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a profile with no Bookmarks file still imports its history", async () => {
  const home = await scratch();
  try {
    const profile = join(home, "Library", "Application Support", "Google", "Chrome", "Profile 1");
    await mkdir(profile, { recursive: true });
    const database = new DatabaseSync(join(profile, "History"));
    database.exec("create table urls (id integer primary key, url text, title text, last_visit_time integer)");
    database.exec("insert into urls (url, title, last_visit_time) values ('https://only.example','Only',13432985205915271)");
    database.close();

    const both = await readImport("chrome", "Profile 1", { home });
    assert.deepEqual(both.bookmarks, []);
    assert.equal(both.history.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
