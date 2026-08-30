import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createGateway } from "./http-gateway.js";
import { loadRuntimeConfig } from "./runtime-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

export const PROFILES = Object.freeze({
  local: {
    label: "Local-First Devstral 24B ($0 / token)",
    lanesFile: "gateway/lanes.controlled-devstral.json",
    pinnedAlias: "ollama-devstral-local",
    configFile: "opencode.gateway.jsonc",
    needsKeys: [],
  },
  auto: {
    label: "Frontier Auto (Local Devstral + Claude Sonnet Escalation)",
    lanesFile: "gateway/lanes.enhanced-devstral-claude.example.json",
    configFile: "opencode.claude-enhanced.jsonc",
    needsKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID"],
  },
  "claude-sonnet": {
    label: "Claude Sonnet 5 Controlled",
    lanesFile: "gateway/lanes.controlled-claude-sonnet.json",
    pinnedAlias: "anthropic-sonnet-primary",
    configFile: "opencode.claude-gateway.jsonc",
    needsKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID"],
  },
  "claude-opus": {
    label: "Claude Opus 5 Escalation",
    lanesFile: "gateway/lanes.controlled-claude-opus.json",
    pinnedAlias: "anthropic-opus-escalation",
    configFile: "opencode.claude-opus.jsonc",
    needsKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID"],
  },
});

export function findOpenCodeBinary(customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".opencode", "bin", "opencode"),
    path.join(home, ".local", "bin", "opencode"),
    path.join(home, ".npm-global", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/opt/homebrew/bin/opencode",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  const options = {
    command: "chat",
    profile: "local",
    targetDir: process.cwd(),
    prompt: null,
    budget: "0.20",
    maxTokens: "300000",
    maxRequests: "20",
    verbose: false,
    benchmarkId: null,
  };

  while (args.length > 0) {
    const current = args.shift();
    if (current === "run" || current === "exec") {
      options.command = "run";
      options.prompt = args.shift() || "";
    } else if (current === "chat" || current === "repl") {
      options.command = "chat";
    } else if (current === "eval" || current === "benchmark") {
      options.command = "eval";
      options.benchmarkId = args.shift() || "003";
    } else if (current === "status" || current === "info") {
      options.command = "status";
    } else if (current === "--profile" || current === "-p") {
      options.profile = args.shift() || "local";
    } else if (current === "--budget" || current === "-b") {
      options.budget = args.shift() || "0.20";
    } else if (current === "--dir" || current === "-d") {
      options.targetDir = path.resolve(args.shift() || process.cwd());
    } else if (current === "--verbose" || current === "-v") {
      options.verbose = true;
    } else if (!current.startsWith("-") && !options.prompt) {
      if (options.command === "chat" && fs.existsSync(current)) {
        options.targetDir = path.resolve(current);
      } else {
        options.command = "run";
        options.prompt = current;
      }
    }
  }

  return options;
}

export async function launchFrontier(options = {}) {
  const parsed = { ...parseCliArgs([]), ...options };
  const profileConfig = PROFILES[parsed.profile] || PROFILES.local;
  const token = crypto.randomBytes(32).toString("hex");

  const env = {
    ...process.env,
    GATEWAY_ACCESS_TOKEN: token,
    GATEWAY_LANES_FILE: path.resolve(ROOT_DIR, profileConfig.lanesFile),
    GATEWAY_MAX_USD_PER_RUN: parsed.budget,
    GATEWAY_MAX_TOKENS_PER_RUN: parsed.maxTokens,
    GATEWAY_MAX_REQUESTS_PER_RUN: parsed.maxRequests,
    OPENCODE_CONFIG: path.resolve(ROOT_DIR, profileConfig.configFile),
  };

  if (profileConfig.pinnedAlias) {
    env.GATEWAY_PINNED_ALIAS = profileConfig.pinnedAlias;
  } else {
    delete env.GATEWAY_PINNED_ALIAS;
  }

  // Start internal gateway
  const runtime = loadRuntimeConfig(env);
  const gateway = createGateway(runtime.getGatewayOptions());
  const url = await gateway.listen(runtime.listen);

  const cleanup = async () => {
    try {
      await gateway.close();
    } catch {
      // ignore
    }
  };

  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  if (parsed.verbose) {
    console.log(`[Frontier Code] Gateway active at ${url}`);
    console.log(`[Frontier Code] Profile: ${profileConfig.label}`);
    console.log(`[Frontier Code] Budget limit: USD $${parsed.budget}`);
  }

  const bin = findOpenCodeBinary();
  if (!bin) {
    await cleanup();
    throw new Error("OpenCode binary not found. Install via `npm i -g opencode-ai` or check ~/.opencode/bin/opencode.");
  }

  const opencodeArgs = [];
  if (parsed.command === "run") {
    opencodeArgs.push("run", parsed.prompt, "--dir", parsed.targetDir);
  } else {
    opencodeArgs.push(parsed.targetDir);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, opencodeArgs, {
      stdio: "inherit",
      env,
      cwd: parsed.targetDir,
    });

    child.on("error", async (err) => {
      await cleanup();
      reject(err);
    });

    child.on("exit", async (code) => {
      await cleanup();
      resolve({ code, ok: code === 0 });
    });
  });
}
