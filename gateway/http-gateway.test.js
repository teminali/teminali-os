import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createGateway, estimateRequestTokens } from "./http-gateway.js";
import {
  createAnthropicUpstream,
  createOllamaUpstream,
  createGeminiUpstream,
  createGroqUpstream,
} from "./provider-adapters.js";

const ACCESS_TOKEN = "local-test-access-token";
const MODEL = "openai/gpt-oss-120b";
const GROQ_PRICING = {
  inputUsdPerMillion: "0.15",
  outputUsdPerMillion: "0.60",
};

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

function chatRequest(baseUrl, body, accessToken = ACCESS_TOKEN, signal) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
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

test("reconciles non-streaming quota and budget to reported usage", async (t) => {
  const expectedBody = JSON.stringify({
    id: "fake",
    choices: [{ message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(expectedBody);
  });
  t.after(upstream.close);
  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [quotaLane("groq-a")],
    upstreams: [
      { alias: "groq-a", endpoint: upstream.endpoint, getSecretHeaders: () => ({}) },
    ],
    allowedModels: [MODEL],
    runBudgetLimits: {
      maxRequests: 2,
      maxTokens: 10_000,
      maxUsdMicros: 10_000,
    },
    pricingByAlias: { "groq-a": GROQ_PRICING },
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await chatRequest(url, {
    model: MODEL,
    messages: [{ role: "user", content: "actual usage" }],
    max_tokens: 128,
  });
  assert.equal(await response.text(), expectedBody);

  const metrics = await (
    await fetch(`${url}/metrics`, {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    })
  ).json();
  assert.equal(metrics.completed, 1);
  assert.equal(metrics.budget.tokens, 15);
  assert.equal(metrics.budget.usdMicros, 5);
  assert.equal(metrics.budget.reservedTokens, 0);
  assert.equal(metrics.quotas[0].minuteTokens, 15);
  assert.equal(metrics.quotas[0].inFlight, 0);
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

test("preserves fragmented SSE while settling terminal reported usage", async (t) => {
  const expectedStream =
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}\n\n' +
    "data: [DONE]\n\n";
  const upstream = await startFakeUpstream(async (req, res) => {
    const body = await requestBody(req);
    assert.deepEqual(body.stream_options, { include_usage: true });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    const firstSplit = expectedStream.indexOf('"prompt_tokens"') + 9;
    const secondSplit = expectedStream.indexOf("[DONE]") + 2;
    res.write(expectedStream.slice(0, firstSplit));
    res.write(expectedStream.slice(firstSplit, secondSplit));
    res.end(expectedStream.slice(secondSplit));
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
      maxRequests: 2,
      maxTokens: 10_000,
      maxUsdMicros: 10_000,
    },
    pricingByAlias: { "groq-a": GROQ_PRICING },
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  const response = await chatRequest(url, {
    model: "frontier-code",
    messages: [{ role: "user", content: "stream actual usage" }],
    stream: true,
    max_tokens: 128,
  });
  assert.equal(await response.text(), expectedStream);

  const metrics = await (
    await fetch(`${url}/metrics`, {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    })
  ).json();
  assert.equal(metrics.completed, 1);
  assert.equal(metrics.budget.tokens, 19);
  assert.equal(metrics.budget.usdMicros, 6);
  assert.equal(metrics.quotas[0].minuteTokens, 19);
  assert.equal(metrics.quotas[0].inFlight, 0);
});

test("falls back to conservative settlement for malformed usage", async (t) => {
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 99 },
      }),
    );
  });
  t.after(upstream.close);
  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [quotaLane("groq-a")],
    upstreams: [
      { alias: "groq-a", endpoint: upstream.endpoint, getSecretHeaders: () => ({}) },
    ],
    allowedModels: [MODEL],
    runBudgetLimits: {
      maxRequests: 2,
      maxTokens: 10_000,
      maxUsdMicros: 10_000,
    },
    pricingByAlias: { "groq-a": GROQ_PRICING },
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: "malformed usage" }],
    max_tokens: 128,
  };
  const estimatedTokens = estimateRequestTokens(body);

  const response = await chatRequest(url, body);
  assert.equal(response.status, 200);
  await response.text();
  const metrics = await (
    await fetch(`${url}/metrics`, {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    })
  ).json();
  assert.equal(metrics.budget.tokens, estimatedTokens);
  assert.equal(metrics.quotas[0].minuteTokens, estimatedTokens);
  assert.equal(metrics.budget.reservedTokens, 0);
});

test("settles conservatively and releases reservations when a response stream fails", async (t) => {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: "interrupted stream" }],
    stream: true,
    max_tokens: 128,
  };
  const estimatedTokens = estimateRequestTokens(body);
  const encoder = new TextEncoder();
  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [quotaLane("groq-a")],
    upstreams: [
      { alias: "groq-a", endpoint: "https://unused.invalid", getSecretHeaders: () => ({}) },
    ],
    allowedModels: [MODEL],
    runBudgetLimits: {
      maxRequests: 2,
      maxTokens: 10_000,
      maxUsdMicros: 10_000,
    },
    pricingByAlias: { "groq-a": GROQ_PRICING },
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
            );
            controller.error(new Error("simulated upstream disconnect"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  await assert.rejects(async () => {
    const response = await chatRequest(url, body);
    await response.text();
  });

  const metrics = await (
    await fetch(`${url}/metrics`, {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    })
  ).json();
  assert.equal(metrics.completed, 0);
  assert.equal(metrics.upstreamErrors, 1);
  assert.equal(metrics.budget.tokens, estimatedTokens);
  assert.equal(metrics.budget.reservedTokens, 0);
  assert.equal(metrics.quotas[0].minuteTokens, estimatedTokens);
  assert.equal(metrics.quotas[0].inFlight, 0);
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

test("aborts an in-flight upstream when the client disconnects", async (t) => {
  let observedAbort = false;
  let resolveStarted;
  let resolveObservedAbort;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const upstreamAborted = new Promise((resolve) => {
    resolveObservedAbort = resolve;
  });
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
    upstreamTimeoutMs: 60_000,
    fetchImpl: (_url, options) =>
      new Promise((_resolve, reject) => {
        resolveStarted();
        options.signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolveObservedAbort();
            reject(options.signal.reason);
          },
          { once: true },
        );
      }),
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();
  const controller = new AbortController();
  const request = chatRequest(url, {
    model: "frontier-code",
    messages: [{ role: "user", content: "cancel" }],
    max_tokens: 128,
  }, ACCESS_TOKEN, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(request);
  await Promise.race([
    upstreamAborted,
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  assert.equal(observedAbort, true);
});

test("local-first Ollama lane routes requests locally and falls over to cloud upon 429", async (t) => {
  let localHits = 0;
  let cloudHits = 0;

  const gateway = createGateway({
    accessToken: ACCESS_TOKEN,
    quotaLanes: [
      {
        alias: "ollama-devstral",
        quotaGroup: "local-devstral",
        provider: "ollama",
        priority: 1,
        limits: { rpm: 60, rpd: 1000, tpm: 50000, tpd: 100000 },
      },
      {
        alias: "claude-sonnet",
        quotaGroup: "anthropic-backup",
        provider: "anthropic",
        priority: 10,
        limits: { rpm: 60, rpd: 1000, tpm: 50000, tpd: 100000 },
      },
    ],
    upstreams: [
      createOllamaUpstream({
        alias: "ollama-devstral",
        endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      }),
      createAnthropicUpstream({
        alias: "claude-sonnet",
        getApiKey: () => "anthropic-secret-key",
        getWorkspaceId: () => "wrkspc_01Test",
      }),
    ],
    runBudgetLimits: { maxRequests: 10, maxTokens: 50000, maxUsdMicros: 1000000 },
    pricingByAlias: {
      "ollama-devstral": { inputUsdPerMillion: "0", outputUsdPerMillion: "0" },
      "claude-sonnet": { inputUsdPerMillion: "2", outputUsdPerMillion: "10" },
    },
    allowedModels: ["frontier-code"],
    fetchImpl: async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes("11434")) {
        localHits += 1;
        if (localHits === 1) {
          // First call succeeds locally
          return new Response(JSON.stringify({
            id: "chatcmpl-local-1",
            object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "local response" } }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } else {
          // Second call gets 429 rate-limited locally
          return new Response(JSON.stringify({ error: { message: "Ollama busy" } }), {
            status: 429,
            headers: { "retry-after": "30", "content-type": "application/json" },
          });
        }
      } else {
        cloudHits += 1;
        return new Response(JSON.stringify({
          id: "chatcmpl-cloud-1",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "cloud fallback response" } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    },
  });
  t.after(() => gateway.close());
  const url = await gateway.listen();

  // First request should use local Ollama
  const res1 = await chatRequest(url, {
    model: "frontier-code",
    messages: [{ role: "user", content: "task 1" }],
    max_tokens: 64,
  });
  assert.equal(res1.status, 200);
  assert.equal(res1.headers.get("x-gateway-lane"), "ollama-devstral");
  assert.equal(localHits, 1);
  assert.equal(cloudHits, 0);

  // Second request: local 429 triggers failover to cloud lane
  const res2 = await chatRequest(url, {
    model: "frontier-code",
    messages: [{ role: "user", content: "task 2" }],
    max_tokens: 64,
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.headers.get("x-gateway-lane"), "claude-sonnet");
  assert.equal(localHits, 2);
  assert.equal(cloudHits, 1);
});
