import assert from "node:assert/strict";
import test from "node:test";
import { aggregateSamples, classifyLoad, extractOllamaMetrics, median, percentileNearestRank, tokensPerSecond } from "./metrics.js";
import { consumeNdjson } from "./ndjson.js";
import { OllamaGatewayBenchmark } from "./ollama-benchmark.js";

test("authoritative duration math never invents rates for missing or zero durations", () => {
  assert.equal(tokensPerSecond(25, 2_000_000_000), 12.5);
  assert.equal(tokensPerSecond(null, 2_000_000_000), null);
  assert.equal(tokensPerSecond(25, null), null);
  assert.equal(tokensPerSecond(25, 0), null);

  const metrics = extractOllamaMetrics({
    prompt_eval_count: 100,
    prompt_eval_duration: 2_000_000_000,
    eval_count: 40,
    eval_duration: 4_000_000_000,
    load_duration: 750_000_000,
    total_duration: 7_000_000_000,
  });
  assert.equal(metrics.promptTokensPerSecond, 50);
  assert.equal(metrics.outputTokensPerSecond, 10);
  assert.equal(metrics.loadDurationMs, 750);
  assert.equal(metrics.ollamaTotalDurationMs, 7000);

  const missing = extractOllamaMetrics({ eval_count: 10 });
  assert.equal(missing.promptTokens, null);
  assert.equal(missing.promptTokensPerSecond, null);
  assert.equal(missing.outputTokensPerSecond, null);
  assert.equal(missing.raw.totalDurationNs, null);
});

test("median, nearest-rank p95, and cold classification are deterministic", () => {
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 2, 8, 6]), 5);
  assert.equal(median([]), null);
  assert.equal(percentileNearestRank(Array.from({ length: 20 }, (_, index) => index + 1), 95), 19);
  assert.equal(classifyLoad(500_000_000, 500), "cold");
  assert.equal(classifyLoad(499_999_999, 500), "warm");
  assert.equal(classifyLoad(null, 500), "unknown");
});

test("aggregation preserves run counts and excludes null measurements", () => {
  const sample = (classification, complete, value) => ({
    classification,
    complete,
    metrics: {
      ttftMs: value,
      totalLatencyMs: value,
      promptTokensPerSecond: value,
      outputTokensPerSecond: value,
      ollamaTotalDurationMs: value,
      loadDurationMs: value,
      promptEvalDurationMs: value,
      evalDurationMs: value,
      promptTokens: value,
      outputTokens: value,
    },
  });
  const samples = [sample("cold", true, 10), sample("warm", true, 20), sample("warm", false, null)];
  const aggregate = aggregateSamples(samples);
  assert.equal(aggregate.all.runCount, 3);
  assert.equal(aggregate.all.completeRunCount, 2);
  assert.equal(aggregate.all.metrics.ttftMs.measuredCount, 2);
  assert.equal(aggregate.all.metrics.ttftMs.median, 15);
  assert.equal(aggregate.all.metrics.ttftMs.p95, 20);
  assert.equal(aggregate.cold.runCount, 1);
  assert.equal(aggregate.warm.runCount, 2);
  assert.equal(aggregate.unknown.runCount, 0);
  assert.equal(aggregate.unknown.metrics.outputTokensPerSecond.median, null);
});

test("NDJSON parser handles split chunks and rejects malformed lines", async () => {
  const encoder = new TextEncoder();
  const objects = [];
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"response":"a","done":false'));
      controller.enqueue(encoder.encode('}\n{"done":true}\n'));
      controller.close();
    },
  });
  const result = await consumeNdjson(stream, { onObject: (value) => objects.push(value) });
  assert.equal(result.objectCount, 2);
  assert.deepEqual(objects, [{ response: "a", done: false }, { done: true }]);

  const malformed = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("{broken}\n"));
      controller.close();
    },
  });
  await assert.rejects(consumeNdjson(malformed), (error) => error.code === "MALFORMED_NDJSON");
});

test("live-shaped gateway samples retain raw counters and never request model unload", async () => {
  const requests = [];
  let sampleIndex = 0;
  const encoder = new TextEncoder();
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (path === "/api/session") return new Response(JSON.stringify({ token: "test-token-with-at-least-thirty-two-bytes" }), { headers: { "content-type": "application/json" } });
    if (path === "/api/health") return new Response(JSON.stringify({ dependencies: { ollama: { state: "healthy" } } }), { headers: { "content-type": "application/json" } });
    sampleIndex += 1;
    const loadDuration = sampleIndex === 1 ? 800_000_000 : 2_000_000;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"response":"token","done":false}\n'));
        controller.enqueue(encoder.encode(`${JSON.stringify({ response: "", done: true, prompt_eval_count: 20, prompt_eval_duration: 1_000_000_000, eval_count: 10, eval_duration: 2_000_000_000, load_duration: loadDuration, total_duration: 3_000_000_000 })}\n`));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "x-correlation-id": `sample-${sampleIndex}` } });
  };
  const benchmark = new OllamaGatewayBenchmark({
    gatewayUrl: "http://127.0.0.1:4310",
    model: "devstral-test",
    prompt: "private prompt content",
    runs: 2,
    includeCold: true,
    cancellationProbe: false,
    coldThresholdMs: 500,
    fetchImpl,
  });
  const report = await benchmark.run();
  assert.equal(report.status, "measured");
  assert.deepEqual(report.rawSamples.map((sample) => sample.classification), ["cold", "warm"]);
  assert.equal(report.rawSamples[0].metrics.promptTokensPerSecond, 20);
  assert.equal(report.rawSamples[0].metrics.outputTokensPerSecond, 5);
  assert.equal(report.aggregate.all.runCount, 2);
  assert.equal(report.aggregate.all.metrics.outputTokensPerSecond.median, 5);
  assert.equal(JSON.stringify(report).includes("private prompt content"), false);
  assert.equal(requests.some((request) => request.body && Object.hasOwn(request.body, "keep_alive")), false);
  assert.equal(requests.filter((request) => request.path === "/api/ollama/generate").length, 2);
});

test("cancellation probe records measured settle latency after first token", async () => {
  const encoder = new TextEncoder();
  let generation = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/session") return new Response(JSON.stringify({ token: "test-token-with-at-least-thirty-two-bytes" }), { headers: { "content-type": "application/json" } });
    if (path === "/api/health") return new Response(JSON.stringify({ dependencies: { ollama: { state: "healthy" } } }), { headers: { "content-type": "application/json" } });
    generation += 1;
    if (generation === 1) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"response":"token","done":false}\n'));
          controller.enqueue(encoder.encode('{"response":"","done":true,"prompt_eval_count":2,"prompt_eval_duration":100000000,"eval_count":1,"eval_duration":100000000,"load_duration":1000000,"total_duration":201000000}\n'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"response":"first","done":false}\n'));
        init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
  };
  const benchmark = new OllamaGatewayBenchmark({
    gatewayUrl: "http://127.0.0.1:4310",
    model: "devstral-test",
    prompt: "measure cancellation",
    runs: 1,
    includeCold: true,
    cancellationProbe: true,
    fetchImpl,
  });
  const report = await benchmark.run();
  assert.equal(report.cancellation.trigger, "first_token");
  assert.equal(report.cancellation.outcome, "aborted");
  assert.equal(report.cancellation.measured, true);
  assert.ok(report.cancellation.cancellationLatencyMs >= 0);
});
