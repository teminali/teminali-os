import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import {
  MODEL_MODES,
  PROFILES,
  isExpertModelQualified,
  selectProfileForMode,
} from "../../gateway/frontier-runner.js";
import { BoundedAuditLog } from "./audit-log.js";
import { createConfig } from "./config.js";
import { listWorkspaceTree, readWorkspaceFile, writeWorkspaceFile } from "./workspace.js";
import { GatewayError, classifyUpstreamStatus, publicError } from "./errors.js";
import {
  parseBoundedJsonBuffer,
  readJson,
  validateClientAuditEvent,
  validateAnthropicResponse,
  validateAnthropicRequest,
  validateJsonRpcResponse,
  validateMcpRequest,
  validateOllamaResponse,
  validateOllamaRequest,
} from "./validation.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "x-request-id", "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining"];

function replyJson(response, status, body, headers = {}) {
  if (response.writableEnded || response.destroyed) return;
  if (response.headersSent) {
    response.end();
    return;
  }
  const encoded = JSON.stringify(body);
  response.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(encoded), ...headers });
  response.end(encoded);
}

function requestRoute(request) {
  try {
    return new URL(request.url, "http://127.0.0.1").pathname;
  } catch {
    throw new GatewayError(400, "INVALID_URL", "The request URL is invalid.");
  }
}

function bearerMatches(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function safeCorrelationId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : randomUUID();
}

function abortContext(request, response, timeoutMs) {
  const controller = new AbortController();
  let completed = false;
  let cancelled = false;
  const cancel = () => {
    if (!completed) {
      cancelled = true;
      controller.abort(new Error("client disconnected"));
    }
  };
  request.once("aborted", cancel);
  response.once("close", cancel);
  const timer = setTimeout(() => controller.abort(new Error("upstream timeout")), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    wasCancelled: () => cancelled,
    finish() {
      completed = true;
      clearTimeout(timer);
      request.off("aborted", cancel);
      response.off("close", cancel);
    },
  };
}

async function readBoundedResponse(response, maxBytes, source) {
  const chunks = [];
  let total = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of Readable.fromWeb(response.body)) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new GatewayError(502, "UPSTREAM_RESPONSE_TOO_LARGE", `${source} returned an oversized response.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function probe(fetchImpl, url, timeoutMs, validator) {
  const startedAt = performance.now();
  const controller = new AbortController();
  let reached = false;
  let status;
  const timer = setTimeout(() => controller.abort(new Error("health timeout")), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal, headers: { accept: "application/json" } });
    reached = true;
    status = response.status;
    let valid = response.ok;
    if (valid && validator) {
      const body = await readBoundedResponse(response, 256 * 1024, "Dependency");
      valid = validator(parseBoundedJsonBuffer(body, 256 * 1024, "Dependency"));
    }
    return {
      state: valid ? "healthy" : "degraded",
      status: response.status,
      latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
      ...(valid ? {} : { errorCode: "UNHEALTHY_RESPONSE" }),
    };
  } catch (error) {
    return {
      state: reached ? "degraded" : "offline",
      ...(status === undefined ? {} : { status }),
      latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
      errorCode: controller.signal.aborted || error?.name === "AbortError" ? "HEALTH_TIMEOUT" : reached ? "MALFORMED_HEALTH_RESPONSE" : "DEPENDENCY_OFFLINE",
    };
  } finally {
    clearTimeout(timer);
  }
}

function joinUrl(base, path) {
  return new URL(path, base.href.endsWith("/") ? base : new URL(`${base.href}/`));
}

function contentTypeIsJson(value) {
  return /(?:application|text)\/(?:[^;]+\+)?json\b/i.test(value || "");
}

function localModelForProfile(profile) {
  const config = PROFILES[profile];
  return config?.structuredLocalModel || config?.localModel;
}

function frontierStatusPayload(expertQualified) {
  const flash = localModelForProfile("local");
  const max = localModelForProfile("local-expert");
  return {
    defaultMode: "auto",
    maxQualified: expertQualified,
    modes: {
      flash: { ...MODEL_MODES.flash, available: true },
      auto: { ...MODEL_MODES.auto, available: true },
      max: { ...MODEL_MODES.max, available: expertQualified },
    },
    models: {
      flash: { model: flash.model, contextTokens: flash.contextTokens },
      max: { model: max.model, contextTokens: max.contextTokens },
    },
  };
}

function resolveFrontierMode(mode, prompt, expertQualified) {
  const selection = selectProfileForMode(mode, prompt, { expertQualified });
  const localModel = localModelForProfile(selection.profile);
  return {
    ...selection,
    label: MODEL_MODES[mode].label,
    model: localModel.model,
    contextTokens: localModel.contextTokens,
  };
}

function workspaceError(error) {
  const code = error instanceof Error ? error.message : "WORKSPACE_READ_FAILED";
  if (["INVALID_WORKSPACE_PATH", "WORKSPACE_PATH_ESCAPE"].includes(code)) {
    return new GatewayError(400, code, "The requested workspace path is invalid.");
  }
  if (code === "WORKSPACE_FILE_TOO_LARGE") return new GatewayError(413, code, "The file exceeds the safe preview limit.");
  if (code === "WORKSPACE_FILE_UNSUPPORTED") return new GatewayError(415, code, "This file type is not available for safe in-app reading.");
  if (code === "WORKSPACE_FILE_REQUIRED") return new GatewayError(400, code, "A regular workspace file is required.");
  if (code === "WORKSPACE_CONTENT_REQUIRED") return new GatewayError(400, code, "UTF-8 text content is required for a workspace edit.");
  if (code === "WORKSPACE_FILE_CONFLICT") return new GatewayError(409, code, "The workspace file changed after Copilot started editing it.");
  if (error?.code === "ENOENT") return new GatewayError(404, "WORKSPACE_FILE_NOT_FOUND", "The workspace file no longer exists.");
  return new GatewayError(500, "WORKSPACE_READ_FAILED", "The workspace could not be read.", { cause: error });
}

async function streamUpstream(upstream, client, context, maxBytes) {
  const headers = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  client.writeHead(upstream.status, headers);
  if (!upstream.body) {
    client.end();
    return 0;
  }

  let total = 0;
  for await (const chunk of Readable.fromWeb(upstream.body)) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new GatewayError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "The provider stream exceeded the configured limit.");
    }
    if (!client.write(chunk)) {
      await new Promise((resolve) => {
        const settled = () => {
          client.off("drain", settled);
          client.off("close", settled);
          resolve();
        };
        client.once("drain", settled);
        client.once("close", settled);
      });
    }
  }
  client.end();
  context.finish();
  return total;
}

export async function createGateway(options = {}) {
  const config = createConfig(options.environment, options.config);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const expertQualifiedProvider = options.expertQualifiedProvider || isExpertModelQualified;
  const modeResolver = options.resolveFrontierMode || resolveFrontierMode;
  if (typeof fetchImpl !== "function") throw new Error("A Fetch-compatible implementation is required.");

  const sessionToken = options.sessionToken || randomBytes(32).toString("base64url");
  const tokenFingerprint = createHash("sha256").update(sessionToken).digest("hex").slice(0, 12);
  const audit = options.audit || new BoundedAuditLog(config.auditPath, {
    maxBytes: config.auditMaxBytes,
    maxFiles: config.auditMaxFiles,
  });
  await audit.initialize();

  const health = async () => {
    const [ollama, cutMcp] = await Promise.all([
      probe(fetchImpl, joinUrl(config.ollamaUrl, "api/tags"), config.healthTimeoutMs, (body) => Array.isArray(body.models)),
      probe(fetchImpl, joinUrl(config.mcpUrl, "health"), config.healthTimeoutMs),
    ]);
    return {
      state: ollama.state === "healthy" && cutMcp.state === "healthy" ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      gateway: { state: "healthy", bind: config.host },
      dependencies: { ollama, teminaliCutMcp: cutMcp, kerfMcp: cutMcp },
    };
  };

  const server = http.createServer(async (request, response) => {
    const startedAt = performance.now();
    const correlationId = safeCorrelationId(request.headers["x-correlation-id"]);
    response.setHeader("x-correlation-id", correlationId);
    let route = "unknown";
    let provider;
    let context;

    try {
      route = requestRoute(request);
      const origin = request.headers.origin;
      if (origin && !config.allowedOrigins.has(origin)) {
        throw new GatewayError(403, "ORIGIN_FORBIDDEN", "The request origin is not allowed.");
      }
      if (origin) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        if (!origin) throw new GatewayError(403, "ORIGIN_REQUIRED", "CORS preflight requires an allowed origin.");
        response.writeHead(204, {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, x-correlation-id",
          "access-control-max-age": "600",
        });
        response.end();
        return;
      }

      if (request.method === "GET" && ["/health", "/api/health"].includes(route)) {
        replyJson(response, 200, await health());
        return;
      }

      if (request.method === "POST" && ["/session", "/api/session"].includes(route)) {
        if (!origin) throw new GatewayError(403, "ORIGIN_REQUIRED", "Session bootstrap requires an allowed browser origin.");
        if (Number(request.headers["content-length"] || 0) > 0 || request.headers["transfer-encoding"]) {
          throw new GatewayError(400, "SESSION_BODY_FORBIDDEN", "Session bootstrap does not accept a request body.");
        }
        replyJson(response, 200, { token: sessionToken, tokenType: "Bearer", expires: "process_exit" });
        return;
      }

      if (!bearerMatches(request.headers.authorization, sessionToken)) {
        throw new GatewayError(401, "AUTH_REQUIRED", "A valid session bearer token is required.");
      }

      if (request.method === "POST" && route === "/api/audit") {
        const event = validateClientAuditEvent(await readJson(request, config.maxJsonBytes));
        await audit.write({ ...event, correlationId, method: request.method, route });
        replyJson(response, 202, { accepted: true, correlationId });
        return;
      }

      if (request.method === "GET" && route === "/api/frontier/status") {
        replyJson(response, 200, frontierStatusPayload(expertQualifiedProvider()));
        return;
      }

      if (request.method === "POST" && route === "/api/frontier/resolve-mode") {
        const selectionRequest = await readJson(request, config.maxJsonBytes);
        const mode = selectionRequest?.mode;
        const prompt = selectionRequest?.prompt;
        if (typeof mode !== "string" || !Object.hasOwn(MODEL_MODES, mode)) {
          throw new GatewayError(400, "INVALID_MODEL_MODE", "Mode must be Flash, Auto, or Max.");
        }
        if (typeof prompt !== "string") {
          throw new GatewayError(400, "INVALID_PROMPT", "A text prompt is required to resolve the model route.");
        }
        const expertQualified = expertQualifiedProvider();
        if (mode === "max" && !expertQualified) {
          throw new GatewayError(409, "MODEL_MODE_LOCKED", "Max is locked until its exact local model path passes qualification.");
        }
        const selection = modeResolver(mode, prompt, expertQualified);
        await audit.write({
          event: "model-mode-resolved",
          correlationId,
          method: request.method,
          route,
          mode: selection.mode,
          profile: selection.profile,
          reason: selection.reason,
          model: selection.model,
        });
        replyJson(response, 200, selection);
        return;
      }

      if (request.method === "GET" && ["/api/models/local", "/api/models"].includes(route)) {
        try {
          const ollamaTagsUrl = joinUrl(config.ollamaUrl, "api/tags");
          const ollamaRes = await fetchImpl(ollamaTagsUrl, { signal: AbortSignal.timeout(3000) });
          if (ollamaRes.ok) {
            const data = await ollamaRes.json();
            replyJson(response, 200, {
              connected: true,
              ollamaUrl: config.ollamaUrl,
              models: data.models || [],
            });
          } else {
            replyJson(response, 200, {
              connected: false,
              ollamaUrl: config.ollamaUrl,
              error: `Ollama returned status ${ollamaRes.status}`,
              models: [],
            });
          }
        } catch (error) {
          replyJson(response, 200, {
            connected: false,
            ollamaUrl: config.ollamaUrl,
            error: error instanceof Error ? error.message : "Cannot reach Ollama on 127.0.0.1:11434",
            models: [],
          });
        }
        return;
      }

      if (request.method === "POST" && route === "/api/models/pull") {
        const pullReq = await readJson(request, config.maxJsonBytes);
        const modelName = pullReq?.model;
        if (typeof modelName !== "string" || !modelName.trim()) {
          throw new GatewayError(400, "INVALID_MODEL_NAME", "A valid model name/tag is required to download.");
        }
        try {
          const pullUrl = joinUrl(config.ollamaUrl, "api/pull");
          const ollamaPullRes = await fetchImpl(pullUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: modelName.trim(), stream: false }),
          });
          if (!ollamaPullRes.ok) {
            const errData = await ollamaPullRes.text();
            throw new GatewayError(502, "OLLAMA_PULL_FAILED", `Failed to pull model: ${errData}`);
          }
          const pullResult = await ollamaPullRes.json();
          replyJson(response, 200, { status: "success", model: modelName, result: pullResult });
        } catch (err) {
          if (err instanceof GatewayError) throw err;
          throw new GatewayError(502, "OLLAMA_PULL_ERROR", err instanceof Error ? err.message : "Failed to pull model from Ollama.");
        }
        return;
      }

      if (request.method === "GET" && route === "/api/workspace/tree") {
        try {
          replyJson(response, 200, await listWorkspaceTree(config.workspaceRoot));
        } catch (error) {
          throw workspaceError(error);
        }
        return;
      }

      if (request.method === "POST" && route === "/api/workspace/file") {
        const fileRequest = await readJson(request, config.maxJsonBytes);
        if (typeof fileRequest?.path !== "string" || fileRequest.path.length > 2_048) {
          throw new GatewayError(400, "INVALID_WORKSPACE_PATH", "A bounded workspace-relative file path is required.");
        }
        try {
          replyJson(response, 200, await readWorkspaceFile(config.workspaceRoot, fileRequest.path, { maxFileBytes: config.workspaceMaxFileBytes }));
        } catch (error) {
          throw workspaceError(error);
        }
        return;
      }

      if (request.method === "POST" && route === "/api/workspace/write") {
        const editRequest = await readJson(request, config.workspaceMaxFileBytes + config.maxJsonBytes);
        if (typeof editRequest?.path !== "string" || editRequest.path.length > 2_048) {
          throw new GatewayError(400, "INVALID_WORKSPACE_PATH", "A bounded workspace-relative file path is required.");
        }
        if (typeof editRequest?.content !== "string") {
          throw new GatewayError(400, "WORKSPACE_CONTENT_REQUIRED", "UTF-8 text content is required for a workspace edit.");
        }
        if (editRequest.expectedModified !== undefined && editRequest.expectedModified !== null && typeof editRequest.expectedModified !== "string") {
          throw new GatewayError(400, "INVALID_WORKSPACE_VERSION", "The expected workspace file version is invalid.");
        }
        try {
          const written = await writeWorkspaceFile(config.workspaceRoot, editRequest.path, editRequest.content, {
            maxFileBytes: config.workspaceMaxFileBytes,
            expectedModified: editRequest.expectedModified,
          });
          await audit.write({ event: "workspace-file-written", correlationId, method: request.method, route, path: written.path, bytes: written.size });
          replyJson(response, 200, written);
        } catch (error) {
          throw workspaceError(error);
        }
        return;
      }

      let body;
      let upstreamUrl;
      let upstreamHeaders = { "content-type": "application/json", accept: request.headers.accept || "application/json" };
      let source;
      let expectJsonRpc = false;
      let responseValidator;
      let streamContentType;

      const ollamaMatch = route.match(/^\/(?:api\/)?ollama\/(generate|chat)$/);
      if (request.method === "POST" && ollamaMatch) {
        provider = "ollama";
        body = await readJson(request, config.maxOllamaJsonBytes);
        validateOllamaRequest(ollamaMatch[1], body);
        upstreamUrl = joinUrl(config.ollamaUrl, `api/${ollamaMatch[1]}`);
        source = "Ollama";
        responseValidator = (value) => validateOllamaResponse(ollamaMatch[1], value);
        streamContentType = /^(?:application\/(?:x-ndjson|json)|text\/plain)\b/i;
      } else if (request.method === "POST" && ["/anthropic/v1/messages", "/api/anthropic/v1/messages"].includes(route)) {
        provider = "anthropic";
        if (!config.anthropicApiKey) {
          throw new GatewayError(503, "PROVIDER_NOT_CONFIGURED", "Anthropic is not configured on this gateway.");
        }
        body = await readJson(request, config.maxJsonBytes);
        validateAnthropicRequest(body);
        upstreamUrl = new URL("/v1/messages", config.anthropicUrl);
        upstreamHeaders = {
          ...upstreamHeaders,
          "x-api-key": config.anthropicApiKey,
          "anthropic-version": "2023-06-01",
        };
        source = "Anthropic";
        responseValidator = validateAnthropicResponse;
        streamContentType = /^text\/event-stream\b/i;
      } else if (request.method === "POST" && ["/mcp", "/api/mcp"].includes(route)) {
        provider = "teminali-cut-mcp";
        body = await readJson(request, config.maxJsonBytes);
        validateMcpRequest(body);
        const dependency = await probe(fetchImpl, joinUrl(config.mcpUrl, "health"), config.healthTimeoutMs);
        if (dependency.state !== "healthy") {
          throw new GatewayError(503, "MCP_OFFLINE", "Teminali Cut MCP is unavailable; timeline mutations were not attempted.", { retryable: true });
        }
        upstreamUrl = config.mcpUrl;
        source = "Teminali Cut MCP";
        expectJsonRpc = true;
      } else {
        throw new GatewayError(404, "NOT_FOUND", "No gateway route matches this request.");
      }

      const encodedBody = JSON.stringify(body);
      await audit.write({ event: "request", correlationId, method: request.method, route, provider, requestBytes: Buffer.byteLength(encodedBody) });
      context = abortContext(request, response, config.requestTimeoutMs);

      let upstream;
      try {
        upstream = await fetchImpl(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: encodedBody,
          signal: context.signal,
        });
      } catch (error) {
        if (context.signal.aborted) {
          throw new GatewayError(context.wasCancelled() ? 499 : 504, context.wasCancelled() ? "CLIENT_CANCELLED" : "UPSTREAM_TIMEOUT", context.wasCancelled() ? "The client cancelled the request." : `${source} did not respond before the timeout.`, { retryable: !context.wasCancelled() });
        }
        throw new GatewayError(503, "PROVIDER_OFFLINE", `${source} is unavailable.`, { retryable: true, cause: error });
      }

      if (!upstream.ok) {
        await readBoundedResponse(upstream, config.maxJsonBytes, source);
        const providerRequestId = upstream.headers.get("x-request-id") || undefined;
        throw new GatewayError(upstream.status, "UPSTREAM_REJECTED", `${source} rejected the request.`, {
          retryable: classifyUpstreamStatus(upstream.status),
          details: providerRequestId ? { providerRequestId } : undefined,
        });
      }

      const isStreaming = body.stream === true;
      let responseBytes = 0;
      if (isStreaming) {
        if (!streamContentType?.test(upstream.headers.get("content-type") || "")) {
          throw new GatewayError(502, "INVALID_UPSTREAM_CONTENT_TYPE", `${source} returned an unexpected streaming content type.`, { retryable: true });
        }
        responseBytes = await streamUpstream(upstream, response, context, config.maxStreamBytes);
      } else {
        const buffer = await readBoundedResponse(upstream, config.maxJsonBytes, source);
        responseBytes = buffer.length;
        const parsed = parseBoundedJsonBuffer(buffer, config.maxJsonBytes, source);
        if (expectJsonRpc && !validateJsonRpcResponse(parsed, body.id)) {
          throw new GatewayError(502, "MALFORMED_UPSTREAM_RESPONSE", "Teminali Cut MCP returned an invalid JSON-RPC response.", { retryable: true });
        }
        if (responseValidator && !responseValidator(parsed)) {
          throw new GatewayError(502, "MALFORMED_UPSTREAM_RESPONSE", `${source} returned a response that does not match its schema.`, { retryable: true });
        }
        if (!contentTypeIsJson(upstream.headers.get("content-type"))) {
          throw new GatewayError(502, "INVALID_UPSTREAM_CONTENT_TYPE", `${source} returned an unexpected content type.`, { retryable: true });
        }
        replyJson(response, upstream.status, parsed);
      }
      context.finish();
      await audit.write({ event: "response", correlationId, method: request.method, route, provider, status: upstream.status, durationMs: Math.round(performance.now() - startedAt), responseBytes });
    } catch (error) {
      let normalized = error instanceof GatewayError ? error : new GatewayError(500, "INTERNAL_ERROR", "The gateway could not complete the request.", { cause: error });
      if (!(error instanceof GatewayError) && context?.signal.aborted) {
        normalized = new GatewayError(context.wasCancelled() ? 499 : 504, context.wasCancelled() ? "CLIENT_CANCELLED" : "UPSTREAM_TIMEOUT", context.wasCancelled() ? "The client cancelled the request." : "The provider did not respond before the timeout.", { retryable: !context.wasCancelled() });
      }
      context?.finish();
      await audit.write({ event: "error", correlationId, method: request.method, route, provider, status: normalized.status, durationMs: Math.round(performance.now() - startedAt), errorCode: normalized.code, retryable: normalized.retryable, cancelled: normalized.code === "CLIENT_CANCELLED" });
      if (response.headersSent && !response.writableEnded) response.destroy(normalized);
      else replyJson(response, normalized.status, publicError(normalized, correlationId));
    }
  });

  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return {
    server,
    config,
    sessionToken,
    tokenFingerprint,
    health,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await audit.flush();
    },
  };
}
