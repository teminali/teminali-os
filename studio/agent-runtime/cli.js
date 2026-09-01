#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { GatewayPlanner } from "./gateway-planner.js";
import { SingleAgentRuntime } from "./runtime.js";

async function loadTask(path) {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (!info.isFile() || info.size > 256 * 1024) throw new Error("Task configuration must be a JSON file no larger than 256 KiB.");
  const task = JSON.parse(await readFile(absolute, "utf8"));
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error("Task configuration must be a JSON object.");
  return task;
}

async function main() {
  const taskPath = process.argv[2];
  if (!taskPath) throw new Error("Usage: node agent-runtime/cli.js <task.json>");
  const task = await loadTask(taskPath);
  const gatewayUrl = task.gatewayUrl || "http://127.0.0.1:4310";
  const model = task.model;
  let planner;
  if (process.env.FRONTIER_GATEWAY_TOKEN) {
    planner = new GatewayPlanner({ gatewayUrl, token: process.env.FRONTIER_GATEWAY_TOKEN, model });
  } else {
    planner = await GatewayPlanner.bootstrap({ gatewayUrl, origin: task.origin || "http://localhost:3000", model });
  }
  const runtime = new SingleAgentRuntime({ ...task, planner });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await runtime.run(controller.signal);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: { code: error?.code || "RUNTIME_FAILED", message: error instanceof Error ? error.message : "Unknown error" } })}\n`);
  process.exitCode = 1;
});
