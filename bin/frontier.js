#!/usr/bin/env node

import {
  MODEL_MODES,
  parseCliArgs,
  launchFrontier,
  PROFILES,
  listAvailableSkills,
} from "../gateway/frontier-runner.js";
import { startFrontierTui } from "../gateway/frontier-tui.js";

async function main() {
  const options = parseCliArgs(process.argv.slice(2));

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    const skills = listAvailableSkills();
    console.log(`
⚡ Frontier Code — Autonomous AI Software Engineer

Usage:
  frontier                        Launch interactive full-screen UI editor
  frontier run "<prompt>"         Execute an instruction autonomously
  frontier run -s <skill> "<p>"   Execute with specialized domain skill
  frontier chat [dir]             Launch interactive AI coding session
  frontier skills                 List available specialist skill packs
  frontier eval [benchmarkId]     Run automated benchmark scoring
  frontier status                 View model lanes and health

Options:
  -m, --mode <name>               Chat model mode: flash, auto (default), or max
  -s, --skill <name>              Mount specialist skill pack (e.g. website-builder, frontiercut-copilot)
  -p, --profile <name>            Routing profile: local (default), local-expert, local-24b, auto, claude-sonnet, claude-opus
  -b, --budget <usd>              Hard run budget limit in USD (default: 0.20)
  -d, --dir <path>                Target repository path (default: current working directory)
  --require-change                Require a verified workspace edit or fail
  --allow-file <path>             Limit a structured local run to this file (repeatable)
  --require-file <path>           Require this file to be written (repeatable)
  -v, --verbose                   Enable detailed gateway diagnostics
  -h, --help                      Show this help message

Resource safety:
  The local-expert profile uses Qwen3.8 IQ3_M on demand with an 8K context and
  requires 10 GB free memory. local-24b requires at least 32 GB system memory.
  Structured default required-change runs use the resource-safe 14B lane. Set
  FRONTIER_ALLOW_HIGH_MEMORY_LOCAL=1 only to override the admission guard.

Available Profiles:
${Object.entries(PROFILES).map(([k, v]) => `  • ${k.padEnd(16)} ${v.label}`).join("\n")}

Chat Model Modes:
${Object.entries(MODEL_MODES).map(([k, v]) => `  • ${k.padEnd(16)} ${v.description}`).join("\n")}

Available Skills:
${skills.map((s) => `  • ${s.name.padEnd(20)} ${s.description.slice(0, 70)}...`).join("\n")}
`);
    process.exit(0);
  }

  if (options.command === "skills") {
    const skills = listAvailableSkills();
    console.log(`⚡ Frontier Code Specialist Skills:\n`);
    for (const skill of skills) {
      console.log(`  📦 ${skill.name}`);
      console.log(`     ${skill.description}\n`);
    }
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

  if (options.command === "chat") {
    await startFrontierTui(options);
    return;
  }

  // Launch a one-shot task or benchmark command.
  try {
    const result = await launchFrontier(options);
    process.exit(result.code ?? 0);
  } catch (err) {
    console.error(`[Frontier Code Error] ${err.message}`);
    process.exit(1);
  }
}

main();
