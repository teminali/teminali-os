import assert from "node:assert/strict";
import test from "node:test";

import { contextMenuTemplate, setSearchEngine } from "../electron/contextMenu.cjs";
import { addressLabel, normaliseAddress, searchUrl } from "../src/utils/address.ts";
import { faviconUrl } from "../src/utils/siteMark.ts";
import {
  DEFAULT_SEARCH_ENGINE_ID,
  SEARCH_ENGINES,
  searchEngineById,
  searchQueryOf,
} from "../src/utils/searchEngines.ts";

/**
 * The search engine is one choice read in three places — the home page's
 * field, the omnibox's first suggestion, and a right-click menu built in
 * another process. What is pinned here is that they cannot disagree, and that
 * a preference arriving over IPC cannot turn a menu item into a way to open
 * something that is not a search.
 */

test("every engine is an https query prefix", () => {
  const ids = new Set();
  for (const engine of SEARCH_ENGINES) {
    assert.match(engine.query, /^https:\/\/[^\s]+[?&]q=$/, engine.id);
    assert.match(engine.home, /^https:\/\/[^\s/]+$/, engine.id);
    assert.equal(ids.has(engine.id), false, `duplicate id ${engine.id}`);
    ids.add(engine.id);
  }
  assert.equal(searchEngineById(DEFAULT_SEARCH_ENGINE_ID).id, "google");
});

test("an unknown or missing engine falls back rather than breaking the field", () => {
  // A persisted id from a build that offered an engine this one does not.
  assert.equal(searchEngineById("altavista").id, "google");
  assert.equal(searchEngineById(null).id, "google");
  assert.equal(searchEngineById(undefined).id, "google");
});

test("words go to the chosen engine, and only to it", () => {
  assert.equal(searchUrl("hello world"), "https://www.google.com/search?q=hello%20world");
  assert.equal(searchUrl("hello world", "bing"), "https://www.bing.com/search?q=hello%20world");
  assert.equal(searchUrl("hello world", "duckduckgo"), "https://duckduckgo.com/?q=hello%20world");
  // The omnibox's own guess uses the same engine it was given.
  assert.equal(normaliseAddress("hello world", "brave").url, "https://search.brave.com/search?q=hello%20world");
  assert.equal(normaliseAddress("hello world", "brave").search, true);
});

test("switching engines does not rename the tabs already open", () => {
  // A Bing search tab is still called by what was searched for, whichever
  // engine is current now.
  assert.equal(addressLabel("https://www.bing.com/search?q=ripgrep"), "ripgrep");
  assert.equal(addressLabel("https://www.google.com/search?q=ripgrep"), "ripgrep");
  assert.equal(searchQueryOf("https://example.com/search?q=ripgrep"), null);
  // Not a search: an ordinary page keeps its host as its name.
  assert.equal(addressLabel("https://example.com/a"), "example.com");
});

test("an address is still an address, whichever engine is chosen", () => {
  assert.equal(normaliseAddress("5173", "bing").url, "http://localhost:5173");
  assert.equal(normaliseAddress("example.com", "bing").url, "https://example.com");
  // The refusals do not become searches.
  assert.equal(normaliseAddress("javascript:alert(1)", "bing").url, null);
});

/* ── The menu in the other process ────────────────────────────────────────── */

test("the right-click menu names the engine the operator chose", () => {
  const label = () =>
    contextMenuTemplate({ isEditable: false, selectionText: "ripgrep" }).find((item) =>
      String(item.label).startsWith("Search "),
    ).label;

  assert.ok(String(label()).startsWith("Search Google for"), String(label()));
  assert.equal(setSearchEngine({ name: "Bing", query: "https://www.bing.com/search?q=" }), true);
  assert.ok(String(label()).startsWith("Search Bing for"), String(label()));
});

test("a search engine arriving over IPC has to be an https address", () => {
  for (const hostile of [
    { name: "Evil", query: "javascript:alert(1)" },
    { name: "Evil", query: "file:///etc/passwd" },
    { name: "Evil", query: "http://insecure.example/?q=" },
    { name: "", query: "https://www.bing.com/search?q=" },
    { name: "Evil", query: "https://has a space/?q=" },
    null,
    undefined,
    "https://www.bing.com/search?q=",
  ]) {
    assert.equal(setSearchEngine(hostile), false, JSON.stringify(hostile));
  }
  // The last good one still stands — a refusal does not clear the choice.
  const label = contextMenuTemplate({ isEditable: false, selectionText: "x" }).find((item) =>
    String(item.label).startsWith("Search "),
  ).label;
  assert.ok(String(label).startsWith("Search Bing for"), String(label));

  // Put it back, so a test file that runs after this one sees the default.
  setSearchEngine({ name: "Google", query: "https://www.google.com/search?q=" });
});

/* ── The shortcut's own icon ──────────────────────────────────────────────── */

test("a favicon is asked of the site itself, never of a third party", () => {
  assert.equal(faviconUrl("https://example.com/a/b?c=d"), "https://example.com/favicon.ico");
  assert.equal(faviconUrl("http://localhost:5173/x"), "http://localhost:5173/favicon.ico");
  // Nothing to ask, rather than a made-up address.
  assert.equal(faviconUrl("file:///etc/passwd"), null);
  assert.equal(faviconUrl("not a url"), null);
  assert.equal(faviconUrl(""), null);
});
