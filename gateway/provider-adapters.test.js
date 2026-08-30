import assert from "node:assert/strict";
import test from "node:test";

import {
  createOllamaUpstream,
  createAnthropicUpstream,
  createGeminiUpstream,
  createGroqUpstream,
} from "./provider-adapters.js";

const SECRET = "provider-secret-value";

test("Groq adapter maps the logical model and preserves the request", async () => {
  const upstream = createGroqUpstream({
    alias: "groq-a",
    getApiKey: () => SECRET,
  });
  const body = {
    model: "frontier-code",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read_file" } }],
    stream: true,
  };

  assert.deepEqual(upstream.transformRequest(body), {
    ...body,
    model: "openai/gpt-oss-120b",
    stream_options: { include_usage: true },
  });
  assert.equal(body.model, "frontier-code");
  assert.deepEqual(await upstream.getSecretHeaders(), {
    authorization: `Bearer ${SECRET}`,
  });
  assert.equal(JSON.stringify(upstream).includes(SECRET), false);
});

test("Gemini adapter uses the official OpenAI-compatible endpoint and model", async () => {
  const upstream = createGeminiUpstream({
    alias: "gemini-a",
    getApiKey: async () => SECRET,
  });

  assert.equal(
    upstream.endpoint,
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
  assert.equal(
    upstream.transformRequest({ model: "frontier-code", messages: [] }).model,
    "gemini-3.7-flash",
  );
  assert.deepEqual(await upstream.getSecretHeaders(), {
    authorization: `Bearer ${SECRET}`,
  });
});

test("adapter rejects unmapped models and missing credentials", async () => {
  const upstream = createGroqUpstream({
    alias: "groq-a",
    getApiKey: () => "",
  });

  assert.throws(
    () => upstream.transformRequest({ model: "unmapped-model" }),
    /model is not mapped/,
  );
  await assert.rejects(upstream.getSecretHeaders(), /API key unavailable/);
});

test("Anthropic adapter supplies workspace routing and maps medium effort", async () => {
  const upstream = createAnthropicUpstream({
    alias: "anthropic-sonnet",
    getApiKey: () => SECRET,
    getWorkspaceId: () => "wrkspc_01ExampleWorkspace",
  });
  const body = {
    model: "frontier-code",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read_file" } }],
    reasoning_effort: "high",
    stream: true,
  };

  assert.equal(upstream.endpoint, "https://api.anthropic.com/v1/chat/completions");
  assert.deepEqual(await upstream.getSecretHeaders(), {
    authorization: `Bearer ${SECRET}`,
    "anthropic-workspace-id": "wrkspc_01ExampleWorkspace",
  });
  assert.deepEqual(upstream.transformRequest(body), {
    model: "claude-sonnet-5",
    messages: body.messages,
    tools: body.tools,
    stream: true,
    stream_options: { include_usage: true },
    output_config: { effort: "medium" },
  });
  assert.equal(body.reasoning_effort, "high");
});

test("adapters preserve an explicit stream-usage opt-out and non-stream requests", () => {
  const upstream = createGroqUpstream({
    alias: "groq-a",
    getApiKey: () => SECRET,
  });
  const optedOut = {
    model: "frontier-code",
    messages: [],
    stream: true,
    stream_options: { include_usage: false },
  };

  assert.deepEqual(upstream.transformRequest(optedOut), {
    ...optedOut,
    model: "openai/gpt-oss-120b",
  });
  assert.deepEqual(
    upstream.transformRequest({ model: "frontier-code", messages: [] }),
    { model: "openai/gpt-oss-120b", messages: [] },
  );
});

test("Anthropic adapter rejects missing workspace routing and invalid effort", async () => {
  const missingWorkspace = createAnthropicUpstream({
    alias: "anthropic-sonnet",
    getApiKey: () => SECRET,
    getWorkspaceId: () => "",
  });
  await assert.rejects(missingWorkspace.getSecretHeaders(), /workspace ID unavailable/);
  assert.throws(
    () =>
      createAnthropicUpstream({
        alias: "anthropic-sonnet",
        getApiKey: () => SECRET,
        getWorkspaceId: () => "wrkspc_01ExampleWorkspace",
        effort: "turbo",
      }),
    /effort must be/,
  );
});


test("Ollama adapter maps model, enforces loopback endpoint, and needs no key", async () => {
  const upstream = createOllamaUpstream({
    alias: "ollama-devstral",
  });

  assert.equal(upstream.endpoint, "http://127.0.0.1:11434/v1/chat/completions");
  assert.deepEqual(await upstream.getSecretHeaders(), {});
  assert.deepEqual(
    upstream.transformRequest({
      model: "frontier-code",
      messages: [{ role: "user", content: "test" }],
      stream: true,
    }),
    {
      model: "devstral-small-2:24b-instruct-2512-q4_K_M",
      messages: [{ role: "user", content: "test" }],
      stream: true,
      stream_options: { include_usage: true },
    },
  );

  assert.throws(
    () =>
      createOllamaUpstream({
        alias: "ollama-remote",
        endpoint: "https://remote-server.com/v1/chat/completions",
      }),
    /Ollama endpoint must be a loopback address/,
  );
});
