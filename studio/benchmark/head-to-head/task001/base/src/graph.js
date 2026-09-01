import { GraphError } from "./errors.js";

export function validateGraph(graph) {
  if (!graph || typeof graph !== "object") {
    throw new GraphError("INVALID_GRAPH", "Graph must be an object.");
  }
  return graph;
}

export function affectedPackages(graph, changed) {
  validateGraph(graph);
  const affected = new Set(changed);
  for (const name of Object.keys(graph)) {
    if (graph[name].some((dependency) => affected.has(dependency))) affected.add(name);
  }
  return [...affected];
}

export function topologicalOrder(graph, selected) {
  const selectedSet = new Set(selected);
  return Object.keys(graph).filter((name) => selectedSet.has(name));
}
