import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createGateway, estimateRequestTokens } from "./http-gateway.js";
import {
  createAnthropicUpstream,
  createGeminiUpstream,
  createGroqUpstream,
} from "./provider-adapters.js";

const ACCESS_TOKEN = "local-test-access-token";
const MODEL = "openai/gpt-oss-120b";

function quotaLane(alias) {
  return {
    alias,
    quotaGroup: alias,
    provider: "groq",
    limits: { rpm: 30, tpm: 8_000, tpd: 200_000 },
  };
}

async function startFakeUpstream(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    endpoint: `http://${address.address}:${address.port}/v1/chat/completions`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function chatRequest(baseUrl, body, accessToken = ACCESS_TOKEN) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("estimates input conservatively and includes requested output", () => {
  const body = { model: MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 256 };
  assert.equal(
    estimateRequestTokens(body),
    Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 3) + 256,
  );
});

test("health is local and does not require credentials", async (t) => {
  const upstream = await startFakeUpstream((_req, res) => res.end());
  t.after(upstream.close);
  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [quotaLane("groq-a")],
    upstreams: [{ alias: "groq-a", endpoint: upstream.endpoint, getSecretHeaders: () => ({}) }],
    allowedModels: [MODEL],
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("rejects unauthorized requests without touching the upstream", async (t) => {
  let hits = 0;
  const upstream = await startFakeUpstream((_req, res) => {
    hits += 1;
    res.end();
  });
  t.after(upstream.close);
  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [quotaLane("groq-a")],
    upstreams: [{ alias: "groq-a", endpoint: upstream.endpoint, getSecretHeaders: () => ({}) }],
    allowedModels: [MODEL],
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await chatRequest(
    url,
    { model: MODEL, messages: [{ role: "user", content: "hello" }] },
    "wrong-access-token",
  );
  assert.equal(response.status, 401);
  assert.equal(hits, 0);
});

test("forwards an allowed request and never logs secrets or prompt content", async (t) => {
  const upstreamSecret = "upstream-secret-value";
  const prompt = "private prompt content";
  const events = [];
  const upstream = await startFakeUpstream(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${upstreamSecret}`);
    const body = await requestBody(req);
    assert.equal(body.messages[0].content, prompt);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "fake", choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  t.after(upstream.close);

  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [quotaLane("groq-a")],
    upstreams: [
      {
        alias: "groq-a",
        endpoint: upstream.endpoint,
        getSecretHeaders: () => ({ authorization: `Bearer ${upstreamSecret}` }),
      },
    ],
    allowedModels: [MODEL],
    logger: (event) => events.push(event),
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await chatRequest(url, {
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 128,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-gateway-lane"), "groq-a");
  assert.equal((await response.json()).choices[0].message.content, "ok");

  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes(upstreamSecret), false);
  assert.equal(serializedEvents.includes(ACCESS_TOKEN), false);
  assert.equal(serializedEvents.includes(prompt), false);
});

test("fails over once on a pre-stream 429 and preserves an SSE response", async (t) => {
  const first = await startFakeUpstream((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
    res.end(JSON.stringify({ error: { message: "limited" } }));
  });
  const expectedStream =
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
  const second = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(expectedStream.slice(0, 24));
    setImmediate(() => res.end(expectedStream.slice(24)));
  });
  t.after(first.close);
  t.after(second.close);

  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [quotaLane("groq-a"), quotaLane("groq-b")],
    upstreams: [
      { alias: "groq-a", endpoint: first.endpoint, getSecretHeaders: () => ({}) },
      { alias: "groq-b", endpoint: second.endpoint, getSecretHeaders: () => ({}) },
    ],
    allowedModels: [MODEL],
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await chatRequest(url, {
    model: MODEL,
    messages: [{ role: "user", content: "stream" }],
    stream: true,
    max_tokens: 128,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-gateway-lane"), "groq-b");
  assert.equal(await response.text(), expectedStream);

  const metricsResponse = await fetch(`${url}/metrics`, {
    headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const metrics = await metricsResponse.json();
  assert.equal(metrics.upstreamAttempts, 2);
  assert.equal(metrics.upstreamRateLimits, 1);
  assert.equal(metrics.failovers, 1);
  assert.equal(metrics.completed, 1);
  assert.ok(metrics.quotas[0].cooldownRemainingMs > 0);
  assert.ok(metrics.quotas[0].cooldownRemainingMs <= 30_000);
});

test("controlled mode does not escape a pinned lane", async (t) => {
  let backupHits = 0;
  const first = await startFakeUpstream((_req, res) => {
    res.writeHead(429, { "retry-after": "10" });
    res.end();
  });
  const second = await startFakeUpstream((_req, res) => {
    backupHits += 1;
    res.end("unexpected");
  });
  t.after(first.close);
  t.after(second.close);

  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [quotaLane("groq-a"), quotaLane("groq-b")],
    upstreams: [
      { alias: "groq-a", endpoint: first.endpoint, getSecretHeaders: () => ({}) },
      { alias: "groq-b", endpoint: second.endpoint, getSecretHeaders: () => ({}) },
    ],
    allowedModels: [MODEL],
    pinnedAlias: "groq-a",
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await chatRequest(url, {
    model: MODEL,
    messages: [{ role: "user", content: "controlled" }],
    max_tokens: 128,
  });
  assert.equal(response.status, 429);
  assert.equal(backupHits, 0);
});

test("returns bounded sanitized provider details for a terminal 429", async (t) => {
  const secret = "sensitive-provider-secret";
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "10" });
    res.end(
      JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          type: "quota_error",
          message: `Quota unavailable for ${secret}`,
          ignored: { nested: "must not escape" },
        },
        unrelated: "must not escape",
      }),
    );
  });
  t.after(upstream.close);
  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [quotaLane("groq-a")],
    upstreams: [
      createGroqUpstream({
        alias: "groq-a",
        getApiKey: () => secret,
        endpoint: upstream.endpoint,
      }),
    ],
    allowedModels: ["frontier-code"],
    pinnedAlias: "groq-a",
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await chatRequest(url, {
    model: "frontier-code",
    messages: [{ role: "user", content: "diagnose" }],
    max_tokens: 64,
  });
  assert.equal(response.status, 429);
  const payload = await response.json();
  assert.equal(payload.error.message, "Quota unavailable for [REDACTED]");
  assert.deepEqual(payload.provider_error, {
    code: "429",
    status: "RESOURCE_EXHAUSTED",
    type: "quota_error",
    message: "Quota unavailable for [REDACTED]",
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("must not escape"), false);
});

test("rejects excessive output before contacting an upstream", async (t) => {
  let hits = 0;
  const upstream = await startFakeUpstream((_req, res) => {
    hits += 1;
    res.end();
  });
  t.after(upstream.close);
  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [quotaLane("groq-a")],
    upstreams: [{ alias: "groq-a", endpoint: upstream.endpoint, getSecretHeaders: () => ({}) }],
    allowedModels: [MODEL],
    maxOutputTokens: 1_024,
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await chatRequest(url, {
    model: MODEL,
    messages: [{ role: "user", content: "too large" }],
    max_tokens: 2_048,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, "output_limit_exceeded");
  assert.equal(hits, 0);
});

test("heterogeneous failover applies each provider model mapping", async (t) => {
  const geminiSecret = "gemini-secret-value";
  const groqSecret = "groq-secret-value";
  const first = await startFakeUpstream(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${geminiSecret}`);
    assert.equal((await requestBody(req)).model, "gemini-3.7-flash");
    res.writeHead(429, { "retry-after": "10" });
    res.end();
  });
  const second = await startFakeUpstream(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${groqSecret}`);
    assert.equal((await requestBody(req)).model, "openai/gpt-oss-120b");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "fallback-ok" } }] }));
  });
  t.after(first.close);
  t.after(second.close);

  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [
      {
        alias: "gemini-a",
        quotaGroup: "gemini-project-a",
        provider: "gemini",
        limits: { rpm: 1_000, tpm: 2_000_000, tpd: Infinity },
      },
      quotaLane("groq-a"),
    ],
    upstreams: [
      createGeminiUpstream({
        alias: "gemini-a",
        getApiKey: () => geminiSecret,
        endpoint: first.endpoint,
      }),
      createGroqUpstream({
        alias: "groq-a",
        getApiKey: () => groqSecret,
        endpoint: second.endpoint,
      }),
    ],
    allowedModels: ["frontier-code"],
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await chatRequest(url, {
    model: "frontier-code",
    messages: [{ role: "user", content: "use fallback" }],
    max_tokens: 128,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-gateway-lane"), "groq-a");
  assert.equal((await response.json()).choices[0].message.content, "fallback-ok");
});

test("Anthropic OpenAI-compatible lane forwards workspace, tools, and effort", async (t) => {
  const secret = "anthropic-secret-value";
  const workspaceId = "wrkspc_01ExampleWorkspace";
  const upstream = await startFakeUpstream(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.headers["anthropic-workspace-id"], workspaceId);
    const body = await requestBody(req);
    assert.equal(body.model, "claude-sonnet-5");
    assert.equal(body.reasoning_effort, undefined);
    assert.deepEqual(body.output_config, { effort: "medium" });
    assert.equal(body.tools[0].function.name, "read_file");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_claude",
        choices: [{ message: { role: "assistant", content: "ready" } }],
      }),
    );
  });
  t.after(upstream.close);

  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [
      {
        alias: "anthropic-sonnet",
        quotaGroup: "anthropic-workspace-sonnet5",
        provider: "anthropic",
        limits: { rpm: 5, rpd: 200, tpm: 50_000, tpd: 200_000 },
      },
    ],
    upstreams: [
      createAnthropicUpstream({
        alias: "anthropic-sonnet",
        getApiKey: () => secret,
        getWorkspaceId: () => workspaceId,
        endpoint: upstream.endpoint,
      }),
    ],
    allowedModels: ["frontier-code"],
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await chatRequest(url, {
    model: "frontier-code",
    messages: [{ role: "user", content: "inspect" }],
    tools: [{ type: "function", function: { name: "read_file" } }],
    reasoning_effort: "high",
    max_tokens: 128,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-gateway-lane"), "anthropic-sonnet");
  assert.equal((await response.json()).choices[0].message.content, "ready");
});

test("hard run budget rejects locally before contacting an upstream", async (t) => {
  let hits = 0;
  const upstream = await startFakeUpstream((_req, res) => {
    hits += 1;
    res.end();
  });
  t.after(upstream.close);
  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [quotaLane("groq-a")],
    upstreams: [
      createGroqUpstream({
        alias: "groq-a",
        getApiKey: () => "groq-secret-value",
        endpoint: upstream.endpoint,
      }),
    ],
    allowedModels: ["frontier-code"],
    runBudgetLimits: {
      maxRequests: 10,
      maxTokens: 10_000,
      maxUsdMicros: 1,
    },
    pricingByAlias: {
      "groq-a": {
        inputUsdPerMillion: "0.15",
        outputUsdPerMillion: "0.60",
      },
    },
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await chatRequest(url, {
    model: "frontier-code",
    messages: [{ role: "user", content: "must remain local" }],
    max_tokens: 128,
  });
  assert.equal(response.status, 429);
  const payload = await response.json();
  assert.equal(payload.error.type, "gateway_budget_exhausted");
  assert.equal(payload.error.reason, "usd");
  assert.equal(payload.budget.requests, 0);
  assert.equal(hits, 0);
});

test("aborts a slow upstream at the configured deadline", async (t) => {
  let observedAbort = false;
  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [quotaLane("groq-a")],
    upstreams: [
      createGroqUpstream({
        alias: "groq-a",
        getApiKey: () => "groq-secret-value",
      }),
    ],
    allowedModels: ["frontier-code"],
    upstreamTimeoutMs: 10,
    fetchImpl: (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            reject(options.signal.reason);
          },
          { once: true },
        );
      }),
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await chatRequest(url, {
    model: "frontier-code",
    messages: [{ role: "user", content: "timeout" }],
    max_tokens: 128,
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.type, "upstream_timeout");
  assert.equal(observedAbort, true);

  const metricsResponse = await fetch(`${url}/metrics`, {
    headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const metrics = await metricsResponse.json();
  assert.equal(metrics.upstreamTimeouts, 1);
});
