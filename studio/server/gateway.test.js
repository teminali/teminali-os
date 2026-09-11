import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
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
      // No test wants a 2 GB Python pipeline spawned underneath it. Adoption of
      // an already-running one is still exercised, since that costs nothing.
      realtimeVoiceAutostart: false,
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

test("a Frontier lane is available when its model is installed, and when only its source is", async (t) => {
  /*
    Two ways a lane can work. The derived model may be installed outright, or
    only the source it is built from — `frontier-runner.js` creates the derived
    model from the source on demand, so a present source is a lane that works
    after one create. Both count; nothing else does.
  */
  const withModels = (names) => (url, init = {}) => {
    if (new URL(url).pathname === "/api/tags") {
      return Promise.resolve(jsonResponse({ models: names.map((name) => ({ name })) }));
    }
    return healthyFetch(url, init);
  };

  const derived = await startGateway({ fetchImpl: withModels(["frontier-qwen2.5-coder-14b-8k"]) });
  t.after(() => derived.gateway.close());
  const a = await (await fetch(`${derived.baseUrl}/api/frontier/status`, { headers: authHeaders() })).json();
  assert.equal(a.modes.flash.available, true);
  assert.equal(a.modes.auto.available, true);
  assert.equal(a.modes.flash.reason, undefined);

  const sourceOnly = await startGateway({ fetchImpl: withModels(["qwen2.5-coder:14b-instruct"]) });
  t.after(() => sourceOnly.gateway.close());
  const b = await (await fetch(`${sourceOnly.baseUrl}/api/frontier/status`, { headers: authHeaders() })).json();
  assert.equal(b.modes.flash.available, true);

  // A model that is neither is not a near miss.
  const unrelated = await startGateway({ fetchImpl: withModels(["temi:r2"]) });
  t.after(() => unrelated.gateway.close());
  const c = await (await fetch(`${unrelated.baseUrl}/api/frontier/status`, { headers: authHeaders() })).json();
  assert.equal(c.modes.flash.available, false);
});

test("Frontier model status and routing keep Max locked and Auto truthful before qualification", async (t) => {
  const { gateway, baseUrl, audit } = await startGateway({ expertQualifiedProvider: () => false });
  t.after(() => gateway.close());

  const statusResponse = await fetch(`${baseUrl}/api/frontier/status`, { headers: authHeaders() });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.defaultMode, "auto");
  assert.equal(status.maxQualified, false);
  // The harness's Ollama has no models, so no lane can answer — and saying so
  // is the point. `available` was the literal `true` here until 2026-09-10,
  // which is how an operator spent an evening on a composer that could not
  // reply: the derived model had been deleted and the interface still said
  // "Frontier Auto is ready".
  assert.equal(status.modes.flash.available, false);
  assert.equal(status.modes.auto.available, false);
  assert.equal(status.modes.max.available, false);
  assert.match(status.modes.flash.reason, /ollama pull qwen2\.5-coder:14b-instruct/);
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

test("about names the build and needs a bearer to do it", async (t) => {
  const { gateway, baseUrl } = await startGateway();
  t.after(() => gateway.close());

  /* The disclosure is not privileged, but nothing outside the session gets to
     enumerate the machine's runtime versions either. */
  const unauthenticated = await fetch(`${baseUrl}/api/about`);
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error.code, "AUTH_REQUIRED");

  const response = await fetch(`${baseUrl}/api/about`, { headers: authHeaders() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.app.name, "Teminali OS");
  assert.equal(body.app.platform, process.platform);
  /* Under the test runner there is no `<Resources>`, and the honest answer is
     that this build carries nothing — not an error, and not a claim. */
  assert.equal(body.mediaStack.bundled, false);
  assert.deepEqual(body.mediaStack.components, []);

  const missing = await fetch(`${baseUrl}/api/about/licence?bundle=ffmpeg&file=COPYING`, { headers: authHeaders() });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "LICENCE_NOT_FOUND");
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

test("terminal execution requires auth, runs for real, and streams a true exit status", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "frontier-terminal-route-"));
  await writeFile(join(workspaceRoot, "hello.txt"), "from disk\n");
  const { gateway, baseUrl } = await startGateway({ config: { workspaceRoot } });
  t.after(() => gateway.close());

  const unauthenticated = await fetch(`${baseUrl}/api/terminal/exec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "cat hello.txt" }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error.code, "AUTH_REQUIRED");

  const response = await fetch(`${baseUrl}/api/terminal/exec`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ command: "cat hello.txt" }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/x-ndjson/);

  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  const stdout = events.filter((event) => event.type === "stdout").map((event) => event.data).join("");
  const exit = events.at(-1);
  assert.equal(stdout, "from disk\n");
  assert.equal(exit.type, "exit");
  assert.equal(exit.code, 0);

  const failing = await fetch(`${baseUrl}/api/terminal/exec`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ command: "cat nope.txt" }),
  });
  const failingEvents = (await failing.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.notEqual(failingEvents.at(-1).code, 0);

  const escaped = await fetch(`${baseUrl}/api/terminal/exec`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ command: "pwd", cwd: "../../.." }),
  });
  const escapedEvents = (await escaped.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(escapedEvents.at(-1).reason, "TERMINAL_CWD_ESCAPE");

  const empty = await fetch(`${baseUrl}/api/terminal/exec`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ command: "   " }),
  });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, "TERMINAL_COMMAND_REQUIRED");
});

test("projects can be opened, remembered, and rebound the workspace root", async (t) => {
  // realpath: the gateway resolves symlinks when binding a root (on macOS the
  // temp dir is /var -> /private/var), so compare against the resolved path.
  const projectA = await realpath(await mkdtemp(join(tmpdir(), "frontier-projA-")));
  const projectB = await realpath(await mkdtemp(join(tmpdir(), "frontier-projB-")));
  await writeFile(join(projectA, "a.txt"), "A\n");
  await writeFile(join(projectB, "b.txt"), "B\n");
  const store = join(await mkdtemp(join(tmpdir(), "frontier-store-")), "recent.json");

  const { gateway, baseUrl } = await startGateway({ config: { workspaceRoot: projectA, projectsStorePath: store } });
  t.after(() => gateway.close());

  const initial = await (await fetch(`${baseUrl}/api/workspace/projects`, { headers: authHeaders() })).json();
  assert.equal(initial.current.path, projectA);
  assert.deepEqual(initial.recent, []);

  // Opening B rebinds the root: the tree and the terminal both follow it.
  const opened = await fetch(`${baseUrl}/api/workspace/open`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ path: projectB }),
  });
  assert.equal(opened.status, 200);
  const payload = await opened.json();
  assert.equal(payload.current.path, projectB);
  assert.equal(payload.recent[0].path, projectB);

  const tree = await (await fetch(`${baseUrl}/api/workspace/tree`, { headers: authHeaders() })).json();
  assert.equal(tree.files.some((file) => file.name === "b.txt"), true);
  assert.equal(tree.files.some((file) => file.name === "a.txt"), false);

  const pwd = await fetch(`${baseUrl}/api/terminal/exec`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ command: "ls" }),
  });
  const events = (await pwd.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.match(events.filter((e) => e.type === "stdout").map((e) => e.data).join(""), /b\.txt/);

  // Recent list persists and de-duplicates, newest first.
  await fetch(`${baseUrl}/api/workspace/open`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ path: projectA }) });
  const again = await fetch(`${baseUrl}/api/workspace/open`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ path: projectB }) });
  const recent = (await again.json()).recent;
  assert.equal(recent[0].path, projectB);
  assert.equal(recent.filter((entry) => entry.path === projectB).length, 1);

  const forgotten = await fetch(`${baseUrl}/api/workspace/projects/forget`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ path: projectA }),
  });
  assert.equal((await forgotten.json()).recent.some((entry) => entry.path === projectA), false);
});

test("an unopenable or over-broad project root is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frontier-projC-"));
  await writeFile(join(root, "file.txt"), "x\n");
  const store = join(root, "recent.json");
  const { gateway, baseUrl } = await startGateway({ config: { workspaceRoot: root, projectsStorePath: store } });
  t.after(() => gateway.close());

  const open = (path) => fetch(`${baseUrl}/api/workspace/open`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ path }),
  });

  assert.equal((await open(join(root, "does-not-exist"))).status, 404);
  assert.equal((await open(join(root, "file.txt"))).status, 400);
  // The filesystem root would expose the whole machine to workspace routes.
  const broad = await open("/");
  assert.equal(broad.status, 400);
  assert.equal((await broad.json()).error.code, "PROJECT_ROOT_TOO_BROAD");
  assert.equal((await open("")).status, 400);
});

/* ── The player and the series, over the wire ──────────────────────────────
   The unit tests for these live in tests/player-state.test.mjs and
   tests/workspace-series.test.mjs; what is worth proving here is the wiring:
   that a folder of videos is opened as a series rather than refused, that the
   snapshot the window publishes is what the agent's `player` reads back, and
   that a command with nothing playing fails as a sentence rather than being
   dropped into a stream nobody is reading. */

async function videoWorkspace(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "player-gateway-")));
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body);
  return root;
}

test("any folder opens as a gallery, and one full of videos says it is a series", async (t) => {
  const { openRun, closeRun } = await import("./permission-bridge.js");
  const root = await videoWorkspace({});
  await mkdir(join(root, "Show"), { recursive: true });
  await writeFile(join(root, "Show", "Episode 1.mkv"), "x");
  await writeFile(join(root, "Show", "Episode 2.mkv"), "x");
  await mkdir(join(root, "Notes"), { recursive: true });
  await writeFile(join(root, "Notes", "clip.mp4"), "x");

  const { gateway, baseUrl } = await startGateway({ config: { workspaceRoot: root } });
  t.after(() => gateway.close());

  const seen = [];
  const token = openRun("run-series", (event) => seen.push(event));
  t.after(() => closeRun("run-series"));

  const open = async (path) => fetch(`${baseUrl}/api/workspace/agent/open-file`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-teminali-workspace-token": token },
    body: JSON.stringify({ runId: "run-series", path }),
  });

  const series = await open("Show");
  assert.equal(series.status, 200);
  const body = await series.json();
  assert.equal(body.result.series, true);
  assert.equal(body.result.videos, 2);
  assert.match(body.result.note, /episode/);
  assert.deepEqual(seen.at(-1), { type: "workspace", action: "open-folder", path: "Show" });

  /*
    A folder that is not a series still opens: every folder is a gallery, and
    the note says which of the two it is, because "start episode 3" and "here
    are the files" are different next moves for the model.
  */
  const plain = await open("Notes");
  assert.equal(plain.status, 200);
  const plainBody = await plain.json();
  assert.equal(plainBody.result.series, false);
  assert.match(plainBody.result.note, /gallery/);
  assert.deepEqual(seen.at(-1), { type: "workspace", action: "open-folder", path: "Notes" });

  // A symlink is still refused, so the one thing the reader will not open is
  // not quietly opened by the folder path.
  const missing = await open("Nowhere");
  assert.equal(missing.status, 404);
});

test("the window publishes what its player is showing, and the agent reads it back", async (t) => {
  const { openRun, closeRun } = await import("./permission-bridge.js");
  const { gateway, baseUrl } = await startGateway();
  t.after(() => gateway.close());

  const seen = [];
  const token = openRun("run-player", (event) => seen.push(event));
  t.after(() => closeRun("run-player"));

  const ask = async (route, body) => fetch(`${baseUrl}/api/workspace/agent/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-teminali-workspace-token": token },
    body: JSON.stringify({ runId: "run-player", ...body }),
  });

  // Nothing open: a command is a refusal that names the way out, not silence.
  const early = await ask("player-control", { action: "pause" });
  assert.equal(early.status, 409);
  assert.match((await early.json()).error.message, /open_file/);

  const publish = await fetch(`${baseUrl}/api/workspace/player/state`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      player: {
        view: "player", path: "Show/Episode 2.mkv", title: "Episode 2", kind: "video",
        playing: true, time: 65, duration: 1800, volume: 1, rate: 1,
        subtitles: { available: ["English"], active: null },
        series: { folder: "Show", title: "Show", index: 2, count: 6, episodes: [] },
      },
    }),
  });
  assert.equal(publish.status, 200);

  const read = await ask("player", {});
  const state = (await read.json()).result;
  assert.equal(state.player.path, "Show/Episode 2.mkv");
  assert.match(state.summary, /episode 2 of 6/);

  const paused = await ask("player-control", { action: "seek", value: 120 });
  assert.equal(paused.status, 200);
  assert.deepEqual(seen.at(-1), { type: "workspace", action: "player", command: { action: "seek", value: 120 } });

  // A value the pane could not act on is refused here, not forwarded.
  const bad = await ask("player-control", { action: "volume", value: 11 });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error.message, /between 0 and 1/);

  // The pane unmounting is a real report, and the agent is told plainly.
  await fetch(`${baseUrl}/api/workspace/player/state`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ player: null }) });
  const empty = await ask("player", {});
  assert.match((await empty.json()).result.summary, /No video or audio is open/);
});

test("attached images are refused with a status code, before the agent stream opens", async (t) => {
  const { gateway, baseUrl } = await startGateway();
  t.after(() => gateway.close());

  // Each of these returns before anything is spawned, which is the point: once
  // the NDJSON header is out the only way left to say no is an error event
  // inside a stream the client has already committed to reading.
  const cases = [
    [["https://example.com/cat.png"], "INVALID_AGENT_IMAGE"],
    [["data:image/gif;base64,R0lGODdh"], "UNSUPPORTED_AGENT_IMAGE"],
    [new Array(5).fill("data:image/png;base64,iVBORw0KGgo="), "TOO_MANY_AGENT_IMAGES"],
    ["not an array", "INVALID_AGENT_IMAGES"],
  ];

  for (const [images, code] of cases) {
    const response = await fetch(`${baseUrl}/api/agents/run`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ engine: "claude", prompt: "look at this", images }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("content-type")?.startsWith("application/json"), true);
    assert.equal((await response.json()).error.code, code);
  }
});

test("an agent turn has its own body allowance without widening other JSON ingress", async (t) => {
  const { gateway, baseUrl } = await startGateway({ config: { maxJsonBytes: 80, maxOllamaJsonBytes: 80, maxAgentJsonBytes: 4096 } });
  t.after(() => gateway.close());

  // Base64 is a third larger than the bytes it encodes, so an attachment that
  // is within the image policy is well past the general 1 MB JSON cap.
  const body = JSON.stringify({ engine: "claude", prompt: "look", images: [`data:image/png;base64,${"A".repeat(900)}`] });
  assert.ok(body.length > 80);

  const accepted = await fetch(`${baseUrl}/api/agents/run`, { method: "POST", headers: authHeaders(), body });
  // Read far enough to be refused on the image's contents rather than on its
  // size: reaching the validator at all is what proves the allowance applied.
  assert.equal(accepted.status, 400);
  assert.equal((await accepted.json()).error.code, "INVALID_AGENT_IMAGE");

  const rejected = await fetch(`${baseUrl}/ollama/generate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "devstral", prompt: "x".repeat(200) }),
  });
  assert.equal(rejected.status, 413);
});

/* ── Model downloads ──────────────────────────────────────────────────────
   These weights are gigabytes. The route used to ask Ollama for
   `stream: false` and hold one request open until the whole pull landed, so
   the UI span a spinner and could not say how far along it was, whether it had
   stalled, or whether it was still alive. What follows asserts the thing that
   replaced it: progress that actually arrives, and failures that arrive as
   frames rather than as a stream that simply stops.
   ──────────────────────────────────────────────────────────────────────── */

/** An Ollama pull response: NDJSON, one frame per line, as a real stream. */
function ollamaPull(lines) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
        controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

/** Every frame the gateway relayed, parsed. */
async function readNdjson(response) {
  return (await response.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

test("a model pull streams progress rather than holding one silent request open", async (t) => {
  const fetchImpl = async (url) => {
    if (String(url).includes("api/pull")) {
      return ollamaPull([
        { status: "pulling manifest" },
        { status: "downloading", digest: "sha256:aaa", completed: 5, total: 10 },
        // The finished frame of a layer is exempt from throttling, so this one
        // has to survive arriving in the same millisecond as the one above.
        { status: "downloading", digest: "sha256:aaa", completed: 10, total: 10 },
        { status: "success" },
      ]);
    }
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };
  const { gateway, baseUrl, audit } = await startGateway({ fetchImpl });
  t.after(() => gateway.close());

  const response = await fetch(`${baseUrl}/api/models/pull`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "qwen2.5-coder:7b" }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/x-ndjson/);

  const events = await readNdjson(response);
  const progress = events.filter((event) => event.type === "progress");
  assert.ok(progress.length >= 2, "no progress reached the client");

  // The layer's last frame is the one a throttle would most likely eat, and
  // the one a progress bar needs in order to ever reach the end.
  const completed = progress.find((event) => event.completed === 10 && event.total === 10);
  assert.ok(completed, "the frame that completes a layer was dropped");
  assert.equal(completed.digest, "sha256:aaa", "the layer digest is not relayed, so a restarting bar is unexplainable");

  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).model, "qwen2.5-coder:7b");
  assert.ok(audit.entries.some((entry) => entry.event === "model-pulled"));
});

test("a pull that fails upstream says so in the stream, not by falling silent", async (t) => {
  const fetchImpl = async (url) => {
    if (String(url).includes("api/pull")) {
      return ollamaPull([{ status: "pulling manifest" }, { error: "model 'nope' not found" }]);
    }
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };
  const { gateway, baseUrl } = await startGateway({ fetchImpl });
  t.after(() => gateway.close());

  const response = await fetch(`${baseUrl}/api/models/pull`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "nope" }),
  });
  // The status is 200 because the headers went out before the failure did:
  // that is what streaming costs, and why the error has to be a frame.
  assert.equal(response.status, 200);
  const events = await readNdjson(response);
  assert.equal(events.at(-1).type, "error");
  assert.match(events.at(-1).message, /not found/);
  assert.ok(!events.some((event) => event.type === "done"), "a failed pull reported itself done");
});

test("a pull still refuses a model name that is not one", async (t) => {
  const { gateway, baseUrl } = await startGateway();
  t.after(() => gateway.close());

  const response = await fetch(`${baseUrl}/api/models/pull`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "   " }),
  });
  // Rejected before any header goes out, so this one is still a real status.
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_MODEL_NAME");
});
