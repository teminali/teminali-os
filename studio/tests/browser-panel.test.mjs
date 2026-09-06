import assert from "node:assert/strict";
import test from "node:test";

import { isRevealable, parseKnownDownloads } from "../electron/browserView.cjs";
import {
  downloadAction,
  foldRecent,
  foldVisit,
  visitDay,
  visitKey,
  visitOf,
} from "../src/utils/browserRecording.ts";

/**
 * The browser panel's side: what gets written down, and which files main will
 * point the Finder at. Both are rules the assistant later reads back and acts
 * on, so they are pinned here rather than left to be exercised by hand.
 */

/* ── History ──────────────────────────────────────────────────────────────── */

test("only a loaded http(s) page is a visit", () => {
  assert.deepEqual(visitOf({ id: "a", url: "https://example.com", title: "Example" }), {
    url: "https://example.com",
    title: "Example",
  });
  // A page that has not said what it is called yet is still a page.
  assert.deepEqual(visitOf({ id: "a", url: "https://example.com" }), { url: "https://example.com", title: "" });

  for (const state of [
    null,
    undefined,
    { id: "a" },
    { id: "a", url: "about:blank" },
    { id: "a", url: "file:///etc/passwd" },
    { id: "a", url: "https://example.com", error: "Could not load" },
    { id: "a", url: "https://example.com", closed: true },
  ]) {
    assert.equal(visitOf(state), null, JSON.stringify(state));
  }
});

test("a visit is keyed on the title as well as the address", () => {
  // One navigation reports itself before and after the title arrives. Keying on
  // the address alone would leave the row named after the URL for ever.
  const early = visitOf({ id: "a", url: "https://example.com" });
  const named = visitOf({ id: "a", url: "https://example.com", title: "Example" });
  assert.notEqual(visitKey(early), visitKey(named));
  assert.equal(visitKey(named), visitKey({ url: "https://example.com", title: "Example" }));
});

test("the cached history folds a repeat of the newest row", () => {
  // The same fold the gateway does on disk, so the two do not disagree between
  // a navigation and the next full read.
  const first = { url: "https://a.test", title: "A", visitedAt: "2026-01-01T00:00:00.000Z" };
  const renamed = { url: "https://a.test", title: "A — loaded", visitedAt: "2026-01-01T00:00:01.000Z" };
  const other = { url: "https://b.test", title: "B", visitedAt: "2026-01-01T00:00:02.000Z" };

  assert.deepEqual(foldVisit([], first), [first]);
  assert.deepEqual(foldVisit([first], renamed), [renamed]);
  assert.deepEqual(foldVisit([renamed], other), [other, renamed]);
  // Not the head: a page revisited after another one is a new row.
  assert.deepEqual(foldVisit([other, renamed], first), [first, other, renamed]);
});

test("the cached history cannot outgrow the gateway's cap", () => {
  const rows = Array.from({ length: 500 }, (_, index) => ({
    url: `https://n${index}.test`,
    title: `${index}`,
    visitedAt: "2026-01-01T00:00:00.000Z",
  }));
  const folded = foldVisit(rows, { url: "https://new.test", title: "New", visitedAt: "2026-01-02T00:00:00.000Z" });
  assert.equal(folded.length, 500);
  assert.equal(folded[0].url, "https://new.test");
});

/* ── Downloads ────────────────────────────────────────────────────────────── */

const arriving = {
  downloadId: "dl-1",
  panelId: "panel-1",
  url: "https://example.com/big.zip",
  filename: "big.zip",
  state: "progressing",
  done: false,
  received: 1024,
  total: 4096,
  path: "",
};

test("a download in flight stays in the renderer", () => {
  assert.deepEqual(downloadAction(arriving), {
    kind: "active",
    id: "dl-1",
    download: { filename: "big.zip", received: 1024, total: 4096, state: "progressing" },
  });
  assert.equal(downloadAction({ ...arriving, state: "paused" }).download.state, "paused");
  // An interruption that has not ended can still resume, so the row stays.
  assert.equal(downloadAction({ ...arriving, state: "interrupted" }).kind, "active");
  assert.equal(downloadAction(null), null);
  assert.equal(downloadAction({ ...arriving, downloadId: "" }), null);
});

test("only a download that ended with an outcome is written down", () => {
  assert.deepEqual(
    downloadAction({ ...arriving, done: true, state: "completed", received: 4096, path: "/Users/x/big.zip" }),
    {
      kind: "record",
      id: "dl-1",
      entry: {
        url: "https://example.com/big.zip",
        filename: "big.zip",
        path: "/Users/x/big.zip",
        bytes: 4096,
        state: "completed",
      },
    }
  );
  assert.equal(downloadAction({ ...arriving, done: true, state: "interrupted" }).kind, "record");
  // Dismissing Electron's save dialog reports `cancelled` — a file the operator
  // declined, not a download that failed.
  assert.deepEqual(downloadAction({ ...arriving, done: true, state: "cancelled" }), { kind: "drop", id: "dl-1" });
});

/* ── Reveal ───────────────────────────────────────────────────────────────── */

test("main reveals only a path it saved itself", () => {
  const known = new Set(["/Users/x/Downloads/big.zip"]);
  assert.equal(isRevealable(known, "/Users/x/Downloads/big.zip"), true);
  // Otherwise the renderer would have a directory-listing oracle over the disk.
  assert.equal(isRevealable(known, "/etc/passwd"), false);
  assert.equal(isRevealable(known, ""), false);
  assert.equal(isRevealable(known, null), false);
  assert.equal(isRevealable(known, undefined), false);
});

test("the persisted reveal list survives a corrupt or hostile file", () => {
  assert.deepEqual(parseKnownDownloads('["/Users/x/a.zip","/Users/x/b.zip"]'), ["/Users/x/a.zip", "/Users/x/b.zip"]);
  // Anything that is not an absolute path is not a file main saved.
  assert.deepEqual(parseKnownDownloads('["a.zip", 3, null, {"path":"/x"}]'), []);
  assert.deepEqual(parseKnownDownloads("not json"), []);
  assert.deepEqual(parseKnownDownloads('{"paths":["/x"]}'), []);
  assert.equal(parseKnownDownloads(JSON.stringify(Array.from({ length: 400 }, (_, i) => `/x/${i}`))).length, 200);
});

/* ── The recent list, as the home page shows it ───────────────────────────── */

/**
 * The gateway folds a repeat at the head — one navigation reporting itself
 * three times. It cannot fold a page returned to between other pages, and that
 * is the shape that filled the home page with six identical rows.
 */
test("the same page visited between others is one row, with a count", () => {
  const history = [
    { url: "https://a.example/", title: "A", visitedAt: "2026-09-06T12:00:00.000Z" },
    { url: "https://b.example/", title: "B", visitedAt: "2026-09-06T11:00:00.000Z" },
    { url: "https://a.example/", title: "A (older title)", visitedAt: "2026-09-06T10:00:00.000Z" },
    { url: "https://a.example/", title: "A", visitedAt: "2026-09-06T09:00:00.000Z" },
  ];
  const folded = foldRecent(history, 10);
  assert.deepEqual(
    folded.map((row) => [row.url, row.visits]),
    [["https://a.example/", 3], ["https://b.example/", 1]],
  );
  // The newest stamp and the title that came with it.
  assert.equal(folded[0].visitedAt, "2026-09-06T12:00:00.000Z");
  assert.equal(folded[0].title, "A");
});

test("the limit counts pages, not visits", () => {
  const history = [];
  for (let i = 0; i < 30; i += 1) {
    history.push({ url: `https://x${i % 3}.example/`, title: "x", visitedAt: `2026-09-06T${String(i % 24).padStart(2, "0")}:00:00.000Z` });
  }
  assert.equal(foldRecent(history, 10).length, 3);
  assert.equal(foldRecent(history, 2).length, 2);
  assert.deepEqual(foldRecent([], 10), []);
});

test("a visit falls under today, yesterday, or earlier", () => {
  const now = new Date("2026-09-06T12:00:00.000Z").getTime();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  assert.equal(visitDay(new Date(now - 60_000).toISOString(), now), "Today");
  assert.equal(visitDay(new Date(midnight.getTime()).toISOString(), now), "Today");
  assert.equal(visitDay(new Date(midnight.getTime() - 1).toISOString(), now), "Yesterday");
  assert.equal(visitDay(new Date(midnight.getTime() - 86_400_000 - 1).toISOString(), now), "Earlier");
  // A row whose stamp is unreadable is old, not a crash.
  assert.equal(visitDay("not a date", now), "Earlier");
});

test("one page reached by several addresses is one row", () => {
  // A video collects `&list=` and `&t=` while it plays; every one of those is
  // a different address for the page the operator would call one thing.
  const history = [
    { url: "https://www.youtube.com/watch?v=1&list=RD1", title: "Chubina - YouTube", visitedAt: "2026-09-06T12:00:00.000Z" },
    { url: "https://www.youtube.com/watch?v=1", title: "Chubina - YouTube", visitedAt: "2026-09-06T11:00:00.000Z" },
    { url: "https://www.youtube.com/watch?v=1&t=42", title: "Chubina - YouTube", visitedAt: "2026-09-06T10:00:00.000Z" },
  ];
  const folded = foldRecent(history, 10);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].visits, 3);
  // Opening it goes where they last were, not to the first form of the link.
  assert.equal(folded[0].url, "https://www.youtube.com/watch?v=1&list=RD1");
});

test("the same title on two hosts is two pages", () => {
  const history = [
    { url: "https://a.example/", title: "Sign in", visitedAt: "2026-09-06T12:00:00.000Z" },
    { url: "https://b.example/", title: "Sign in", visitedAt: "2026-09-06T11:00:00.000Z" },
  ];
  assert.equal(foldRecent(history, 10).length, 2);
});

test("an untitled page is identified by its address alone", () => {
  const history = [
    { url: "https://a.example/one", title: "", visitedAt: "2026-09-06T12:00:00.000Z" },
    { url: "https://a.example/two", title: "", visitedAt: "2026-09-06T11:00:00.000Z" },
  ];
  assert.equal(foldRecent(history, 10).length, 2);
});
