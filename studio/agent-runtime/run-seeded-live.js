#!/usr/bin/env node
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayPlanner } from "./gateway-planner.js";
import { SingleAgentRuntime } from "./runtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "seeded-multi-file");
const temporaryRoot = await mkdtemp(join(tmpdir(), "frontier-agent-live-"));
const workspace = join(temporaryRoot, "workspace");
await cp(fixture, workspace, { recursive: true });

const gatewayUrl = process.env.FRONTIER_GATEWAY_URL || "http://127.0.0.1:4310";
const model = process.env.FRONTIER_AGENT_MODEL || "devstral-small-2:24b-instruct-2512-q4_K_M";
let planner;
if (process.env.FRONTIER_GATEWAY_TOKEN) {
  planner = new GatewayPlanner({ gatewayUrl, token: process.env.FRONTIER_GATEWAY_TOKEN, model });
} else {
  planner = await GatewayPlanner.bootstrap({ gatewayUrl, origin: "http://localhost:3000", model });
}

const runtime = new SingleAgentRuntime({
  workspace,
  runId: "live-seeded-repair",
  objective: "Repair the two seeded production defects in mean calculation and public summary formatting. Preserve all existing regression behavior and every file outside the declared edit scope.",
  acceptanceCriteria: [
    "mean([2, 4, 6]) returns 4",
    "summarize([2, 4, 6]) returns Average: 4",
    "sum and empty-array regression behavior remains unchanged",
    "README.md remains byte-for-byte unchanged",
  ],
  editablePaths: ["src/arithmetic.js", "src/summary.js"],
  verifyCommands: [
    { argv: ["node", "--test", "test/regression.test.js"] },
    { argv: ["node", "--test", "test/acceptance.test.js"] },
  ],
  allowedCommands: ["node"],
  maxRepairAttempts: 2,
  planner,
});

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const report = await runtime.run(controller.signal);
  process.stdout.write(`${JSON.stringify({ fixtureWorkspace: workspace, report }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ fixtureWorkspace: workspace, error: { code: error?.code || "LIVE_RUN_FAILED", message: error instanceof Error ? error.message : "Unknown error" } }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
