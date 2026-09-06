import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_BY_NAME,
  KIND_NAME_SCORE,
  SECTIONS,
  inScope,
  scoreKind,
  rankHits,
  scoreFields,
  scoreText,
  sectionsOf,
} from "../src/utils/globalSearch.ts";

/**
 * The sidebar's search now answers from nine sources at once, so the ordering
 * *is* the feature: a list where the obvious answer is eleventh is a list that
 * failed. What is pinned here is the order, not the sources — those are stores
 * a running app holds, and the rule that decides between them is here.
 */

const hit = (id, kind, score) => ({ id, kind, title: id, detail: "", open: () => {}, score });

test("the four tiers order the way a person predicts", () => {
  const equal = scoreText("readme", "README");
  const prefix = scoreText("read", "readme.md");
  const word = scoreText("me", "read me now");
  const inside = scoreText("adm", "readme");
  assert.ok(equal > prefix, `${equal} > ${prefix}`);
  assert.ok(prefix > word, `${prefix} > ${word}`);
  assert.ok(word > inside, `${word} > ${inside}`);
  assert.equal(scoreText("zzz", "readme"), 0);
  assert.equal(scoreText("", "readme"), 0);
  assert.equal(scoreText("  ", "readme"), 0);
});

test("a word start is after a separator, not merely after any character", () => {
  for (const text of ["src/browser.ts", "my-browser", "my_browser", "my.browser", "my browser"]) {
    assert.ok(scoreText("browser", text) >= 600, text);
  }
  // Inside a word is the lowest tier that still matches.
  assert.ok(scoreText("browser", "nobrowserhere") < 600);
  assert.ok(scoreText("browser", "nobrowserhere") > 0);
});

test("length settles ties and never crosses a tier", () => {
  // Both are prefixes; the shorter one is the more complete answer.
  assert.ok(scoreText("read", "readme") > scoreText("read", "readme-and-a-long-tail.md"));
  // But a prefix on a very long string still beats a mid-word hit on a short one.
  assert.ok(scoreText("read", "read" + "x".repeat(400)) > scoreText("read", "abreadc"));
});

test("several fields score as their best, never as their sum", () => {
  // The title is an exact match; the path merely contains the word. Adding the
  // two would let a long incidental path outrank the thing that was named.
  const named = scoreFields("browser", "browser", "src/x/y.ts");
  const incidental = scoreFields("browser", "y.ts", "src/browser/deep/nested/path/y.ts");
  assert.ok(named > incidental, `${named} > ${incidental}`);
  assert.equal(scoreFields("browser", null, undefined, ""), 0);
});

test("ranking is highest first and stable within a score", () => {
  const ranked = rankHits(
    [hit("a", "file", 10), hit("b", "chat", 30), hit("c", "file", 30), hit("d", "file", 0)],
    10,
  );
  // b and c tie; they keep the order their sources were asked in.
  assert.deepEqual(ranked.map((entry) => entry.id), ["b", "c", "a"]);
  // A zero score is not a result at all.
  assert.equal(ranked.some((entry) => entry.id === "d"), false);
  assert.equal(rankHits([hit("a", "file", 5), hit("b", "file", 4)], 1).length, 1);
});

test("a scope narrows, and `all` narrows nothing", () => {
  for (const section of SECTIONS) assert.equal(inScope(section.kind, "all"), true, section.kind);
  assert.equal(inScope("code", "files"), true);
  assert.equal(inScope("file", "files"), true);
  assert.equal(inScope("chat", "files"), false);
  assert.equal(inScope("history", "web"), true);
  assert.equal(inScope("panel", "actions"), true);
  assert.equal(inScope("panel", "web"), false);
});

test("a section with nothing in it is not drawn", () => {
  const sections = sectionsOf([hit("a", "file", 10), hit("b", "file", 9), hit("c", "chat", 8)], 1);
  assert.deepEqual(sections.map((section) => section.kind), ["file", "chat"]);
  // Capped per section, not overall.
  assert.equal(sections[0].hits.length, 1);
  assert.deepEqual(sectionsOf([], 5), []);
});

test("sections are drawn in one fixed order, actions before answers", () => {
  const order = SECTIONS.map((section) => section.kind);
  assert.ok(order.indexOf("panel") < order.indexOf("file"));
  assert.ok(order.indexOf("file") < order.indexOf("code"));
  // The way out to the web is always last.
  assert.equal(order[order.length - 1], "web");
});

/* ── Asking for a group by its name ───────────────────────────────────────── */

/**
 * "skill" found nothing, because no skill is *called* skill: the word is in
 * none of their names, taglines or descriptions. A search that fails the most
 * obvious question asked of it is a search nobody trusts with a harder one.
 */
test("naming a group finds its members", () => {
  assert.equal(scoreKind("skill", "skill"), KIND_NAME_SCORE);
  assert.equal(scoreKind("skills", "skill"), KIND_NAME_SCORE);
  assert.equal(scoreKind("Panel", "panel"), KIND_NAME_SCORE);
  assert.equal(scoreKind("bookmarks", "bookmark"), KIND_NAME_SCORE);
  assert.equal(scoreKind("project", "project"), KIND_NAME_SCORE);
});

test("only the small enumerable groups answer for their members", () => {
  // Six arbitrary files out of a thousand is noise wearing the shape of an
  // answer, and so is a page out of five hundred visited.
  for (const kind of ["file", "code", "machine", "history", "chat", "web"]) {
    assert.equal(KIND_BY_NAME.has(kind), false, kind);
    assert.equal(scoreKind("files", kind), 0, kind);
  }
});

test("a group name never outranks the thing that is actually called that", () => {
  // A file named skill.ts is what someone typing "skill" most likely wants;
  // the skills are the fallback under it, not over it.
  const named = scoreText("skill", "skill.ts");
  assert.ok(named > KIND_NAME_SCORE, `${named} > ${KIND_NAME_SCORE}`);
  // Even the weakest text tier wins.
  assert.ok(scoreText("skill", "myskillfile") > KIND_NAME_SCORE);
});

test("a fragment too short to mean a group does not summon one", () => {
  assert.equal(scoreKind("sk", "skill"), 0);
  assert.equal(scoreKind("", "skill"), 0);
  assert.equal(scoreKind("  ", "panel"), 0);
});
