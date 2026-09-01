#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { QualityRuntimeError, runQualityGates } from "./orchestrator.mjs";

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("Usage: node quality-runtime/cli.mjs <quality-config.json>\n");
  process.exitCode = 2;
} else {
  try {
    const config = JSON.parse(await readFile(resolve(configPath), "utf8"));
    const result = await runQualityGates(config);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.report.successful) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof QualityRuntimeError || error instanceof SyntaxError
      ? error.message
      : error instanceof Error
        ? error.stack ?? error.message
        : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
