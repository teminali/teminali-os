import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WORKSPACE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loopbackUrl(value, fallback, label) {
  const url = new URL(value || fallback);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error(`${label} must be an http:// loopback URL.`);
  }
  return url;
}

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error(`Allowed origin must be an exact http:// loopback origin: ${value}`);
  }
  return url.origin;
}

export function createConfig(environment = process.env, overrides = {}) {
  const origins = (environment.FRONTIER_ALLOWED_ORIGINS || "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:3001,http://localhost:3001")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(loopbackOrigin);

  const config = {
    host: "127.0.0.1",
    port: positiveInteger(environment.FRONTIER_GATEWAY_PORT, 4310),
    allowedOrigins: new Set(origins),
    ollamaUrl: loopbackUrl(environment.OLLAMA_BASE_URL, "http://127.0.0.1:11434", "OLLAMA_BASE_URL"),
    mcpUrl: loopbackUrl(environment.TEMINALI_CUT_MCP_URL || environment.KERF_MCP_URL, "http://127.0.0.1:3888", "TEMINALI_CUT_MCP_URL"),
    anthropicUrl: new URL("https://api.anthropic.com"),
    anthropicApiKey: environment.ANTHROPIC_API_KEY || "",
    requestTimeoutMs: positiveInteger(environment.FRONTIER_REQUEST_TIMEOUT_MS, 600_000),
    healthTimeoutMs: positiveInteger(environment.FRONTIER_HEALTH_TIMEOUT_MS, 1_500),
    maxJsonBytes: positiveInteger(environment.FRONTIER_MAX_JSON_BYTES, 1024 * 1024),
    maxOllamaJsonBytes: positiveInteger(environment.FRONTIER_MAX_OLLAMA_JSON_BYTES, 8 * 1024 * 1024),
    maxStreamBytes: positiveInteger(environment.FRONTIER_MAX_STREAM_BYTES, 64 * 1024 * 1024),
    workspaceRoot: resolve(environment.FRONTIER_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT),
    workspaceMaxFileBytes: positiveInteger(environment.FRONTIER_WORKSPACE_MAX_FILE_BYTES, 8 * 1024 * 1024),
    auditPath: resolve(process.cwd(), "benchmark-results", "gateway-audit.jsonl"),
    auditMaxBytes: positiveInteger(environment.FRONTIER_AUDIT_MAX_BYTES, 2 * 1024 * 1024),
    auditMaxFiles: positiveInteger(environment.FRONTIER_AUDIT_MAX_FILES, 3),
    ...overrides,
  };
  if (config.host !== "127.0.0.1") throw new Error("The gateway host is fixed to 127.0.0.1.");
  for (const origin of config.allowedOrigins) loopbackOrigin(origin);
  return config;
}
