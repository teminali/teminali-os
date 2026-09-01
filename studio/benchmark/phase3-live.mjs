import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.FRONTIER_APP_URL || "http://127.0.0.1:3000";
const origin = "http://localhost:3000";
const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.window = globalThis;
globalThis.fetch = (input, init = {}) => {
  const target = typeof input === "string" && input.startsWith("/") ? new URL(input, baseUrl) : input;
  const headers = new Headers(init.headers);
  if (typeof input === "string" && input.startsWith("/")) headers.set("Origin", origin);
  return originalFetch(target, { ...init, headers });
};

const { GodAgentSwarmService } = await import("../src/services/godAgentSwarmService.ts");
const workerUpdates = [];
let callbackSynthesis = null;
const synthesis = await GodAgentSwarmService.executeSwarmPipeline(
  ["Design and review a complete TypeScript isAdult(age) function. It must return true only when age is at least 18. Do not claim it was executed or tested."],
  (workers) => {
    workerUpdates.push(workers.map(({ id, role, status, progressPercent }) => ({ id, role, status, progressPercent })));
  },
  (result) => {
    callbackSynthesis = result;
  },
);

if (callbackSynthesis !== synthesis) throw new Error("The completion callback did not receive the returned synthesis.");
const hasThreeArtifacts = synthesis.workerEvidence?.length === 3;
const artifactsComplete = hasThreeArtifacts && synthesis.workerEvidence.every(
  (item) => item.verdict !== "ERROR" && Boolean(item.rawResponse) && Boolean(item.artifact),
);
const metricsComplete = hasThreeArtifacts && synthesis.workerEvidence.every(
  (item) => item.promptTokens !== null && item.completionTokens !== null && item.totalDurationNs !== null,
);

const evidence = {
  phase: 3,
  passed: artifactsComplete && metricsComplete,
  workerUpdateCount: workerUpdates.length,
  synthesis,
};
const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
const outputIndex = process.argv.indexOf("--output");
if (outputIndex !== -1) {
  const outputPath = process.argv[outputIndex + 1];
  if (!outputPath) throw new Error("--output requires a file path.");
  await writeFile(resolve(outputPath), serialized, { flag: "wx", mode: 0o400 });
}
process.stdout.write(serialized);
if (!hasThreeArtifacts) throw new Error("The live swarm did not produce exactly three worker artifacts.");
if (!artifactsComplete) {
  const failures = synthesis.workerEvidence.map(({ verdict, summary, error }) => ({ verdict, summary, error }));
  throw new Error(`At least one live worker failed to produce a model-backed artifact: ${JSON.stringify(failures)}`);
}
if (!metricsComplete) throw new Error("At least one live worker omitted authoritative Ollama usage metrics.");
