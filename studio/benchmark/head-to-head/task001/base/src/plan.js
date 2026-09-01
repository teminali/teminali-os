import { affectedPackages, topologicalOrder } from "./graph.js";

export function createBuildPlan(graph, changed, cache = {}) {
  changed.sort();
  const affected = affectedPackages(graph, changed);
  return topologicalOrder(graph, affected).map((name) => ({
    name,
    reason: affected.includes(name) ? "changed" : "dependent",
    cacheHit: Boolean(cache[name]),
  }));
}
