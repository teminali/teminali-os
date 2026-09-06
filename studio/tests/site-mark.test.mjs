import assert from "node:assert/strict";
import test from "node:test";
import { relativeAge, siteHue, siteInitial, siteName } from "../src/utils/siteMark.ts";

/**
 * The browser's home page identifies a site by its own initial on a hashed
 * colour rather than by fetching a favicon, because the obvious way to fetch
 * one would mean telling Google every site the operator has ever kept. What is
 * pinned here is that the derivation is stable and says something true.
 */

test("a site is named by the part a person would say out loud", () => {
  assert.equal(siteName("https://www.github.com/x/y"), "github");
  assert.equal(siteName("https://docs.github.com/en"), "github");
  assert.equal(siteName("https://news.bbc.co.uk/story"), "bbc");
  assert.equal(siteName("http://localhost:3000/"), "localhost");
  assert.equal(siteName("not a url"), "site");
});

test("the initial is one uppercase letter, always", () => {
  assert.equal(siteInitial("https://npmjs.com"), "N");
  assert.equal(siteInitial("https://docs.github.com"), "G");
  assert.equal(siteInitial("garbage"), "S");
  for (const url of ["https://a.io", "https://1.example.com", "", "://"]) {
    assert.equal(siteInitial(url).length, 1);
  }
});

test("a hue is stable per site and does not depend on the page", () => {
  assert.equal(siteHue("https://github.com/a"), siteHue("https://docs.github.com/b/c"));
  assert.notEqual(siteHue("https://github.com"), siteHue("https://gitlab.com"));
  for (const url of ["https://a.com", "https://b.com", "junk"]) {
    const hue = siteHue(url);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `${url} -> ${hue}`);
  }
});

test("short names that a naive sum would collide are spread apart", () => {
  // A plain character-code sum gives npm and mdn the same total.
  assert.notEqual(siteHue("https://npm.com"), siteHue("https://mdn.com"));
});

test("age is the same two characters the sidebar uses", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(relativeAge(ago(10_000), now), "now");
  assert.equal(relativeAge(ago(5 * 60_000), now), "5m");
  assert.equal(relativeAge(ago(3 * 3600_000), now), "3h");
  assert.equal(relativeAge(ago(2 * 86400_000), now), "2d");
  assert.equal(relativeAge(ago(21 * 86400_000), now), "3w");
  assert.equal(relativeAge("nonsense", now), "");
});
