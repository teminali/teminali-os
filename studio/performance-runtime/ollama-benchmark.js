import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BenchmarkError } from "./errors.js";
import { aggregateSamples, classifyLoad, extractOllamaMetrics } from "./metrics.js";
import { consumeNdjson } from "./ndjson.js";

function loopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new BenchmarkError("INVALID_GATEWAY_URL", "The benchmark gateway must be an HTTP loopback URL.");
  }
  return url;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function boundedErrorCode(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > 256 * 1024) return null;
  try {
    const body = JSON.parse(text);
    return typeof body?.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

function linkedTimeout(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) cancel();
  else externalSignal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("benchmark request timeout"));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
    },
  };
}

export async function writeReport(path, report) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, absolute);
  return absolute;
}

export class OllamaGatewayBenchmark {
  constructor(options) {
    if (!options?.gatewayUrl || !options?.model || typeof options.prompt !== "string" || options.prompt.length === 0) {
      throw new BenchmarkError("INVALID_CONFIG", "gatewayUrl, model, and a non-empty prompt are required.");
    }
    this.gatewayUrl = loopbackUrl(options.gatewayUrl);
    this.model = options.model;
    this.prompt = options.prompt;
    this.token = options.token || null;
    this.origin = options.origin || "http://localhost:3000";
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.runs = options.runs ?? 5;
    this.includeCold = options.includeCold === true;
    this.coldThresholdMs = options.coldThresholdMs ?? 500;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 180_000;
    this.numPredict = options.numPredict ?? 128;
    this.seed = options.seed ?? 42;
    this.cancellationProbe = options.cancellationProbe !== false;
    this.cancellationMaxWaitMs = options.cancellationMaxWaitMs ?? 30_000;
    if (!Number.isInteger(this.runs) || this.runs < 1 || this.runs > 100) throw new BenchmarkError("INVALID_CONFIG", "runs must be an integer between 1 and 100.");
    if (!Number.isFinite(this.coldThresholdMs) || this.coldThresholdMs < 0) throw new BenchmarkError("INVALID_CONFIG", "coldThresholdMs must be non-negative.");
    if (!Number.isInteger(this.numPredict) || this.numPredict < 1 || this.numPredict > 8192) throw new BenchmarkError("INVALID_CONFIG", "numPredict must be an integer between 1 and 8192.");
    if (Buffer.byteLength(this.prompt) > 1024 * 1024) throw new BenchmarkError("INVALID_CONFIG", "The benchmark prompt cannot exceed 1 MiB.");
  }

  async run(signal) {
    await this.#ensureSession();
    const health = await this.#health(signal);
    if (health?.dependencies?.ollama?.state !== "healthy") {
      throw new BenchmarkError("OLLAMA_UNHEALTHY", "Gateway health does not report Ollama as healthy.", { state: health?.dependencies?.ollama?.state || "unknown" });
    }

    let warmup = null;
    if (!this.includeCold) {
      warmup = await this.#sample(0, "warmup", signal);
      if (!warmup.providerCompleted) throw new BenchmarkError("WARMUP_INCOMPLETE", "The warmup request did not produce a completed Ollama response.");
    }

    const samples = [];
    for (let index = 0; index < this.runs; index += 1) {
      samples.push(await this.#sample(index + 1, this.includeCold && index === 0 ? "cold_observation" : "warm", signal));
    }
    const cancellation = this.cancellationProbe ? await this.#measureCancellation(signal) : null;
    const warnings = [];
    if (this.includeCold && samples[0].classification !== "cold") warnings.push("A cold observation was requested, but Ollama load_duration did not meet the recorded cold threshold. No unload was attempted.");
    if (samples.some((sample) => !sample.complete)) warnings.push("One or more samples omitted authoritative provider fields; missing values remain null and those samples are marked incomplete.");

    return {
      schemaVersion: 1,
      benchmarkId: randomUUID(),
      createdAt: new Date().toISOString(),
      status: samples.every((sample) => sample.complete) ? "measured" : "incomplete",
      gateway: this.gatewayUrl.origin,
      model: this.model,
      prompt: { sha256: sha256(this.prompt), bytes: Buffer.byteLength(this.prompt) },
      configuration: {
        runCount: this.runs,
        includeColdObservation: this.includeCold,
        coldThresholdMs: this.coldThresholdMs,
        warmupPerformed: !this.includeCold,
        numPredict: this.numPredict,
        seed: this.seed,
        requestTimeoutMs: this.requestTimeoutMs,
        cancellationProbe: this.cancellationProbe,
      },
      environment: { node: process.version, platform: process.platform, architecture: process.arch },
      warmup: warmup ? { classification: warmup.classification, complete: warmup.complete, totalLatencyMs: warmup.metrics.totalLatencyMs } : null,
      rawSamples: samples,
      aggregate: aggregateSamples(samples),
      cancellation,
      warnings,
    };
  }

  async #ensureSession() {
    if (this.token) return;
    const response = await this.fetchImpl(new URL("/api/session", this.gatewayUrl), { method: "POST", headers: { origin: this.origin } });
    if (!response.ok) throw new BenchmarkError("SESSION_FAILED", `Gateway session bootstrap returned HTTP ${response.status}.`);
    const session = await response.json();
    if (typeof session.token !== "string" || session.token.length < 32) throw new BenchmarkError("SESSION_FAILED", "Gateway returned an invalid session token.");
    this.token = session.token;
  }

  async #health(signal) {
    const response = await this.fetchImpl(new URL("/api/health", this.gatewayUrl), { signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new BenchmarkError("GATEWAY_UNHEALTHY", `Gateway health returned HTTP ${response.status}.`);
    return response.json();
  }

  async #sample(index, requestedMode, externalSignal) {
    const correlationId = randomUUID();
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let firstTokenAt = null;
    let finalChunk = null;
    const request = linkedTimeout(externalSignal, this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(new URL("/api/ollama/generate", this.gatewayUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", accept: "application/x-ndjson", "x-correlation-id": correlationId },
        body: JSON.stringify({ model: this.model, prompt: this.prompt, stream: true, options: { temperature: 0, seed: this.seed, num_predict: this.numPredict } }),
        signal: request.signal,
      });
      if (!response.ok) {
        const code = await boundedErrorCode(response);
        throw new BenchmarkError("PROVIDER_REQUEST_FAILED", `Gateway returned HTTP ${response.status} for the Ollama sample.`, { status: response.status, providerCode: code });
      }
      const stream = await consumeNdjson(response.body, {
        onObject(chunk) {
          if (firstTokenAt === null && typeof chunk.response === "string" && chunk.response.length > 0) firstTokenAt = performance.now();
          if (chunk.done === true) finalChunk = chunk;
        },
      });
      const finished = performance.now();
      const authoritative = extractOllamaMetrics(finalChunk);
      const rawComplete = Object.values(authoritative.raw).every((value) => value !== null);
      const providerCompleted = finalChunk?.done === true;
      return {
        index,
        requestedMode,
        classification: classifyLoad(authoritative.raw.loadDurationNs, this.coldThresholdMs),
        startedAt,
        correlationId: response.headers.get("x-correlation-id") || correlationId,
        providerCompleted,
        complete: providerCompleted && rawComplete && firstTokenAt !== null,
        stream: { bytes: stream.bytes, objectCount: stream.objectCount },
        metrics: {
          ttftMs: firstTokenAt === null ? null : firstTokenAt - started,
          totalLatencyMs: finished - started,
          ...authoritative,
        },
      };
    } catch (error) {
      if (request.signal.aborted) {
        throw new BenchmarkError(request.timedOut() ? "REQUEST_TIMEOUT" : "CANCELLED", request.timedOut() ? "The Ollama sample exceeded its timeout." : "The benchmark was cancelled.");
      }
      throw error;
    } finally {
      request.cleanup();
    }
  }

  async #measureCancellation(externalSignal) {
    const controller = new AbortController();
    const correlationId = randomUUID();
    let abortRequestedAt = null;
    let trigger = null;
    let parentCancelled = false;
    const cancelFromParent = () => {
      parentCancelled = true;
      controller.abort(externalSignal.reason);
    };
    if (externalSignal?.aborted) cancelFromParent();
    else externalSignal?.addEventListener("abort", cancelFromParent, { once: true });
    const waitTimer = setTimeout(() => {
      trigger = "timeout_before_first_token";
      abortRequestedAt = performance.now();
      controller.abort(new Error("cancellation probe first-token timeout"));
    }, this.cancellationMaxWaitMs);
    waitTimer.unref?.();
    let outcome = "unknown";
    try {
      const response = await this.fetchImpl(new URL("/api/ollama/generate", this.gatewayUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", accept: "application/x-ndjson", "x-correlation-id": correlationId },
        body: JSON.stringify({ model: this.model, prompt: this.prompt, stream: true, options: { temperature: 0, seed: this.seed + 1, num_predict: Math.max(512, this.numPredict) } }),
        signal: controller.signal,
      });
      if (!response.ok) throw new BenchmarkError("CANCELLATION_PROBE_FAILED", `Cancellation probe returned HTTP ${response.status}.`);
      await consumeNdjson(response.body, {
        onObject(chunk) {
          if (abortRequestedAt === null && typeof chunk.response === "string" && chunk.response.length > 0) {
            trigger = "first_token";
            abortRequestedAt = performance.now();
            controller.abort(new Error("intentional cancellation probe"));
          }
        },
      });
      outcome = controller.signal.aborted ? "stream_closed_after_abort" : "completed_before_abort";
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      outcome = "aborted";
    } finally {
      clearTimeout(waitTimer);
      externalSignal?.removeEventListener("abort", cancelFromParent);
    }
    if (parentCancelled) throw new BenchmarkError("CANCELLED", "The benchmark was cancelled.");
    const settledAt = performance.now();
    return {
      correlationId,
      trigger,
      outcome,
      cancellationLatencyMs: abortRequestedAt === null ? null : settledAt - abortRequestedAt,
      measured: abortRequestedAt !== null,
    };
  }
}
