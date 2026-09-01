#!/usr/bin/env node
import { join } from "node:path";
import { OllamaGatewayBenchmark, writeReport } from "./ollama-benchmark.js";

function parseArguments(argv) {
  const options = { runs: 5, includeCold: false, cancellationProbe: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--include-cold") options.includeCold = true;
    else if (argument === "--no-cancellation") options.cancellationProbe = false;
    else if (["--runs", "--cold-threshold-ms", "--num-predict"].includes(argument)) {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value)) throw new Error(`${argument} requires a numeric value.`);
      if (argument === "--runs") options.runs = value;
      else if (argument === "--cold-threshold-ms") options.coldThresholdMs = value;
      else options.numPredict = value;
    } else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

const parsed = parseArguments(process.argv.slice(2));
if (parsed.help) {
  process.stdout.write("Usage: node performance-runtime/cli.js [--runs N] [--include-cold] [--cold-threshold-ms N] [--num-predict N] [--no-cancellation]\n");
  process.exit(0);
}

const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const outputPath = join(process.cwd(), "performance-runtime", "results", `ollama-${timestamp}.json`);
const benchmark = new OllamaGatewayBenchmark({
  gatewayUrl: process.env.FRONTIER_GATEWAY_URL || "http://127.0.0.1:4310",
  token: process.env.FRONTIER_GATEWAY_TOKEN || null,
  origin: "http://localhost:3000",
  model: process.env.FRONTIER_BENCHMARK_MODEL || "devstral-small-2:24b-instruct-2512-q4_K_M",
  prompt: process.env.FRONTIER_BENCHMARK_PROMPT || "Implement a JavaScript function that groups records by key, preserves input order within each group, and explain its time complexity in one sentence.",
  ...parsed,
});

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const report = await benchmark.run(controller.signal);
  const written = await writeReport(outputPath, report);
  process.stdout.write(`${JSON.stringify({ reportPath: written, status: report.status, runCount: report.rawSamples.length, warnings: report.warnings }, null, 2)}\n`);
  if (report.status !== "measured") process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: { code: error?.code || "BENCHMARK_FAILED", message: error instanceof Error ? error.message : "Unknown error" } })}\n`);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
