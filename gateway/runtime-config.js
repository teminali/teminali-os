import { readFileSync } from "node:fs";

import {
  createAnthropicUpstream,
  createGeminiUpstream,
  createGroqUpstream,
  createOllamaUpstream,
} from "./provider-adapters.js";
import { normalizePricing, parseUsdMicros } from "./run-budget.js";

const LANE_FIELDS = new Set([
  "alias",
  "provider",
  "quotaGroup",
  "apiKeyEnv",
  "workspaceIdEnv",
  "providerModel",
  "effort",
  "priority",
  "limits",
  "pricing",
]);
const LIMIT_FIELDS = new Set(["rpm", "rpd", "tpm", "tpd"]);
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function positiveInteger(value, name, fallback) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return candidate;
}

function nonNegativeInteger(value, name, fallback) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return candidate;
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function parseLanes(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError("GATEWAY_LANES_JSON is required");
  }

  let lanes;
  try {
    lanes = JSON.parse(raw);
  } catch {
    throw new TypeError("GATEWAY_LANES_JSON must be valid JSON");
  }
  if (!Array.isArray(lanes) || lanes.length === 0) {
    throw new TypeError("GATEWAY_LANES_JSON must contain at least one lane");
  }
  return lanes;
}

function laneSource(env, readTextFile) {
  const hasJson = typeof env.GATEWAY_LANES_JSON === "string" && env.GATEWAY_LANES_JSON.length > 0;
  const hasFile = typeof env.GATEWAY_LANES_FILE === "string" && env.GATEWAY_LANES_FILE.length > 0;
  if (hasJson === hasFile) {
    throw new TypeError("set exactly one of GATEWAY_LANES_JSON or GATEWAY_LANES_FILE");
  }
  if (hasJson) return env.GATEWAY_LANES_JSON;

  let contents;
  try {
    contents = readTextFile(env.GATEWAY_LANES_FILE, "utf8");
  } catch {
    throw new TypeError("GATEWAY_LANES_FILE could not be read");
  }
  if (Buffer.byteLength(contents) > 65_536) {
    throw new TypeError("GATEWAY_LANES_FILE exceeds 65536 bytes");
  }
  return contents;
}

function normalizeLane(lane, index, env, logicalModel) {
  if (lane === null || typeof lane !== "object" || Array.isArray(lane)) {
    throw new TypeError(`lane ${index} must be an object`);
  }
  for (const key of Object.keys(lane)) {
    if (!LANE_FIELDS.has(key)) throw new TypeError(`lane ${index} has unsupported field: ${key}`);
  }

  const alias = nonEmptyString(lane.alias, `lane ${index}.alias`);
  const provider = nonEmptyString(lane.provider, `lane ${index}.provider`);
  if (
    provider !== "gemini" &&
    provider !== "groq" &&
    provider !== "anthropic" &&
    provider !== "ollama"
  ) {
    throw new TypeError(
      `lane ${index}.provider must be anthropic, gemini, groq, or ollama`,
    );
  }
  const quotaGroup = nonEmptyString(lane.quotaGroup, `lane ${index}.quotaGroup`);
  const providerModel = nonEmptyString(
    lane.providerModel,
    `lane ${index}.providerModel`,
  );

  let apiKeyEnv;
  if (provider !== "ollama") {
    apiKeyEnv = nonEmptyString(lane.apiKeyEnv, `lane ${index}.apiKeyEnv`);
    if (!ENV_NAME.test(apiKeyEnv)) {
      throw new TypeError(`lane ${index}.apiKeyEnv must be an uppercase environment name`);
    }
    if (typeof env[apiKeyEnv] !== "string" || env[apiKeyEnv].length < 8) {
      throw new TypeError(`credential environment variable is unavailable: ${apiKeyEnv}`);
    }
  } else if (lane.apiKeyEnv !== undefined) {
    apiKeyEnv = nonEmptyString(lane.apiKeyEnv, `lane ${index}.apiKeyEnv`);
  }

  let workspaceIdEnv;
  let effort;
  if (provider === "anthropic") {
    workspaceIdEnv = nonEmptyString(
      lane.workspaceIdEnv,
      `lane ${index}.workspaceIdEnv`,
    );
    if (!ENV_NAME.test(workspaceIdEnv)) {
      throw new TypeError(
        `lane ${index}.workspaceIdEnv must be an uppercase environment name`,
      );
    }
    if (!/^wrkspc_[A-Za-z0-9]+$/.test(env[workspaceIdEnv] ?? "")) {
      throw new TypeError(
        `workspace environment variable is unavailable: ${workspaceIdEnv}`,
      );
    }
    effort = nonEmptyString(lane.effort, `lane ${index}.effort`);
    if (!CLAUDE_EFFORTS.has(effort)) {
      throw new TypeError(
        `lane ${index}.effort must be low, medium, high, xhigh, or max`,
      );
    }
  } else if (lane.workspaceIdEnv !== undefined || lane.effort !== undefined) {
    throw new TypeError(
      `lane ${index}.workspaceIdEnv and effort are supported only for anthropic`,
    );
  }

  const priority = nonNegativeInteger(
    lane.priority,
    `lane ${index}.priority`,
    provider === "ollama" ? 1 : 10,
  );

  if (lane.limits === null || typeof lane.limits !== "object" || Array.isArray(lane.limits)) {
    throw new TypeError(`lane ${index}.limits must be an object`);
  }
  for (const key of Object.keys(lane.limits)) {
    if (!LIMIT_FIELDS.has(key)) {
      throw new TypeError(`lane ${index}.limits has unsupported field: ${key}`);
    }
  }
  const limits = {
    rpm: positiveInteger(lane.limits.rpm, `lane ${index}.limits.rpm`),
    rpd: positiveInteger(lane.limits.rpd, `lane ${index}.limits.rpd`),
    tpm: positiveInteger(lane.limits.tpm, `lane ${index}.limits.tpm`),
    tpd:
      lane.limits.tpd === undefined
        ? Infinity
        : positiveInteger(lane.limits.tpd, `lane ${index}.limits.tpd`),
  };

  const pricing = {
    inputUsdPerMillion:
      lane.pricing?.inputUsdPerMillion ?? (provider === "ollama" ? 0 : undefined),
    outputUsdPerMillion:
      lane.pricing?.outputUsdPerMillion ?? (provider === "ollama" ? 0 : undefined),
  };
  normalizePricing(pricing, `lane ${index}.pricing`);

  const adapterOptions = {
    alias,
    getApiKey: () => (apiKeyEnv ? env[apiKeyEnv] : ""),
    modelMap: { [logicalModel]: providerModel },
  };
  let upstream;
  if (provider === "gemini") {
    upstream = createGeminiUpstream(adapterOptions);
  } else if (provider === "groq") {
    upstream = createGroqUpstream(adapterOptions);
  } else if (provider === "ollama") {
    upstream = createOllamaUpstream({
      alias,
      modelMap: { [logicalModel]: providerModel },
    });
  } else {
    upstream = createAnthropicUpstream({
      ...adapterOptions,
      getWorkspaceId: () => env[workspaceIdEnv],
      effort,
    });
  }

  return {
    lane: { alias, quotaGroup, provider, priority, limits },
    upstream,
    pricing,
    safe: {
      alias,
      quotaGroup,
      provider,
      providerModel,
      priority,
      ...(effort === undefined ? {} : { effort }),
      limits,
      pricing,
    },
  };
}

export function loadRuntimeConfig(
  env = process.env,
  { readTextFile = readFileSync } = {},
) {
  const accessToken = nonEmptyString(
    env.GATEWAY_ACCESS_TOKEN,
    "GATEWAY_ACCESS_TOKEN",
  );
  if (accessToken.length < 12) {
    throw new TypeError("GATEWAY_ACCESS_TOKEN must contain at least 12 characters");
  }

  const logicalModel = env.GATEWAY_LOGICAL_MODEL ?? "frontier-code";
  nonEmptyString(logicalModel, "GATEWAY_LOGICAL_MODEL");
  const lanes = parseLanes(laneSource(env, readTextFile)).map((lane, index) =>
    normalizeLane(lane, index, env, logicalModel),
  );
  const aliases = new Set(lanes.map(({ lane }) => lane.alias));
  const pinnedAlias = env.GATEWAY_PINNED_ALIAS || undefined;
  if (pinnedAlias !== undefined && !aliases.has(pinnedAlias)) {
    throw new TypeError("GATEWAY_PINNED_ALIAS must name a configured lane");
  }

  const port = positiveInteger(env.GATEWAY_PORT, "GATEWAY_PORT", 8_787);
  if (port > 65_535) throw new TypeError("GATEWAY_PORT must not exceed 65535");
  const maxOutputTokens = positiveInteger(
    env.GATEWAY_MAX_OUTPUT_TOKENS,
    "GATEWAY_MAX_OUTPUT_TOKENS",
    1_024,
  );
  const defaultOutputTokens = positiveInteger(
    env.GATEWAY_DEFAULT_OUTPUT_TOKENS,
    "GATEWAY_DEFAULT_OUTPUT_TOKENS",
    1_024,
  );
  if (defaultOutputTokens > maxOutputTokens) {
    throw new TypeError("GATEWAY_DEFAULT_OUTPUT_TOKENS must not exceed the maximum");
  }
  const maxAttempts = positiveInteger(
    env.GATEWAY_MAX_ATTEMPTS,
    "GATEWAY_MAX_ATTEMPTS",
    2,
  );
  if (maxAttempts > 2) throw new TypeError("GATEWAY_MAX_ATTEMPTS must be one or two");
  const upstreamTimeoutMs = positiveInteger(
    env.GATEWAY_UPSTREAM_TIMEOUT_MS,
    "GATEWAY_UPSTREAM_TIMEOUT_MS",
    120_000,
  );
  const maxRequests = positiveInteger(
    env.GATEWAY_MAX_REQUESTS_PER_RUN,
    "GATEWAY_MAX_REQUESTS_PER_RUN",
  );
  const maxTokens = positiveInteger(
    env.GATEWAY_MAX_TOKENS_PER_RUN,
    "GATEWAY_MAX_TOKENS_PER_RUN",
  );
  const maxUsdMicros = parseUsdMicros(
    env.GATEWAY_MAX_USD_PER_RUN,
    "GATEWAY_MAX_USD_PER_RUN",
  );
  if (maxUsdMicros <= 0) {
    throw new TypeError("GATEWAY_MAX_USD_PER_RUN must be greater than zero");
  }
  const runBudgetLimits = Object.freeze({
    maxRequests,
    maxTokens,
    maxUsdMicros,
  });

  const safeSummary = Object.freeze({
    host: "127.0.0.1",
    port,
    logicalModel,
    mode: pinnedAlias === undefined ? "enhanced" : "controlled",
    pinnedAlias: pinnedAlias ?? null,
    lanes: lanes.map(({ safe }) => safe),
    maxAttempts,
    maxOutputTokens,
    defaultOutputTokens,
    upstreamTimeoutMs,
    runBudget: runBudgetLimits,
  });

  return Object.freeze({
    listen: Object.freeze({ host: "127.0.0.1", port }),
    safeSummary,
    getGatewayOptions() {
      return Object.freeze({
        accessToken,
        quotaLanes: lanes.map(({ lane }) => lane),
        upstreams: lanes.map(({ upstream }) => upstream),
        allowedModels: [logicalModel],
        pinnedAlias,
        maxAttempts,
        maxOutputTokens,
        defaultOutputTokens,
        upstreamTimeoutMs,
        runBudgetLimits,
        pricingByAlias: Object.fromEntries(
          lanes.map(({ lane, pricing }) => [lane.alias, pricing]),
        ),
      });
    },
  });
}
