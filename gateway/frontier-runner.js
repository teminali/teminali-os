import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createGateway } from "./http-gateway.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { runStructuredLocalAgent } from "./local-structured-agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const SKILLS_DIR = path.resolve(ROOT_DIR, "skills");
const MODEL_QUALIFICATION_FILE = path.resolve(__dirname, "model-qualification.json");
const QWEN38_CHATML_TEMPLATE = `{{- range .Messages }}<|im_start|>{{ .Role }}
{{ .Content }}<|im_end|>
{{ end }}<|im_start|>assistant
<think>
`;

export const MODEL_MODES = Object.freeze({
  flash: Object.freeze({ label: "Flash", description: "Lightweight local model for every task" }),
  auto: Object.freeze({ label: "Auto", description: "Hybrid routing between lightweight and heavyweight local models" }),
  max: Object.freeze({ label: "Max", description: "Heavyweight local model for every task" }),
});

export function isExpertModelQualified(filePath = MODEL_QUALIFICATION_FILE) {
  try {
    const qualification = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return qualification?.qwen38Iq3m?.qualified === true;
  } catch {
    return false;
  }
}

export function modelModeForProfile(profile) {
  if (profile === "local") return "flash";
  if (profile === "local-expert") return "max";
  return null;
}

export function modelTaskComplexity(prompt) {
  const text = String(prompt ?? "").toLowerCase();
  const signals = [
    /\b(multi[- ]?file|repository[- ]?wide|cross[- ]?cutting)\b/,
    /\b(refactor|architecture|migration|concurrency|parallel|race|deadlock)\b/,
    /\b(debug|diagnos|root cause|benchmark|performance|security|authentication)\b/,
    /\b(design|implement|build)\b[\s\S]{0,80}\b(system|feature|workflow|integration)\b/,
  ];
  return signals.reduce((score, pattern) => score + Number(pattern.test(text)), 0)
    + Number(text.length >= 600);
}

export function selectProfileForMode(
  mode,
  prompt,
  { expertQualified = isExpertModelQualified() } = {},
) {
  if (!Object.hasOwn(MODEL_MODES, mode)) {
    throw new Error(`Unknown model mode ${mode}. Expected one of: ${Object.keys(MODEL_MODES).join(", ")}`);
  }
  if (mode === "flash") {
    return Object.freeze({ mode, profile: "local", reason: "flash_always_light", expertQualified });
  }
  if (mode === "max") {
    if (!expertQualified) {
      throw new Error("Max is locked until Qwen3.8 passes the isolated model and FrontierCode safety checks.");
    }
    return Object.freeze({ mode, profile: "local-expert", reason: "max_always_heavy", expertQualified });
  }
  const complexity = modelTaskComplexity(prompt);
  const useExpert = expertQualified && complexity >= 2;
  return Object.freeze({
    mode,
    profile: useExpert ? "local-expert" : "local",
    reason: !expertQualified ? "expert_pending_qualification" : useExpert ? "auto_complex_task" : "auto_light_task",
    complexity,
    expertQualified,
  });
}

export const PROFILES = Object.freeze({
  local: {
    label: "Local Qwen2.5-Coder 14B ($0 / token, resource-safe)",
    lanesFile: "gateway/lanes.controlled-local-coder.json",
    pinnedAlias: "ollama-local-coder",
    configFile: "opencode.gateway.jsonc",
    maxOutputTokens: "4096",
    defaultOutputTokens: "4096",
    upstreamTimeoutMs: "600000",
    runTimeoutMs: 720000,
    localModel: {
      source: "qwen2.5-coder:14b-instruct",
      model: "frontier-qwen2.5-coder-14b-16k",
      contextTokens: 16384,
      minimumSystemMemoryBytes: 16 * 1024 ** 3,
    },
    structuredLanesFile: "gateway/lanes.controlled-local-coder-8k.json",
    structuredLabel: "Local Qwen2.5-Coder 14B (resource-safe)",
    structuredPinnedAlias: "ollama-local-coder",
    structuredSnapshotMaxBytes: 24_576,
    structuredLocalModel: {
      source: "qwen2.5-coder:14b-instruct",
      model: "frontier-qwen2.5-coder-14b-8k",
      contextTokens: 8192,
      minimumSystemMemoryBytes: 16 * 1024 ** 3,
    },
    needsKeys: [],
  },
  "local-expert": {
    label: "Local Qwen3.8 27B IQ3_M Expert ($0 / token, on-demand)",
    lanesFile: "gateway/lanes.controlled-qwen38-expert.json",
    pinnedAlias: "ollama-qwen38-expert",
    configFile: "opencode.gateway.jsonc",
    maxOutputTokens: "4096",
    defaultOutputTokens: "4096",
    upstreamTimeoutMs: "600000",
    runTimeoutMs: 720000,
    localModel: {
      source: "hf.co/bartowski/Qwen3.8-27B-GGUF:IQ3_M",
      model: "frontier-qwen3.8-27b-iq3m-8k",
      contextTokens: 8192,
      minimumSystemMemoryBytes: 24 * 1024 ** 3,
      minimumFreeMemoryBytes: 10 * 1024 ** 3,
      template: QWEN38_CHATML_TEMPLATE,
      stopTokens: ["<|im_end|>"],
      textOnlyFromSplitGguf: true,
    },
    structuredLanesFile: "gateway/lanes.controlled-qwen38-expert.json",
    structuredLabel: "Local Qwen3.8 27B IQ3_M Expert (bounded 8K)",
    structuredPinnedAlias: "ollama-qwen38-expert",
    structuredToolTransport: "prompt-json",
    structuredSnapshotMaxBytes: 24_576,
    structuredLocalModel: {
      source: "hf.co/bartowski/Qwen3.8-27B-GGUF:IQ3_M",
      model: "frontier-qwen3.8-27b-iq3m-8k",
      contextTokens: 8192,
      minimumSystemMemoryBytes: 24 * 1024 ** 3,
      minimumFreeMemoryBytes: 10 * 1024 ** 3,
      template: QWEN38_CHATML_TEMPLATE,
      stopTokens: ["<|im_end|>"],
      textOnlyFromSplitGguf: true,
    },
    needsKeys: [],
  },
  "local-24b": {
    label: "Local Devstral 24B ($0 / token, requires 32 GB)",
    lanesFile: "gateway/lanes.controlled-devstral.json",
    pinnedAlias: "ollama-devstral",
    configFile: "opencode.gateway.jsonc",
    maxOutputTokens: "4096",
    defaultOutputTokens: "4096",
    upstreamTimeoutMs: "600000",
    runTimeoutMs: 720000,
    localModel: {
      source: "devstral-small-2:24b-instruct-2512-q4_K_M",
      model: "frontier-devstral-24b-32k",
      contextTokens: 32768,
      minimumSystemMemoryBytes: 32 * 1024 ** 3,
    },
    needsKeys: [],
  },
  auto: {
    label: "Frontier Auto (Local Qwen Coder + Claude Sonnet Escalation)",
    lanesFile: "gateway/lanes.enhanced-devstral-claude.example.json",
    configFile: "opencode.claude-enhanced.jsonc",
    maxOutputTokens: "4096",
    defaultOutputTokens: "4096",
    upstreamTimeoutMs: "600000",
    localModel: {
      source: "qwen2.5-coder:14b-instruct",
      model: "frontier-qwen2.5-coder-14b-16k",
      contextTokens: 16384,
      minimumSystemMemoryBytes: 16 * 1024 ** 3,
    },
    needsKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID"],
  },
  "claude-sonnet": {
    label: "Claude Sonnet 5 Controlled",
    lanesFile: "gateway/lanes.controlled-claude-sonnet.json",
    pinnedAlias: "anthropic-sonnet-primary",
    configFile: "opencode.claude-gateway.jsonc",
    maxOutputTokens: "4096",
    defaultOutputTokens: "4096",
    upstreamTimeoutMs: "120000",
    needsKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID"],
  },
  "claude-opus": {
    label: "Claude Opus 5 Escalation",
    lanesFile: "gateway/lanes.controlled-claude-opus.json",
    pinnedAlias: "anthropic-opus-escalation",
    configFile: "opencode.claude-opus.jsonc",
    maxOutputTokens: "4096",
    defaultOutputTokens: "4096",
    upstreamTimeoutMs: "120000",
    needsKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID"],
  },
});

export function availableMemoryBytes({
  platform = process.platform,
  totalMemoryBytes = os.totalmem(),
  freeMemoryBytes = os.freemem(),
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform !== "darwin") return freeMemoryBytes;
  const result = spawnSyncImpl("memory_pressure", ["-Q"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const match = result.stdout?.match(/System-wide memory free percentage:\s*(\d+)%/i);
  if (!match) return freeMemoryBytes;
  const percentage = Math.max(0, Math.min(100, Number(match[1])));
  return Math.floor(totalMemoryBytes * percentage / 100);
}

export function assertLocalProfileCapacity(
  profileConfig,
  {
    totalMemoryBytes = os.totalmem(),
    freeMemoryBytes = availableMemoryBytes({ totalMemoryBytes }),
    allowHighMemory = process.env.FRONTIER_ALLOW_HIGH_MEMORY_LOCAL === "1",
  } = {},
) {
  const localModel = profileConfig.localModel;
  if (!localModel) return Object.freeze({ required: false });
  const minimum = localModel.minimumSystemMemoryBytes ?? 0;
  if (!allowHighMemory && totalMemoryBytes < minimum) {
    const availableGiB = Math.round(totalMemoryBytes / 1024 ** 3);
    const requiredGiB = Math.round(minimum / 1024 ** 3);
    throw new Error(
      `Local model ${localModel.model} requires at least ${requiredGiB} GB system memory; ` +
      `this machine has ${availableGiB} GB. Use a structured required-change run or set ` +
      "FRONTIER_ALLOW_HIGH_MEMORY_LOCAL=1 to override.",
    );
  }
  const minimumFree = localModel.minimumFreeMemoryBytes ?? 0;
  if (!allowHighMemory && freeMemoryBytes < minimumFree) {
    const availableGiB = Math.round(freeMemoryBytes / 1024 ** 3);
    const requiredGiB = Math.round(minimumFree / 1024 ** 3);
    throw new Error(
      `Local model ${localModel.model} requires at least ${requiredGiB} GB free memory; ` +
      `this machine currently has about ${availableGiB} GB. Close memory-heavy apps and retry.`,
    );
  }
  return Object.freeze({ required: true });
}

export async function ensureLocalProfileModel(
  profileConfig,
  {
    fetchImpl = fetch,
    totalMemoryBytes = os.totalmem(),
    freeMemoryBytes = availableMemoryBytes({ totalMemoryBytes }),
    allowHighMemory = process.env.FRONTIER_ALLOW_HIGH_MEMORY_LOCAL === "1",
  } = {},
) {
  const localModel = profileConfig.localModel;
  if (!localModel) return Object.freeze({ required: false, created: false });
  assertLocalProfileCapacity(profileConfig, { totalMemoryBytes, freeMemoryBytes, allowHighMemory });

  const endpoint = "http://127.0.0.1:11434";
  let showResponse;
  try {
    showResponse = await fetchImpl(`${endpoint}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: localModel.model }),
    });
  } catch {
    throw new Error("Local Ollama is unavailable at http://127.0.0.1:11434");
  }

  if (showResponse.ok) {
    const details = await showResponse.json();
    const contextPattern = new RegExp(`(?:^|\\n)num_ctx\\s+${localModel.contextTokens}(?:\\n|$)`);
    const templateMatches = localModel.template === undefined || details.template === localModel.template;
    const fromCount = (details.modelfile?.match(/^FROM\s+/gm) ?? []).length;
    const sourceLayoutMatches = !localModel.textOnlyFromSplitGguf || fromCount === 1;
    if (contextPattern.test(details.parameters ?? "") && templateMatches && sourceLayoutMatches) {
      return Object.freeze({ required: true, created: false });
    }
  } else if (showResponse.status !== 404) {
    throw new Error(`Unable to inspect the Frontier local model (HTTP ${showResponse.status})`);
  }

  let sourceFields = { from: localModel.source };
  if (localModel.textOnlyFromSplitGguf) {
    const sourceResponse = await fetchImpl(`${endpoint}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: localModel.source }),
    });
    if (!sourceResponse.ok) {
      if (sourceResponse.status === 404) {
        throw new Error(
          `Local model source ${localModel.source} is not installed. Run: ollama pull ${localModel.source}`,
        );
      }
      throw new Error(`Unable to inspect the Frontier local model source (HTTP ${sourceResponse.status})`);
    }
    const sourceDetails = await sourceResponse.json();
    const firstFrom = sourceDetails.modelfile?.match(/^FROM\s+.*sha256[-:]([a-f0-9]{64})\s*$/m);
    if (!firstFrom) {
      throw new Error(`Local model source ${localModel.source} does not expose a usable text GGUF blob`);
    }
    sourceFields = { files: { "model.gguf": `sha256:${firstFrom[1]}` } };
  }

  const createResponse = await fetchImpl(`${endpoint}/api/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: localModel.model,
      ...sourceFields,
      parameters: {
        num_ctx: localModel.contextTokens,
        ...(localModel.stopTokens ? { stop: localModel.stopTokens } : {}),
      },
      ...(localModel.template ? { template: localModel.template } : {}),
      stream: false,
    }),
  });
  if (!createResponse.ok) {
    if (createResponse.status === 404) {
      throw new Error(
        `Local model source ${localModel.source} is not installed. Run: ollama pull ${localModel.source}`,
      );
    }
    throw new Error(`Unable to prepare the Frontier local model (HTTP ${createResponse.status})`);
  }
  return Object.freeze({ required: true, created: true });
}

export async function unloadLocalProfileModel(
  profileConfig,
  { fetchImpl = fetch } = {},
) {
  const localModel = profileConfig.localModel;
  if (!localModel) return Object.freeze({ required: false, unloaded: false });
  try {
    const response = await fetchImpl("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: localModel.model, keep_alive: 0, stream: false }),
    });
    return Object.freeze({ required: true, unloaded: response.ok });
  } catch {
    return Object.freeze({ required: true, unloaded: false });
  }
}

export function buildFrontierEnvironment(
  parsed,
  profileConfig,
  accessToken,
  baseEnv = process.env,
) {
  const lanesFile =
    parsed.command === "run" &&
    parsed.requireChange &&
    profileConfig.structuredLanesFile
      ? profileConfig.structuredLanesFile
      : profileConfig.lanesFile;
  const env = {
    ...baseEnv,
    GATEWAY_ACCESS_TOKEN: accessToken,
    GATEWAY_LANES_FILE: path.resolve(ROOT_DIR, lanesFile),
    GATEWAY_MAX_USD_PER_RUN: parsed.budget,
    GATEWAY_MAX_TOKENS_PER_RUN: parsed.maxTokens,
    GATEWAY_MAX_REQUESTS_PER_RUN: parsed.maxRequests,
    GATEWAY_MAX_OUTPUT_TOKENS:
      baseEnv.GATEWAY_MAX_OUTPUT_TOKENS ?? profileConfig.maxOutputTokens,
    GATEWAY_DEFAULT_OUTPUT_TOKENS:
      baseEnv.GATEWAY_DEFAULT_OUTPUT_TOKENS ?? profileConfig.defaultOutputTokens,
    GATEWAY_UPSTREAM_TIMEOUT_MS:
      baseEnv.GATEWAY_UPSTREAM_TIMEOUT_MS ?? profileConfig.upstreamTimeoutMs,
    OPENCODE_DISABLE_CLAUDE_CODE:
      baseEnv.OPENCODE_DISABLE_CLAUDE_CODE ?? "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS:
      baseEnv.OPENCODE_DISABLE_EXTERNAL_SKILLS ?? "1",
    OPENCODE_CONFIG: path.resolve(ROOT_DIR, profileConfig.configFile),
  };

  const pinnedAlias =
    parsed.command === "run" &&
    parsed.requireChange &&
    profileConfig.structuredPinnedAlias
      ? profileConfig.structuredPinnedAlias
      : profileConfig.pinnedAlias;
  if (pinnedAlias) {
    env.GATEWAY_PINNED_ALIAS = pinnedAlias;
  } else {
    delete env.GATEWAY_PINNED_ALIAS;
  }

  return env;
}

export function listAvailableSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillPath = path.join(SKILLS_DIR, entry.name, "SKILL.md");
      if (fs.existsSync(skillPath)) {
        const content = fs.readFileSync(skillPath, "utf8");
        const matchDesc = /description:\s*([^\n]+)/.exec(content);
        skills.push({
          name: entry.name,
          path: skillPath,
          description: matchDesc ? matchDesc[1].trim() : "Custom specialist skill",
        });
      }
    }
  }
  return skills;
}

export function loadSkillContent(skillName) {
  const skillPath = path.join(SKILLS_DIR, skillName, "SKILL.md");
  if (fs.existsSync(skillPath)) {
    return fs.readFileSync(skillPath, "utf8");
  }
  return null;
}

export function findOpenCodeBinary(customPath, pathValue = process.env.PATH) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  if (typeof pathValue === "string") {
    for (const directory of pathValue.split(path.delimiter)) {
      if (!directory) continue;
      const candidate = path.join(directory, "opencode");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
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
    modelMode: null,
    targetDir: process.cwd(),
    prompt: null,
    skill: null,
    budget: "0.20",
    maxTokens: "300000",
    maxRequests: "20",
    verbose: false,
    requireChange: false,
    allowedFiles: [],
    requiredFiles: [],
    benchmarkId: null,
  };
  const takeValue = (flag, description) => {
    const value = args.shift();
    if (!value || value.startsWith("-")) {
      throw new Error(`${flag} requires ${description}`);
    }
    return value;
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
    } else if (current === "skills" || current === "skill:list") {
      options.command = "skills";
    } else if (current === "--skill" || current === "-s") {
      options.skill = takeValue(current, "a skill name");
    } else if (current === "--profile" || current === "-p") {
      options.profile = takeValue(current, "a profile name");
    } else if (current === "--mode" || current === "-m") {
      options.modelMode = takeValue(current, "Flash, Auto, or Max").toLowerCase();
    } else if (current === "--budget" || current === "-b") {
      options.budget = takeValue(current, "a USD limit");
    } else if (current === "--dir" || current === "-d") {
      options.targetDir = path.resolve(takeValue(current, "a workspace path"));
    } else if (current === "--verbose" || current === "-v") {
      options.verbose = true;
    } else if (current === "--require-change") {
      options.requireChange = true;
    } else if (current === "--allow-file") {
      options.allowedFiles.push(takeValue(current, "a relative workspace path"));
    } else if (current === "--require-file") {
      options.requiredFiles.push(takeValue(current, "a relative workspace path"));
    } else if (!current.startsWith("-") && !options.prompt) {
      if (options.command === "chat" && fs.existsSync(current)) {
        options.targetDir = path.resolve(current);
      } else {
        options.command = "run";
        options.prompt = current;
      }
    }
  }

  if (!Object.hasOwn(PROFILES, options.profile)) {
    throw new Error(
      `Unknown profile ${options.profile}. Expected one of: ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  if (options.modelMode !== null && !Object.hasOwn(MODEL_MODES, options.modelMode)) {
    throw new Error(
      `Unknown model mode ${options.modelMode}. Expected one of: ${Object.keys(MODEL_MODES).join(", ")}`,
    );
  }
  return options;
}

export function workspaceDigest(directory) {
  const hash = crypto.createHash("sha256");

  function visit(current, relative = "") {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = path.posix.join(relative, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, childRelative);
      } else if (entry.isFile()) {
        hash.update(childRelative);
        hash.update("\0");
        hash.update(fs.readFileSync(absolute));
        hash.update("\0");
      }
    }
  }

  visit(directory);
  return hash.digest("hex");
}

export function workspaceTextSnapshot(
  directory,
  { maxFiles = 64, maxFileBytes = 32_768, maxTotalBytes = 131_072 } = {},
) {
  const allowedExtensions = new Set([
    ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".ts", ".tsx", ".txt",
  ]);
  const sections = [];
  let files = 0;
  let totalBytes = 0;

  function visit(current, relative = "") {
    if (files >= maxFiles || totalBytes >= maxTotalBytes) return;
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => entry.name !== "node_modules")
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files >= maxFiles || totalBytes >= maxTotalBytes) break;
      const childRelative = path.posix.join(relative, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, childRelative);
        continue;
      }
      if (!entry.isFile() || !allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const content = fs.readFileSync(absolute);
      if (content.length > maxFileBytes || content.includes(0)) continue;
      const section = `\n--- ${childRelative} ---\n${content.toString("utf8")}\n`;
      const sectionBytes = Buffer.byteLength(section);
      if (totalBytes + sectionBytes > maxTotalBytes) continue;
      sections.push(section);
      totalBytes += sectionBytes;
      files += 1;
    }
  }

  visit(directory);
  return sections.join("");
}

export function runOpenCode(bin, args, env, cwd, timeoutMs, abortSignal) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: "inherit",
      env,
      cwd,
    });

    let timedOut = false;
    let cancelled = false;
    let forceKillTimer = null;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKillTimer.unref();
    };
    const handleAbort = () => {
      cancelled = true;
      terminate();
    };
    abortSignal?.addEventListener("abort", handleAbort, { once: true });
    if (abortSignal?.aborted) handleAbort();
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs)
      : null;
    timer?.unref();

    const finish = () => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      abortSignal?.removeEventListener("abort", handleAbort);
    };
    child.on("error", (error) => {
      finish();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      finish();
      resolve({ code, signal, timedOut, cancelled });
    });
  });
}

export async function launchFrontier(options = {}) {
  let parsed = { ...parseCliArgs([]), ...options };
  const reportStatus = (phase, detail = "") => {
    try {
      parsed.onStatus?.(Object.freeze({ phase, detail }));
    } catch {
      // Presentation hooks are observational and cannot affect execution.
    }
  };
  if (parsed.command === "run" && parsed.modelMode) {
    const selection = selectProfileForMode(parsed.modelMode, parsed.prompt);
    parsed = { ...parsed, profile: selection.profile };
  }
  const profileConfig = PROFILES[parsed.profile];
  if (!profileConfig) {
    throw new Error(
      `Unknown profile ${parsed.profile}. Expected one of: ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  const token = crypto.randomBytes(32).toString("hex");

  const env = buildFrontierEnvironment(parsed, profileConfig, token);

  const useStructuredLocal =
    parsed.command === "run" &&
    parsed.requireChange &&
    Boolean(profileConfig.structuredLocalModel);
  const executionProfile =
    useStructuredLocal &&
    profileConfig.structuredLocalModel
      ? { ...profileConfig, localModel: profileConfig.structuredLocalModel }
      : profileConfig;
  reportStatus("preparing", executionProfile.localModel?.model ?? "remote model");
  await ensureLocalProfileModel(executionProfile);

  // Start internal gateway
  reportStatus("gateway", "secure local gateway");
  const runtime = loadRuntimeConfig(env);
  const gateway = createGateway(runtime.getGatewayOptions());
  const url = await gateway.listen(runtime.listen);

  const shutdownController = new AbortController();
  let cleanupPromise = null;
  const requestShutdown = () => {
    reportStatus("cancelling", "stopping the active run");
    shutdownController.abort();
    void cleanup();
  };
  const cleanup = () => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        process.removeListener("SIGINT", requestShutdown);
        process.removeListener("SIGTERM", requestShutdown);
        try {
          await gateway.close();
        } catch {
          // ignore
        }
        await unloadLocalProfileModel(executionProfile);
      })();
    }
    return cleanupPromise;
  };

  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  let finalPrompt = parsed.prompt || "";
  if (parsed.skill) {
    const skillContent = loadSkillContent(parsed.skill);
    if (skillContent) {
      finalPrompt = `[SPECIALIST SKILL: ${parsed.skill}]\n\n${skillContent}\n\n---\n\n[TASK]\n${finalPrompt}`;
    }
  }

  if (parsed.verbose) {
    console.log(`[Frontier Code] Gateway active at ${url}`);
    console.log(
      `[Frontier Code] Profile: ${useStructuredLocal ? profileConfig.structuredLabel : profileConfig.label}`,
    );
    if (parsed.skill) console.log(`[Frontier Code] Mounted Skill: ${parsed.skill}`);
    console.log(`[Frontier Code] Budget limit: USD $${parsed.budget}`);
  }

  if (useStructuredLocal) {
    const beforeDigest = workspaceDigest(parsed.targetDir);
    try {
      if (parsed.verbose) {
        console.log("[Frontier Code] Execution: bounded local edit + npm test");
      }
      reportStatus("thinking", "bounded workspace");
      const outcome = await runStructuredLocalAgent({
        endpoint: url,
        accessToken: token,
        targetDir: parsed.targetDir,
        prompt: finalPrompt,
        snapshot: workspaceTextSnapshot(parsed.targetDir, {
          maxTotalBytes: profileConfig.structuredSnapshotMaxBytes,
        }),
        allowedFilePaths: parsed.allowedFiles,
        requiredFilePaths: parsed.requiredFiles,
        toolTransport: profileConfig.structuredToolTransport ?? "native",
        signal: shutdownController.signal,
        onEvent: (event) => {
          if (event.type === "model-turn") {
            reportStatus("thinking", `model turn ${event.turn}/${event.turnLimit}`);
          } else if (event.type === "file-write") {
            reportStatus("tool", `wrote ${event.path}`);
          } else if (event.type === "verification-start") {
            reportStatus("verifying", "running workspace tests");
          } else if (event.type === "verification-complete") {
            reportStatus("verifying", event.code === 0 ? "tests passed" : "tests need repair");
          } else if (event.type === "verification-classified") {
            reportStatus("recovery", event.categories.join(", "));
          } else if (event.type === "retry") {
            reportStatus("recovery", event.reason.replaceAll("_", " "));
          } else if (event.type === "cancelled") {
            reportStatus("cancelling", "stopping the bounded edit");
          }
        },
      });
      if (parsed.verbose) {
        console.log(
          `[Frontier Code] Result: ${outcome.reason}; changed ${outcome.changedFiles?.length ?? 0} file(s)`,
        );
      }
      const requiredChangeMissing = workspaceDigest(parsed.targetDir) === beforeDigest;
      reportStatus("cleanup", "releasing model memory");
      await cleanup();
      if (requiredChangeMissing) {
        return {
          ...outcome,
          code: 1,
          ok: false,
          reason: outcome.reason ?? "required_change_missing",
          recoveryAttempted: false,
          executionMode: "structured-local",
        };
      }
      return {
        ...outcome,
        recoveryAttempted: false,
        executionMode: "structured-local",
      };
    } catch (error) {
      reportStatus("cleanup", "releasing model memory");
      await cleanup();
      throw error;
    }
  }

  const bin = findOpenCodeBinary(env.OPENCODE_BIN, env.PATH);
  if (!bin) {
    await cleanup();
    throw new Error("OpenCode binary not found. Install via `npm i -g opencode-ai` or check ~/.opencode/bin/opencode.");
  }

  const opencodeArgs = [];
  if (parsed.command === "run") {
    opencodeArgs.push("run", finalPrompt, "--dir", parsed.targetDir, "--pure");
  } else {
    opencodeArgs.push(parsed.targetDir);
  }

  const beforeDigest = parsed.requireChange
    ? workspaceDigest(parsed.targetDir)
    : null;
  let recoveryAttempted = false;

  try {
    reportStatus("streaming", "direct terminal stream");
    let outcome = await runOpenCode(
      bin,
      opencodeArgs,
      env,
      parsed.targetDir,
      profileConfig.runTimeoutMs,
      shutdownController.signal,
    );
    if (
      parsed.command === "run" &&
      parsed.requireChange &&
      outcome.code === 0 &&
      !outcome.cancelled &&
      workspaceDigest(parsed.targetDir) === beforeDigest
    ) {
      recoveryAttempted = true;
      reportStatus("recovery", "previous run made no changes");
      const workspaceSnapshot = workspaceTextSnapshot(parsed.targetDir);
      const recoveryPrompt = [
        "Continue the unfinished implementation now.",
        "The previous turn made no workspace changes.",
        "Start from the original task below in this clean recovery session.",
        "Use only relative paths inside the current workspace; never reconstruct or repeat its absolute path.",
        "A bounded snapshot of the relevant workspace files is included below; do not inspect again.",
        "Implement the task immediately, run its required checks,",
        "and do not stop until the requested edits exist.",
        "\n\nORIGINAL TASK AND SPECIALIST GUIDANCE:\n",
        finalPrompt,
        "\n\nBOUNDED WORKSPACE SNAPSHOT:\n",
        workspaceSnapshot,
      ].join(" ");
      reportStatus("streaming", "recovery terminal stream");
      outcome = await runOpenCode(
        bin,
        ["run", recoveryPrompt, "--dir", parsed.targetDir, "--pure"],
        env,
        parsed.targetDir,
        profileConfig.runTimeoutMs,
        shutdownController.signal,
      );
    }

    const requiredChangeMissing =
      parsed.command === "run" &&
      parsed.requireChange &&
      workspaceDigest(parsed.targetDir) === beforeDigest;
    reportStatus("cleanup", "releasing model memory");
    await cleanup();
    if (outcome.cancelled) {
      return {
        code: 130,
        ok: false,
        signal: outcome.signal,
        reason: "agent_cancelled",
        recoveryAttempted,
      };
    }
    if (requiredChangeMissing) {
      return {
        code: 1,
        ok: false,
        signal: outcome.signal,
        reason: "required_change_missing",
        recoveryAttempted,
      };
    }
    return {
      code: outcome.timedOut ? 124 : outcome.code,
      ok: outcome.code === 0 && !outcome.timedOut && !outcome.cancelled,
      signal: outcome.signal,
      reason: outcome.cancelled
        ? "agent_cancelled"
        : outcome.timedOut
          ? "agent_timeout"
          : outcome.code === 0
            ? undefined
            : "agent_failed",
      recoveryAttempted,
    };
  } catch (error) {
    reportStatus("cleanup", "releasing model memory");
    await cleanup();
    throw error;
  }
}
