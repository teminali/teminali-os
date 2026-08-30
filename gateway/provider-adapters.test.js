import assert from "node:assert/strict";
import test from "node:test";

import { createGeminiUpstream, createGroqUpstream } from "./provider-adapters.js";

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
