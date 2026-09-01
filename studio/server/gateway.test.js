import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BoundedAuditLog } from "./audit-log.js";
import { createGateway } from "./gateway.js";

const ALLOWED_ORIGIN = "http://localhost:3000";

class MemoryAudit {
  entries = [];
  async initialize() {}
  async write(entry) {
    this.entries.push(entry);
  }
  async flush() {}
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function healthyFetch(url, init = {}) {
  const path = new URL(url).pathname;
  if (init.method === "GET" && path === "/api/tags") return Promise.resolve(jsonResponse({ models: [] }));
  if (init.method === "GET" && path === "/health") return Promise.resolve(jsonResponse({ state: "healthy" }));
  return Promise.resolve(jsonResponse({ response: "ok", done: true }));
}

async function startGateway(options = {}) {
  const audit = options.audit || new MemoryAudit();
  const gateway = await createGateway({
    fetchImpl: options.fetchImpl || healthyFetch,
    sessionToken: "test-session-token-with-enough-entropy",
    audit,
    environment: options.environment || {},
    expertQualifiedProvider: options.expertQualifiedProvider,
    resolveFrontierMode: options.resolveFrontierMode,
    config: {
      port: 0,
      requestTimeoutMs: 250,
      healthTimeoutMs: 100,
      maxJsonBytes: 1024,
      maxStreamBytes: 4096,
      ...options.config,
    },
  });
  const address = await gateway.listen();
  return { gateway, audit, baseUrl: `http://127.0.0.1:${address.port}` };
}

function authHeaders(extra = {}) {
  return { authorization: "Bearer test-session-token-with-enough-entropy", "content-type": "application/json", ...extra };
}

test("Frontier model status and routing keep Max locked and Auto truthful before qualification", async (t) => {
  const { gateway, baseUrl, audit } = await startGateway({ expertQualifiedProvider: () => false });
  t.after(() => gateway.close());

  const statusResponse = await fetch(`${baseUrl}/api/frontier/status`, { headers: authHeaders() });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.defaultMode, "auto");
  assert.equal(status.maxQualified, false);
  assert.equal(status.modes.flash.available, true);
  assert.equal(status.modes.auto.available, true);
  assert.equal(status.modes.max.available, false);
  assert.equal(status.models.flash.model, "frontier-qwen2.5-coder-14b-8k");

  const privatePrompt = "debug a private multi-file concurrency problem";
  const autoResponse = await fetch(`${baseUrl}/api/frontier/resolve-mode`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ mode: "auto", prompt: privatePrompt }),
  });
  assert.equal(autoResponse.status, 200);
  const auto = await autoResponse.json();
  assert.equal(auto.mode, "auto");
  assert.equal(auto.profile, "local");
  assert.equal(auto.reason, "expert_pending_qualification");
  assert.equal(auto.model, "frontier-qwen2.5-coder-14b-8k");
  assert.equal(JSON.stringify(audit.entries).includes(privatePrompt), false);

  const maxResponse = await fetch(`${baseUrl}/api/frontier/resolve-mode`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ mode: "max", prompt: "implement feature" }),
  });
  assert.equal(maxResponse.status, 409);
  assert.equal((await maxResponse.json()).error.code, "MODEL_MODE_LOCKED");
});

test("health is public, session bootstrap is origin-bound, and proxy routes require auth", async (t) => {
  const { gateway, baseUrl } = await startGateway();
  t.after(() => gateway.close());

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.state, "healthy");
  assert.equal(health.gateway.bind, "127.0.0.1");
  assert.equal("token" in health.gateway, false);

  const noOrigin = await fetch(`${baseUrl}/session`, { method: "POST" });
  assert.equal(noOrigin.status, 403);
  assert.equal((await noOrigin.json()).error.code, "ORIGIN_REQUIRED");

  const wrongOrigin = await fetch(`${baseUrl}/session`, { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await wrongOrigin.json()).error.code, "ORIGIN_FORBIDDEN");

  const sessionResponse = await fetch(`${baseUrl}/session`, { method: "POST", headers: { origin: ALLOWED_ORIGIN } });
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json()).token, gateway.sessionToken);

  const unauthenticated = await fetch(`${baseUrl}/ollama/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "devstral", prompt: "hello" }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error.code, "AUTH_REQUIRED");
});

test("workspace endpoints expose a bounded real tree and safe file reads", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "frontier-workspace-"));
  await mkdir(join(workspaceRoot, "src"));
  await mkdir(join(workspaceRoot, "node_modules"));
  await writeFile(join(workspaceRoot, "src", "App.tsx"), "export const ready = true;\n");
  await writeFile(join(workspaceRoot, "node_modules", "hidden.js"), "secret\n");
  const { gateway, baseUrl } = await startGateway({ config: { workspaceRoot } });
  t.after(() => gateway.close());

  const treeResponse = await fetch(`${baseUrl}/api/workspace/tree`, { headers: authHeaders() });
  assert.equal(treeResponse.status, 200);
  const tree = await treeResponse.json();
  assert.equal(tree.files.some((item) => item.name === "src"), true);
  assert.equal(tree.files.some((item) => item.name === "node_modules"), false);

  const fileResponse = await fetch(`${baseUrl}/api/workspace/file`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ path: "src/App.tsx" }),
  });
  assert.equal(fileResponse.status, 200);
  const file = await fileResponse.json();
  assert.equal(file.encoding, "utf8");
  assert.equal(file.content, "export const ready = true;\n");

  const escapeResponse = await fetch(`${baseUrl}/api/workspace/file`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ path: "../outside.txt" }),
  });
  assert.equal(escapeResponse.status, 400);
  assert.equal((await escapeResponse.json()).error.code, "WORKSPACE_PATH_ESCAPE");
});

test("workspace edits are authenticated, atomic, version-checked, and path bounded", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "frontier-workspace-edit-"));
  await mkdir(join(workspaceRoot, "src"));
  await writeFile(join(workspaceRoot, "src", "App.tsx"), "export const version = 1;\n");
  const { gateway, baseUrl, audit } = await startGateway({ config: { workspaceRoot, workspaceMaxFileBytes: 4_096 } });
  t.after(() => gateway.close());

  const initialResponse = await fetch(`${baseUrl}/api/workspace/file`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ path: "src/App.tsx" }),
  });
  const initial = await initialResponse.json();

  const writeResponse = await fetch(`${baseUrl}/api/workspace/write`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ path: "src/App.tsx", content: "export const version = 2;\n", expectedModified: initial.modified }),
  });
  assert.equal(writeResponse.status, 200);
  assert.equal((await writeResponse.json()).content, "export const version = 2;\n");
  assert.equal(await readFile(join(workspaceRoot, "src", "App.tsx"), "utf8"), "export const version = 2;\n");
  assert.equal((await readdir(join(workspaceRoot, "src"))).some((name) => name.startsWith(".frontier-")), false);
  assert.equal(audit.entries.some((entry) => entry.event === "workspace-file-written" && entry.path === "src/App.tsx"), true);

  const staleResponse = await fetch(`${baseUrl}/api/workspace/write`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ path: "src/App.tsx", content: "stale\n", expectedModified: initial.modified }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error.code, "WORKSPACE_FILE_CONFLICT");

  const createResponse = await fetch(`${baseUrl}/api/workspace/write`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ path: "src/new-file.ts", content: "export const created = true;\n", expectedModified: null }),
  });
  assert.equal(createResponse.status, 200);
  assert.equal(await readFile(join(workspaceRoot, "src", "new-file.ts"), "utf8"), "export const created = true;\n");

  const duplicateCreate = await fetch(`${baseUrl}/api/workspace/write`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ path: "src/new-file.ts", content: "overwrite\n", expectedModified: null }),
  });
  assert.equal(duplicateCreate.status, 409);
  assert.equal((await duplicateCreate.json()).error.code, "WORKSPACE_FILE_CONFLICT");

  const escapeResponse = await fetch(`${baseUrl}/api/workspace/write`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ path: "../outside.ts", content: "unsafe\n" }),
  });
  assert.equal(escapeResponse.status, 400);
  assert.equal((await escapeResponse.json()).error.code, "WORKSPACE_PATH_ESCAPE");
});

test("health reports a dependency outage as degraded without claiming gateway failure", async (t) => {
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === "/api/tags") return jsonResponse({ models: [{ name: "devstral" }] });
    throw new TypeError("connection refused");
  };
  const { gateway, baseUrl } = await startGateway({ fetchImpl });
  t.after(() => gateway.close());

  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(health.state, "degraded");
  assert.equal(health.gateway.state, "healthy");
  assert.equal(health.dependencies.ollama.state, "healthy");
  assert.equal(health.dependencies.teminaliCutMcp.state, "offline");
});

test("Ollama generate streams bytes and records metadata without prompt content", async (t) => {
  let forwarded;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/tags" || path === "/health") return healthyFetch(url, { method: "GET" });
    forwarded = { path, method: init.method, body: init.body };
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"response":"A","done":false}\n'));
        controller.enqueue(new TextEncoder().encode('{"response":"B","done":true}\n'));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
  };
  const { gateway, baseUrl, audit } = await startGateway({ fetchImpl });
  t.after(() => gateway.close());

  const secretPrompt = "private-prompt-that-must-not-be-logged";
  const response = await fetch(`${baseUrl}/api/ollama/generate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "devstral", prompt: secretPrompt, stream: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"response":"A","done":false}\n{"response":"B","done":true}\n');
  assert.equal(forwarded.path, "/api/generate");
  assert.equal(JSON.parse(forwarded.body).prompt, secretPrompt);
  assert.equal(JSON.stringify(audit.entries).includes(secretPrompt), false);
  assert.ok(audit.entries.some((entry) => entry.event === "response" && entry.provider === "ollama"));
});

test("malformed provider JSON becomes a structured retryable error", async (t) => {
  const fetchImpl = async () => new Response("not-json", { headers: { "content-type": "application/json" } });
  const { gateway, baseUrl } = await startGateway({ fetchImpl });
  t.after(() => gateway.close());

  const response = await fetch(`${baseUrl}/ollama/generate`, {
    method: "POST",
    headers: authHeaders({ "x-correlation-id": "malformed-case" }),
    body: JSON.stringify({ model: "devstral", prompt: "hello", stream: false }),
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, "MALFORMED_UPSTREAM_RESPONSE");
  assert.equal(body.error.retryable, true);
  assert.equal(body.error.correlationId, "malformed-case");
});

test("provider offline and rate-limit failures are classified without exposing response bodies", async (t) => {
  let mode = "offline";
  const fetchImpl = async () => {
    if (mode === "offline") throw new TypeError("connection refused with private machine details");
    return new Response("provider-internal-secret", { status: 429, headers: { "content-type": "text/plain" } });
  };
  const { gateway, baseUrl } = await startGateway({ fetchImpl });
  t.after(() => gateway.close());
  const request = () => fetch(`${baseUrl}/ollama/generate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "devstral", prompt: "hello" }),
  });

  const offline = await request();
  assert.equal(offline.status, 503);
  const offlineBody = await offline.json();
  assert.equal(offlineBody.error.code, "PROVIDER_OFFLINE");
  assert.equal(offlineBody.error.retryable, true);
  assert.equal(JSON.stringify(offlineBody).includes("private machine details"), false);

  mode = "limited";
  const limited = await request();
  assert.equal(limited.status, 429);
  const limitedBody = await limited.json();
  assert.equal(limitedBody.error.code, "UPSTREAM_REJECTED");
  assert.equal(limitedBody.error.retryable, true);
  assert.equal(JSON.stringify(limitedBody).includes("provider-internal-secret"), false);
});

test("well-formed JSON with the wrong provider schema is rejected", async (t) => {
  const fetchImpl = async () => jsonResponse({ plausible: "but not an Ollama result" });
  const { gateway, baseUrl } = await startGateway({ fetchImpl });
  t.after(() => gateway.close());

  const response = await fetch(`${baseUrl}/ollama/chat`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "devstral", messages: [{ role: "user", content: "hello" }], stream: false }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "MALFORMED_UPSTREAM_RESPONSE");
});

test("Anthropic uses only the process configuration key and does not expose it", async (t) => {
  let receivedHeaders;
  const fetchImpl = async (_url, init = {}) => {
    receivedHeaders = new Headers(init.headers);
    return jsonResponse({ id: "msg_test", type: "message", content: [], usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const apiKey = "environment-secret-key";
  const { gateway, baseUrl, audit } = await startGateway({ environment: { ANTHROPIC_API_KEY: apiKey }, fetchImpl });
  t.after(() => gateway.close());

  const response = await fetch(`${baseUrl}/anthropic/v1/messages`, {
    method: "POST",
    headers: authHeaders({ "x-api-key": "attacker-controlled-key" }),
    body: JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }),
  });
  assert.equal(response.status, 200);
  assert.equal(receivedHeaders.get("x-api-key"), apiKey);
  assert.equal(JSON.stringify(audit.entries).includes(apiKey), false);
  assert.equal(response.headers.get("x-api-key"), null);
});

test("MCP health gating prevents calls while offline and validates JSON-RPC responses", async (t) => {
  let mutations = 0;
  let online = false;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (init.method === "GET" && path === "/health") {
      if (!online) throw new TypeError("offline");
      return jsonResponse({ state: "healthy" });
    }
    mutations += 1;
    return jsonResponse({ jsonrpc: "2.0", id: 7, result: { applied: true } });
  };
  const { gateway, baseUrl } = await startGateway({ fetchImpl });
  t.after(() => gateway.close());
  const request = () => fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "timeline.apply", params: {} }),
  });

  const unavailable = await request();
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "MCP_OFFLINE");
  assert.equal(mutations, 0);

  online = true;
  const available = await request();
  assert.equal(available.status, 200);
  assert.deepEqual(await available.json(), { jsonrpc: "2.0", id: 7, result: { applied: true } });
  assert.equal(mutations, 1);
});

test("request timeout aborts the provider and returns a structured 504", async (t) => {
  let upstreamAborted = false;
  const fetchImpl = async (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      upstreamAborted = true;
      reject(init.signal.reason);
    }, { once: true });
  });
  const { gateway, baseUrl } = await startGateway({ fetchImpl, config: { requestTimeoutMs: 20 } });
  t.after(() => gateway.close());

  const response = await fetch(`${baseUrl}/ollama/chat`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "devstral", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.error.code, "UPSTREAM_TIMEOUT");
  assert.equal(body.error.retryable, true);
  assert.equal(upstreamAborted, true);
});

test("client disconnect propagates cancellation to the provider", async (t) => {
  let markAborted;
  const aborted = new Promise((resolve) => {
    markAborted = resolve;
  });
  const fetchImpl = async (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      markAborted();
      reject(init.signal.reason);
    }, { once: true });
  });
  const { gateway, baseUrl, audit } = await startGateway({ fetchImpl, config: { requestTimeoutMs: 2_000 } });
  t.after(() => gateway.close());

  const controller = new AbortController();
  const pending = fetch(`${baseUrl}/ollama/chat`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "devstral", messages: [{ role: "user", content: "hello" }] }),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: "AbortError" });
  await Promise.race([
    aborted,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("provider was not cancelled")), 500)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(audit.entries.some((entry) => entry.errorCode === "CLIENT_CANCELLED" && entry.cancelled === true));
});

test("bounded parsing rejects oversized request bodies", async (t) => {
  const { gateway, baseUrl } = await startGateway({ config: { maxJsonBytes: 80, maxOllamaJsonBytes: 80 } });
  t.after(() => gateway.close());

  const response = await fetch(`${baseUrl}/ollama/generate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "devstral", prompt: "x".repeat(200) }),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "PAYLOAD_TOO_LARGE");
});

test("Ollama image requests have a separate bounded allowance without widening other JSON ingress", async (t) => {
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (init.method === "GET" && path === "/api/tags") return jsonResponse({ models: [] });
    if (init.method === "GET" && path === "/health") return jsonResponse({ state: "healthy" });
    return jsonResponse({ message: { content: "image inspected" }, done: true });
  };
  const { gateway, baseUrl } = await startGateway({
    fetchImpl,
    config: { maxJsonBytes: 80, maxOllamaJsonBytes: 512 },
  });
  t.after(() => gateway.close());

  const ollamaResponse = await fetch(`${baseUrl}/ollama/chat`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "vision", messages: [{ role: "user", content: "inspect", images: ["a".repeat(180)] }], stream: false }),
  });
  assert.equal(ollamaResponse.status, 200);

  const auditResponse = await fetch(`${baseUrl}/api/audit`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ event: "model_call", provider: "ollama", note: "a".repeat(180) }),
  });
  assert.equal(auditResponse.status, 413);
  assert.equal((await auditResponse.json()).error.code, "PAYLOAD_TOO_LARGE");
});

test("client audit ingress accepts bounded metadata and rejects arbitrary content", async (t) => {
  const { gateway, baseUrl, audit } = await startGateway();
  t.after(() => gateway.close());

  const accepted = await fetch(`${baseUrl}/api/audit`, {
    method: "POST",
    headers: authHeaders({ "x-correlation-id": "client-trace-1" }),
    body: JSON.stringify({ event: "model_call", provider: "ollama", status: 200, durationMs: 42.5, responseBytes: 128 }),
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: true, correlationId: "client-trace-1" });
  assert.ok(audit.entries.some((entry) => entry.event === "model_call" && entry.provider === "ollama" && entry.durationMs === 42.5));

  const rejected = await fetch(`${baseUrl}/api/audit`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ event: "prompt", content: "private source code" }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, "INVALID_REQUEST");
  assert.equal(JSON.stringify(audit.entries).includes("private source code"), false);
});

test("persistent audit log rotates and stores only its allowlisted metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "frontier-gateway-audit-"));
  const path = join(directory, "gateway-audit.jsonl");
  const audit = new BoundedAuditLog(path, { maxBytes: 180, maxFiles: 2 });
  await audit.initialize();
  for (let index = 0; index < 8; index += 1) {
    await audit.write({ event: "response", correlationId: `case-${index}`, status: 200, secret: "must-never-persist" });
  }
  await audit.flush();

  const files = await readdir(directory);
  assert.ok(files.includes("gateway-audit.jsonl"));
  assert.ok(files.some((file) => file.startsWith("gateway-audit.jsonl.")));
  const contents = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
  assert.equal(contents.join("").includes("must-never-persist"), false);
});
