import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GatewayPlanner } from "../../agent-runtime/gateway-planner.js";
import { SingleAgentRuntime } from "../../agent-runtime/runtime.js";

const workspace = resolve(process.argv[2] || "");
const outputPath = resolve(process.argv[3] || "");
if (!process.argv[2] || !process.argv[3]) {
  throw new Error("Usage: node benchmark/head-to-head/run-frontier.mjs <workspace> <output.json>");
}
const task = await readFile(resolve(workspace, "TASK.md"), "utf8");
const planner = await GatewayPlanner.bootstrap({
  gatewayUrl: "http://127.0.0.1:4310",
  origin: "http://localhost:3000",
  model: "devstral-small-2:24b-instruct-2512-q4_K_M",
});
const runtime = new SingleAgentRuntime({
  workspace,
  runId: "frontier-h2h-001",
  objective: task,
  acceptanceCriteria: task
    .split("\n")
    .filter((line) => /^\d+\./.test(line.trim()))
    .map((line) => line.trim()),
  editablePaths: ["src/errors.js", "src/graph.js", "src/plan.js"],
  verifyCommands: [{ argv: ["node", "--test", "test/visible.test.js"] }],
  allowedCommands: ["node"],
  maxRepairAttempts: 2,
  planner,
});
const report = await runtime.run();
const serialized = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(outputPath, serialized, { flag: "wx", mode: 0o400 });
process.stdout.write(`${JSON.stringify({
  contestant: "frontier-local-devstral-24b",
  status: report.status,
  changedFiles: report.changedFiles.map(({ path }) => path),
  visibleVerificationPassed: report.verification.at(-1)?.passed === true,
  elapsedMs: report.elapsedMs,
  modelUsage: report.modelUsage,
}, null, 2)}\n`);
