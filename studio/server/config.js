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
    // VibeVoice sidecar. Optional: absent means the studio falls back to the
    // browser speech engine rather than losing voice altogether.
    voiceUrl: loopbackUrl(environment.TEMINALI_VOICE_URL, "http://127.0.0.1:8321", "TEMINALI_VOICE_URL"),
    voiceTimeoutMs: positiveInteger(environment.TEMINALI_VOICE_TIMEOUT_MS, 30_000),
    voiceMaxAudioBytes: positiveInteger(environment.TEMINALI_VOICE_MAX_AUDIO_BYTES, 25 * 1024 * 1024),
    anthropicUrl: new URL("https://api.anthropic.com"),
    anthropicApiKey: environment.ANTHROPIC_API_KEY || "",
    requestTimeoutMs: positiveInteger(environment.FRONTIER_REQUEST_TIMEOUT_MS, 600_000),
    healthTimeoutMs: positiveInteger(environment.FRONTIER_HEALTH_TIMEOUT_MS, 1_500),
    maxJsonBytes: positiveInteger(environment.FRONTIER_MAX_JSON_BYTES, 1024 * 1024),
    maxOllamaJsonBytes: positiveInteger(environment.FRONTIER_MAX_OLLAMA_JSON_BYTES, 8 * 1024 * 1024),
    // An agent turn may carry attached images, and base64 is a third larger
    // than the bytes it encodes. The attachment policy allows 5 MB of image;
    // the 1 MB general cap would refuse that as a malformed request long
    // before anything could say why. See server/agent-attachments.js.
    maxAgentJsonBytes: positiveInteger(environment.FRONTIER_MAX_AGENT_JSON_BYTES, 12 * 1024 * 1024),
    maxStreamBytes: positiveInteger(environment.FRONTIER_MAX_STREAM_BYTES, 64 * 1024 * 1024),
    workspaceRoot: resolve(environment.FRONTIER_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT),
    workspaceMaxFileBytes: positiveInteger(environment.FRONTIER_WORKSPACE_MAX_FILE_BYTES, 8 * 1024 * 1024),
    terminalTimeoutMs: positiveInteger(environment.FRONTIER_TERMINAL_TIMEOUT_MS, 120_000),
    terminalMaxOutputBytes: positiveInteger(environment.FRONTIER_TERMINAL_MAX_OUTPUT_BYTES, 1024 * 1024),
    auditPath: resolve(environment.FRONTIER_AUDIT_PATH || resolve(process.cwd(), "benchmark-results", "gateway-audit.jsonl")),
    projectsStorePath: resolve(environment.FRONTIER_PROJECTS_STORE || resolve(process.cwd(), "benchmark-results", "recent-projects.json")),
    // The browser panel's bookmarks, history and downloads. In the gateway
    // rather than the renderer so the agent routes can read them too.
    browserStorePath: resolve(environment.TEMINALI_BROWSER_STORE || resolve(process.cwd(), "benchmark-results", "browser-data.json")),
    // What Temi remembers about him between sessions. In the gateway rather
    // than the renderer because this is meant to last years and localStorage
    // is cleared by things unrelated to wanting to be forgotten. Written
    // 0600; read once before live.connect, written once after. See
    // server/temi-memory.js.
    temiMemoryStorePath: resolve(environment.TEMINALI_MEMORY_STORE || resolve(process.cwd(), "benchmark-results", "temi-memory.json")),
    // Hosted-provider API keys. Written 0600; never returned to the renderer.
    providerStorePath: resolve(environment.TEMINALI_PROVIDER_STORE || resolve(process.cwd(), "benchmark-results", "provider-keys.json")),
    guardianStorePath: resolve(environment.TEMINALI_GUARDIAN_STORE || resolve(process.cwd(), "benchmark-results", "guardian-settings.json")),
    // What each agent CLI actually resolved a model alias to, learned from the
    // CLI's own init event and remembered so the picker can stop guessing.
    agentModelStorePath: resolve(environment.TEMINALI_AGENT_MODEL_STORE || resolve(process.cwd(), "benchmark-results", "agent-models.json")),
    // Where the screen assistant writes the frame it just looked at. Pruned to
    // the last handful: it is a photograph of the operator's screen and has no
    // reason to accumulate.
    assistantFramePath: resolve(environment.TEMINALI_ASSISTANT_FRAMES || resolve(process.cwd(), "benchmark-results", "assistant-frames")),
    // Append-only record of what every turn cost, read back by the usage panel.
    usageLedgerPath: resolve(environment.TEMINALI_USAGE_LEDGER || resolve(process.cwd(), "benchmark-results", "usage-ledger.jsonl")),
    // The plan windows the agent CLI last reported. One file, not one per
    // workspace: the headroom belongs to the account, not to the project.
    planStorePath: resolve(environment.TEMINALI_PLAN_STORE || resolve(process.cwd(), "benchmark-results", "plan-limits.json")),
    // The signed Pro licence, and where it is renewed from. One file for the
    // same reason the plan windows are one file: the subscription belongs to
    // the account, not to the project. Written 0600 — see server/licence.js.
    licenceStorePath: resolve(environment.TEMINALI_LICENCE_STORE || resolve(process.cwd(), "benchmark-results", "licence.json")),
    // Empty by default: a checkout that has never been pointed at a billing
    // service runs as free rather than failing, which is what makes the free
    // lanes work with no account at all.
    billingBaseUrl: environment.TEMINALI_BILLING_URL || null,
    // Who may run privileged tools. TEMINALI_ADMINS additionally pins logins
    // that no API call can remove.
    adminStorePath: resolve(environment.TEMINALI_ADMIN_STORE || resolve(process.cwd(), "benchmark-results", "admins.json")),
    // The studio ships itself, and it does so out of two repositories.
    // `appRoot` is this package — the thing that gets built. `sourceRepo` is
    // where the code and .github/workflows/release.yml live, and it is private.
    // `releaseRepo` is the public repository the built artefacts are published
    // to and read back from: an update check runs on every install with no
    // credential, so the repository it asks has to be one an anonymous caller
    // can see. A private repository answers 404, which the updater can only
    // report as "this repository has no releases yet".
    appRoot: resolve(environment.TEMINALI_APP_ROOT || process.cwd()),
    releaseRepo: environment.TEMINALI_RELEASE_REPO || "teminali/releases",
    sourceRepo: environment.TEMINALI_SOURCE_REPO || "teminali/teminali-os",
    // Every benchmark that has been run. Diffs are not kept; see arena.js.
    arenaHistoryPath: resolve(environment.TEMINALI_ARENA_HISTORY || resolve(process.cwd(), "benchmark-results", "arena-runs.jsonl")),
    // "local" runs Ollama models; "api" routes to a hosted provider.
    defaultRuntimeMode: environment.TEMINALI_RUNTIME_MODE === "api" ? "api" : "local",
    auditMaxBytes: positiveInteger(environment.FRONTIER_AUDIT_MAX_BYTES, 2 * 1024 * 1024),
    auditMaxFiles: positiveInteger(environment.FRONTIER_AUDIT_MAX_FILES, 3),
    ...overrides,
  };
  if (config.host !== "127.0.0.1") throw new Error("The gateway host is fixed to 127.0.0.1.");
  for (const origin of config.allowedOrigins) loopbackOrigin(origin);
  return config;
}
