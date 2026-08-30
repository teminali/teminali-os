#!/usr/bin/env node

import { parseCliArgs, launchFrontier, PROFILES } from "../gateway/frontier-runner.js";

async function main() {
  const options = parseCliArgs(process.argv.slice(2));

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`
⚡ Frontier Code — Autonomous AI Software Engineer

Usage:
  frontier run "<prompt>"         Execute an instruction autonomously
  frontier chat [dir]             Launch interactive AI coding session
  frontier eval [benchmarkId]     Run automated benchmark scoring
  frontier status                 View model lanes and health

Options:
  -p, --profile <name>            Routing profile: local (default), auto, claude-sonnet, claude-opus
  -b, --budget <usd>              Hard run budget limit in USD (default: 0.20)
  -d, --dir <path>                Target repository path (default: current working directory)
  -v, --verbose                   Enable detailed gateway diagnostics
  -h, --help                      Show this help message

Available Profiles:
${Object.entries(PROFILES).map(([k, v]) => `  • ${k.padEnd(16)} ${v.label}`).join("\n")}
`);
    process.exit(0);
  }

  if (options.command === "status") {
    console.log(`⚡ Frontier Code Status:`);
    console.log(`Profiles:`);
    for (const [k, v] of Object.entries(PROFILES)) {
      console.log(`  - ${k}: ${v.label}`);
    }
    process.exit(0);
  }

  try {
    const result = await launchFrontier(options);
    process.exit(result.code ?? 0);
  } catch (err) {
    console.error(`[Frontier Code Error] ${err.message}`);
    process.exit(1);
  }
}

main();
