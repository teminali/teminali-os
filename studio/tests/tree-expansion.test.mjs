import assert from "node:assert/strict";
import test from "node:test";
import { ancestorPaths, expandForReveal, toggleExpansion, DEFAULT_EXPANDED_PATHS } from "../src/store/treeExpansion.ts";

test("revealing a nested file opens every folder above it", () => {
  const revealed = expandForReveal(new Set(), "studio/src/store/studioStore.ts");
  assert.deepEqual([...revealed], ["studio", "studio/src", "studio/src/store", "studio/src/store/studioStore.ts"]);
});

test("revealing something already visible returns the same set, so the tree does not re-render", () => {
  const current = new Set(["studio", "studio/src"]);
  assert.equal(expandForReveal(current, "studio/src"), current);
});

test("reveal keeps folders that were already open", () => {
  const revealed = expandForReveal(new Set(["docs"]), "src/App.tsx");
  assert.ok(revealed.has("docs"));
  assert.ok(revealed.has("src"));
});

test("ancestors of a top-level path are just the path", () => {
  assert.deepEqual(ancestorPaths("README.md"), ["README.md"]);
  assert.deepEqual(ancestorPaths(""), []);
});

test("toggling opens then shuts one folder without touching its ancestors", () => {
  const opened = toggleExpansion(new Set(["studio"]), "studio/src");
  assert.deepEqual([...opened], ["studio", "studio/src"]);
  const shut = toggleExpansion(opened, "studio/src");
  assert.deepEqual([...shut], ["studio"]);
});

test("a nested folder sharing a default name stays shut", () => {
  const boot = new Set(DEFAULT_EXPANDED_PATHS);
  assert.ok(boot.has("src"));
  assert.ok(!boot.has("studio/src"));
});
