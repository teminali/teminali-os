import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateSamples } from "../performance-runtime/metrics.js";

const outputIndex = process.argv.indexOf("--output");
if (outputIndex === -1 || !process.argv[outputIndex + 1]) {
  throw new Error("Usage: node benchmark/phase5-aggregate.mjs --output <artifact.json> <report.json> [...]");
}
const outputPath = resolve(process.argv[outputIndex + 1]);
const inputArgs = process.argv.slice(2).filter((_, index, values) => {
  const absoluteIndex = index + 2;
  return absoluteIndex !== outputIndex && absoluteIndex !== outputIndex + 1 && values[index] !== "--output";
});
if (inputArgs.length < 2) throw new Error("At least two source reports are required.");

const sources = [];
for (const path of inputArgs) {
  const absolutePath = resolve(path);
  const bytes = await readFile(absolutePath);
  const report = JSON.parse(bytes.toString("utf8"));
  if (report.status !== "measured" || !Array.isArray(report.rawSamples)) {
    throw new Error(`${path} is not a measured performance report.`);
  }
  sources.push({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    report,
  });
}

const first = sources[0].report;
for (const source of sources.slice(1)) {
  const report = source.report;
  if (
    report.model !== first.model
    || report.prompt?.sha256 !== first.prompt?.sha256
    || report.configuration?.numPredict !== first.configuration?.numPredict
  ) {
    throw new Error("Source reports do not share the same model, prompt hash, and output-token workload.");
  }
}

const samples = sources.flatMap(({ report }) => report.rawSamples);
const aggregate = aggregateSamples(samples);
const passed = samples.every((sample) => sample.complete)
  && aggregate.cold.runCount >= 3
  && aggregate.warm.runCount >= 3
  && aggregate.unknown.runCount === 0;
const result = {
  phase: 5,
  passed,
  createdAt: new Date().toISOString(),
  model: first.model,
  prompt: first.prompt,
  workload: { numPredict: first.configuration.numPredict },
  sourceReports: sources.map(({ path, sha256 }) => ({ path, sha256 })),
  aggregate,
  cancellationSamples: sources.map(({ report }) => report.cancellation).filter(Boolean),
};
const serialized = `${JSON.stringify(result, null, 2)}\n`;
await writeFile(outputPath, serialized, { flag: "wx", mode: 0o400 });
process.stdout.write(serialized);
if (!passed) process.exitCode = 1;
