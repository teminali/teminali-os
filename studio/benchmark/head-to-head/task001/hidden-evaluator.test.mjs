import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

const candidateRoot = process.env.CANDIDATE_ROOT;
if (!candidateRoot) throw new Error("CANDIDATE_ROOT is required.");
const nonce = `candidate=${encodeURIComponent(resolve(candidateRoot))}`;
const { createBuildPlan } = await import(`${pathToFileURL(resolve(candidateRoot, "src/plan.js")).href}?${nonce}`);
function expectCode(callback, code) {
  assert.throws(callback, (error) => error?.name === "GraphError" && error?.code === code);
}

test("rejects malformed graphs and unknown dependencies with stable codes", () => {
  expectCode(() => createBuildPlan(null, []), "INVALID_GRAPH");
  expectCode(() => createBuildPlan([], []), "INVALID_GRAPH");
  expectCode(() => createBuildPlan({ app: "core", core: [] }, ["core"]), "INVALID_GRAPH");
  expectCode(() => createBuildPlan({ app: ["missing"] }, ["app"]), "UNKNOWN_DEPENDENCY");
});

test("rejects unknown changed packages", () => {
  expectCode(() => createBuildPlan({ app: [] }, ["missing"]), "UNKNOWN_CHANGED");
});

test("detects a cycle even when it is disconnected from the changed component", () => {
  const graph = { clean: [], a: ["b"], b: ["c"], c: ["a"] };
  expectCode(() => createBuildPlan(graph, ["clean"]), "CYCLE");
});

test("handles transitive fan-out, multiple changes, and duplicates deterministically", () => {
  const graph = {
    deploy: ["web", "worker"],
    worker: ["shared"],
    web: ["ui", "shared"],
    ui: ["shared"],
    shared: [],
    docs: [],
  };
  assert.deepEqual(createBuildPlan(graph, ["shared", "shared", "docs"]), [
    { name: "docs", reason: "changed" },
    { name: "shared", reason: "changed" },
    { name: "ui", reason: "dependent" },
    { name: "web", reason: "dependent" },
    { name: "worker", reason: "dependent" },
    { name: "deploy", reason: "dependent" },
  ]);
});

test("does not mutate graph arrays, changed, or cache", () => {
  const graph = { app: ["core"], core: [] };
  const changed = ["core"];
  const cache = { core: false };
  const snapshot = JSON.stringify({ graph, changed, cache });
  createBuildPlan(graph, changed, cache);
  assert.equal(JSON.stringify({ graph, changed, cache }), snapshot);
});

test("only exact true own cache properties suppress entries", () => {
  const graph = { app: ["core"], core: [] };
  const inherited = Object.create({ core: true });
  assert.deepEqual(createBuildPlan(graph, ["core"], inherited), [
    { name: "core", reason: "changed" },
    { name: "app", reason: "dependent" },
  ]);
  assert.deepEqual(createBuildPlan(graph, ["core"], { core: true }), [
    { name: "app", reason: "dependent" },
  ]);
});

test("supports constructor and __proto__ as own package names", () => {
  const graph = JSON.parse('{"constructor":[],"__proto__":["constructor"],"app":["__proto__"]}');
  const cache = JSON.parse('{"__proto__":false}');
  assert.deepEqual(createBuildPlan(graph, ["constructor"], cache), [
    { name: "constructor", reason: "changed" },
    { name: "__proto__", reason: "dependent" },
    { name: "app", reason: "dependent" },
  ]);
});
