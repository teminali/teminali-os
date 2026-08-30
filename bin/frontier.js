#!/usr/bin/env node

import { parseCliArgs, launchFrontier, PROFILES, listAvailableSkills } from "../gateway/frontier-runner.js";

async function main() {
  const options = parseCliArgs(process.argv.slice(2));

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    const skills = listAvailableSkills();
    console.log(`
⚡ Frontier Code — Autonomous AI Software Engineer

Usage:
  frontier run "<prompt>"         Execute an instruction autonomously
  frontier run -s <skill> "<p>"   Execute with specialized domain skill
  frontier chat [dir]             Launch interactive AI coding session
  frontier skills                 List available specialist skill packs
  frontier eval [benchmarkId]     Run automated benchmark scoring
  frontier status                 View model lanes and health

Options:
  -s, --skill <name>              Mount specialist skill pack (e.g. website-builder, frontiercut-copilot)
  -p, --profile <name>            Routing profile: local (default), auto, claude-sonnet, claude-opus
  -b, --budget <usd>              Hard run budget limit in USD (default: 0.20)
  -d, --dir <path>                Target repository path (default: current working directory)
  -v, --verbose                   Enable detailed gateway diagnostics
  -h, --help                      Show this help message

Available Profiles:
${Object.entries(PROFILES).map(([k, v]) => `  • ${k.padEnd(16)} ${v.label}`).join("\n")}

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

  try {
    const result = await launchFrontier(options);
    process.exit(result.code ?? 0);
  } catch (err) {
    console.error(`[Frontier Code Error] ${err.message}`);
    process.exit(1);
  }
}

main();
