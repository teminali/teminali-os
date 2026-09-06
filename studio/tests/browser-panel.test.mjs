import assert from "node:assert/strict";
import test from "node:test";

import { isRevealable, parseKnownDownloads } from "../electron/browserView.cjs";
import { downloadAction, foldVisit, visitKey, visitOf } from "../src/utils/browserRecording.ts";

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
