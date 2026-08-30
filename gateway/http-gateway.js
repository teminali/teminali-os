import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { QuotaPool, QuotaUnavailableError } from "./quota-pool.js";
import {
  BudgetExceededError,
  normalizePricing,
  RunBudget,
} from "./run-budget.js";

class RequestTooLargeError extends Error {}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestTooLargeError();
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

function authorized(req, accessToken) {
  const actual = Buffer.from(req.headers.authorization ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${accessToken}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseRetryAfter(value, fallbackMs = 60_000) {
  if (typeof value !== "string" || value.length === 0) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.max(1, Math.ceil(seconds * 1_000));
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(1, date - Date.now());
  return fallbackMs;
}

function responseHeaders(upstream, lane, retryAfterMs) {
  const headers = {
    "x-gateway-lane": lane,
  };
  for (const name of ["content-type", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  if (retryAfterMs !== undefined) {
    headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfterMs / 1_000)));
  }
  return headers;
}

export function estimateRequestTokens(body, defaultOutputTokens = 1_024) {
  return estimateRequestUsage(body, defaultOutputTokens).totalTokens;
}

export function estimateRequestUsage(body, defaultOutputTokens = 1_024) {
  const serialized = JSON.stringify(body);
  const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(serialized) / 3));
  const outputTokens =
    body.max_completion_tokens ?? body.max_tokens ?? defaultOutputTokens;
  if (!Number.isInteger(outputTokens) || outputTokens <= 0) {
    throw new TypeError("max output tokens must be a positive integer");
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  });
}

export function createGateway({
  accessToken,
  quotaLanes,
  upstreams,
  allowedModels,
  pinnedAlias,
  maxAttempts = 2,
  maxRequestBytes = 1_048_576,
  maxOutputTokens = 4_096,
  defaultOutputTokens = 1_024,
  upstreamTimeoutMs = 120_000,
  runBudgetLimits,
  pricingByAlias,
  clock = Date.now,
  fetchImpl = fetch,
  logger = () => {},
}) {
  if (typeof accessToken !== "string" || accessToken.length < 12) {
    throw new TypeError("accessToken must contain at least 12 characters");
  }
  if (!Array.isArray(upstreams) || upstreams.length === 0) {
    throw new TypeError("upstreams must contain at least one entry");
  }
  if (!Array.isArray(allowedModels) || allowedModels.length === 0) {
    throw new TypeError("allowedModels must contain at least one model");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > 2) {
    throw new TypeError("maxAttempts must be one or two");
  }
  if (!Number.isInteger(upstreamTimeoutMs) || upstreamTimeoutMs <= 0) {
    throw new TypeError("upstreamTimeoutMs must be a positive integer");
  }

  const modelSet = new Set(allowedModels);
  const upstreamByAlias = new Map();
  for (const upstream of upstreams) {
    const allowed = new Set([
      "alias",
      "endpoint",
      "getSecretHeaders",
      "transformRequest",
    ]);
    for (const key of Object.keys(upstream)) {
      if (!allowed.has(key)) {
        throw new TypeError(`upstream contains unsupported field: ${key}`);
      }
    }
    if (upstreamByAlias.has(upstream.alias)) {
      throw new TypeError(`duplicate upstream alias: ${upstream.alias}`);
    }
    const endpoint = new URL(upstream.endpoint);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      throw new TypeError("upstream endpoint must use http or https");
    }
    if (typeof upstream.getSecretHeaders !== "function") {
      throw new TypeError("upstream getSecretHeaders must be a function");
    }
    if (
      upstream.transformRequest !== undefined &&
      typeof upstream.transformRequest !== "function"
    ) {
      throw new TypeError("upstream transformRequest must be a function");
    }
    upstreamByAlias.set(upstream.alias, { ...upstream, endpoint });
  }
  for (const lane of quotaLanes) {
    if (!upstreamByAlias.has(lane.alias)) {
      throw new TypeError(`missing upstream for quota lane: ${lane.alias}`);
    }
  }

  const quotaPool = new QuotaPool({ lanes: quotaLanes, clock });
  let runBudget = null;
  const pricingByLane = new Map();
  if (runBudgetLimits !== undefined || pricingByAlias !== undefined) {
    if (runBudgetLimits === undefined || pricingByAlias === undefined) {
      throw new TypeError("runBudgetLimits and pricingByAlias must be configured together");
    }
    if (
      pricingByAlias === null ||
      typeof pricingByAlias !== "object" ||
      Array.isArray(pricingByAlias)
    ) {
      throw new TypeError("pricingByAlias must be an object");
    }
    runBudget = new RunBudget(runBudgetLimits);
    const pricingAliases = new Set(Object.keys(pricingByAlias));
    for (const lane of quotaLanes) {
      if (!pricingAliases.has(lane.alias)) {
        throw new TypeError(`missing pricing for quota lane: ${lane.alias}`);
      }
    }
    for (const alias of pricingAliases) {
      if (!upstreamByAlias.has(alias)) {
        throw new TypeError(`pricing configured for unknown lane: ${alias}`);
      }
      const pricing = Object.freeze({
        inputUsdPerMillion: pricingByAlias[alias]?.inputUsdPerMillion,
        outputUsdPerMillion: pricingByAlias[alias]?.outputUsdPerMillion,
      });
      normalizePricing(pricing, `pricingByAlias.${alias}`);
      pricingByLane.set(alias, pricing);
    }
  }
  const metrics = {
    requests: 0,
    completed: 0,
    unauthorized: 0,
    rejected: 0,
    upstreamAttempts: 0,
    upstreamRateLimits: 0,
    upstreamErrors: 0,
    upstreamTimeouts: 0,
    failovers: 0,
    budgetRejections: 0,
  };

  const emit = (event, fields = {}) => logger({ event, ...fields });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://gateway.local");

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { status: "ok" });
      return;
    }

    if (!authorized(req, accessToken)) {
      metrics.unauthorized += 1;
      json(res, 401, { error: { type: "authentication_error", message: "Unauthorized" } });
      return;
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      json(res, 200, {
        ...metrics,
        quotas: quotaPool.snapshot(),
        budget: runBudget?.snapshot() ?? null,
      });
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      json(res, 404, { error: { type: "not_found", message: "Not found" } });
      return;
    }

    metrics.requests += 1;
    let body;
    try {
      body = await readJson(req, maxRequestBytes);
    } catch (error) {
      metrics.rejected += 1;
      if (error instanceof RequestTooLargeError) {
        json(res, 413, { error: { type: "request_too_large", message: "Request too large" } });
      } else {
        json(res, 400, { error: { type: "invalid_json", message: "Invalid JSON" } });
      }
      return;
    }

    if (!modelSet.has(body.model)) {
      metrics.rejected += 1;
      json(res, 400, { error: { type: "model_not_allowed", message: "Model not allowed" } });
      return;
    }
    const requestedOutput =
      body.max_completion_tokens ?? body.max_tokens ?? defaultOutputTokens;
    if (!Number.isInteger(requestedOutput) || requestedOutput <= 0) {
      metrics.rejected += 1;
      json(res, 400, { error: { type: "invalid_request", message: "Invalid output limit" } });
      return;
    }
    if (requestedOutput > maxOutputTokens) {
      metrics.rejected += 1;
      json(res, 400, {
        error: { type: "output_limit_exceeded", message: "Requested output exceeds gateway limit" },
      });
      return;
    }

    const estimatedUsage = estimateRequestUsage(body, defaultOutputTokens);
    const estimatedTokens = estimatedUsage.totalTokens;
    let lastRetryAfterMs = 60_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let lease;
      try {
        lease = quotaPool.reserve({ estimatedTokens, pinnedAlias });
      } catch (error) {
        if (!(error instanceof QuotaUnavailableError)) throw error;
        metrics.rejected += 1;
        json(
          res,
          429,
          {
            error: {
              type: "gateway_rate_limit",
              message: "No quota lane is currently available",
              retry_after_ms: error.retryAfterMs,
            },
          },
          { "retry-after": String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))) },
        );
        return;
      }

      const upstream = upstreamByAlias.get(lease.alias);
      let upstreamBody;
      let secretHeaders;
      try {
        secretHeaders = await upstream.getSecretHeaders();
        upstreamBody = upstream.transformRequest
          ? await upstream.transformRequest(body)
          : body;
      } catch {
        lease.cancel();
        metrics.upstreamErrors += 1;
        emit("upstream_configuration_error", {
          lane: lease.alias,
          provider: lease.provider,
          attempt,
        });
        json(res, 502, { error: { type: "upstream_error", message: "Upstream unavailable" } });
        return;
      }

      let budgetLease;
      try {
        budgetLease = runBudget?.reserve({
          inputTokens: estimatedUsage.inputTokens,
          outputTokens: estimatedUsage.outputTokens,
          pricing: pricingByLane.get(lease.alias),
        });
      } catch (error) {
        lease.cancel();
        if (!(error instanceof BudgetExceededError)) throw error;
        metrics.budgetRejections += 1;
        emit("budget_rejection", { reason: error.reason, lane: lease.alias });
        json(res, 429, {
          error: {
            type: "gateway_budget_exhausted",
            message: "Run budget exhausted",
            reason: error.reason,
          },
          budget: runBudget.snapshot(),
        });
        return;
      }

      metrics.upstreamAttempts += 1;
      emit("upstream_attempt", {
        lane: lease.alias,
        provider: lease.provider,
        attempt,
        estimatedTokens,
      });

      let upstreamResponse;
      const timeoutSignal = AbortSignal.timeout(upstreamTimeoutMs);
      try {
        upstreamResponse = await fetchImpl(upstream.endpoint, {
          method: "POST",
          headers: {
            accept: req.headers.accept ?? "application/json",
            "content-type": "application/json",
            ...secretHeaders,
          },
          body: JSON.stringify(upstreamBody),
          signal: timeoutSignal,
        });
      } catch {
        lease.cancel();
        budgetLease?.releaseUsage();
        if (timeoutSignal.aborted) {
          metrics.upstreamTimeouts += 1;
          emit("upstream_timeout", {
            lane: lease.alias,
            provider: lease.provider,
            attempt,
            timeoutMs: upstreamTimeoutMs,
          });
          json(res, 504, {
            error: { type: "upstream_timeout", message: "Upstream timed out" },
          });
          return;
        }
        metrics.upstreamErrors += 1;
        emit("upstream_error", { lane: lease.alias, provider: lease.provider, attempt });
        json(res, 502, { error: { type: "upstream_error", message: "Upstream unavailable" } });
        return;
      }

      if (upstreamResponse.status === 429) {
        lastRetryAfterMs = parseRetryAfter(upstreamResponse.headers.get("retry-after"));
        lease.rateLimited(lastRetryAfterMs);
        budgetLease?.releaseUsage();
        metrics.upstreamRateLimits += 1;
        emit("upstream_rate_limit", {
          lane: lease.alias,
          provider: lease.provider,
          attempt,
          retryAfterMs: lastRetryAfterMs,
        });
        if (attempt < maxAttempts && pinnedAlias === undefined) {
          metrics.failovers += 1;
          continue;
        }
        metrics.rejected += 1;
        json(
          res,
          429,
          {
            error: {
              type: "upstream_rate_limit",
              message: "Upstream rate limit reached",
              retry_after_ms: lastRetryAfterMs,
            },
          },
          { "retry-after": String(Math.max(1, Math.ceil(lastRetryAfterMs / 1_000))) },
        );
        return;
      }

      lease.commit(estimatedTokens);
      budgetLease?.commit();
      metrics.completed += 1;
      emit("upstream_response", {
        lane: lease.alias,
        provider: lease.provider,
        attempt,
        status: upstreamResponse.status,
      });

      res.writeHead(
        upstreamResponse.status,
        responseHeaders(upstreamResponse, lease.alias),
      );
      if (upstreamResponse.body === null) {
        res.end();
      } else {
        try {
          await pipeline(Readable.fromWeb(upstreamResponse.body), res);
        } catch {
          if (!res.destroyed) res.destroy();
        }
      }
      return;
    }
  });

  return Object.freeze({
    async listen({ host = "127.0.0.1", port = 0 } = {}) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      return `http://${address.address}:${address.port}`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  });
}
