import assert from "node:assert/strict";
import test from "node:test";
import { createBuildPlan } from "../src/plan.js";

test("builds a transitive chain in dependency order", () => {
  const graph = { web: ["api"], core: [], api: ["core"] };
  assert.deepEqual(createBuildPlan(graph, ["core"]), [
    { name: "core", reason: "changed" },
    { name: "api", reason: "dependent" },
    { name: "web", reason: "dependent" },
  ]);
});

test("uses lexical ordering for a diamond", () => {
  const graph = { app: ["b", "a"], b: ["core"], a: ["core"], core: [] };
  assert.deepEqual(createBuildPlan(graph, ["core"]), [
    { name: "core", reason: "changed" },
    { name: "a", reason: "dependent" },
    { name: "b", reason: "dependent" },
    { name: "app", reason: "dependent" },
  ]);
});

test("skips exact cache hits without suppressing dependents", () => {
  const graph = { web: ["api"], api: ["core"], core: [] };
  assert.deepEqual(createBuildPlan(graph, ["core"], { api: true }), [
    { name: "core", reason: "changed" },
    { name: "web", reason: "dependent" },
  ]);
});
