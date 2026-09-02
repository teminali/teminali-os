import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import {
  MODEL_MODES,
  PROFILES,
  isExpertModelQualified,
  selectProfileForMode,
} from "../../gateway/frontier-runner.js";
import { BoundedAuditLog } from "./audit-log.js";
import { createConfig } from "./config.js";
import { listWorkspaceTree, readWorkspaceFile, searchWorkspace, writeWorkspaceFile } from "./workspace.js";
import { TERMINAL_LIMITS, runWorkspaceCommand } from "./terminal.js";
import { readBounded, speak, transcribe, voiceStatus } from "./voice.js";
import { act, assistantCapabilities, observe, requestAccessibility } from "./assistant.js";
import { AGENTS, AGENT_LIMITS, agentAvailability, isAgentEngine, runAgentTurn } from "./agent-cli.js";
import { agentModels, recordResolution } from "./agent-models.js";
import { appendUsage, summariseUsage, usageRecord } from "./usage-ledger.js";
import { isValidLogin, readAdmins, requireAdmin, whoami, writeAdmins } from "./admin.js";
import { appendRun, createSandbox, measureSandbox, readRuns, removeRun } from "./arena.js";
import { currentVersion, publishRelease, validateNextVersion } from "./releases.js";
import { checkForUpdate, downloadAsset } from "./updates.js";
import { readdir as readNodeDir, readFile as readNodeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { MAX_FILE_BYTES, extractFilePart, fileCapabilities, ingestFile } from "./files.js";
import { detectDevice } from "./device.js";
import { guardianSnapshot, unloadModel } from "./guardian.js";
import { createAutoUnloadSweep } from "./guardian-autounload.js";
import { cloneRepo, githubStatus, listRepos } from "./github.js";
import {
  assessStorage,
  listOpenApps,
  hasUnsavedWork,
  planClosures,
  purgeableBytes,
  quitApp,
  reclaimTargets,
  trackFocus,
} from "./guardian-governor.js";
import { getFocusRegistry, readGovernorSettings, setFocusRegistry, writeGovernorSettings } from "./guardian-state.js";
import { buildLibrary, planRouting, resolveModel } from "./model-catalog.js";
import {
  PROVIDER_IDS,
  clearProviderKey,
  describeProviders,
  planHostedRouting,
  readStore,
  setProviderKey,
  setProviderLanes,
  validateKey,
  writeStore,
} from "./providers.js";
import { forgetProject, listRecentProjects, rememberProject, validateProjectRoot } from "./projects.js";
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

/**
 * Stops long-running work when the client goes away.
 *
 * Listens on the *response*, not the request. Every streaming route below reads
 * its JSON body first, and reading an `IncomingMessage` to the end destroys it
 * — so `request` has already emitted "close" before a handler could attach a
 * listener, and that listener never fires. Watching the response is what makes
 * a closed tab or an aborted fetch actually kill the process behind it.
 */
function abortWhenClientLeaves(response, controller) {
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
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

function projectError(error) {
  const code = error instanceof Error ? error.message : "PROJECT_OPEN_FAILED";
  if (code === "INVALID_PROJECT_PATH") return new GatewayError(400, code, "A valid absolute folder path is required.");
  if (code === "PROJECT_NOT_FOUND") return new GatewayError(404, code, "That folder does not exist.");
  if (code === "PROJECT_NOT_A_DIRECTORY") return new GatewayError(400, code, "That path is a file, not a folder.");
  if (code === "PROJECT_ROOT_TOO_BROAD") return new GatewayError(400, code, "Choose a project folder rather than the filesystem or home root.");
  return new GatewayError(500, "PROJECT_OPEN_FAILED", "The project could not be opened.", { cause: error });
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
      const rawOrigin = request.headers.origin;
      // A browser always sends Origin on cross-origin and CORS-preflighted requests.
      // Never fabricate one for header-less loopback callers: /session would then hand
      // the bearer token to any local process that simply omits the header.
      const origin = rawOrigin || null;
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

      /* ── Guardian ─────────────────────────────────────────────────────────
         Live host telemetry and Ollama residency. Read-only apart from the
         unload, which is the one thing the operator can act on from here.
         ------------------------------------------------------------------ */

      if (request.method === "GET" && route === "/api/guardian/snapshot") {
        // Settings so the advice thresholds match the ones the sweep acts on.
        replyJson(response, 200, await guardianSnapshot({
          ollamaUrl: config.ollamaUrl.toString(),
          fetchImpl,
          settings: readGovernorSettings(config.guardianStorePath),
        }));
        return;
      }

      if (request.method === "POST" && route === "/api/guardian/unload") {
        const unloadRequest = await readJson(request, config.maxJsonBytes);
        try {
          const result = await unloadModel(unloadRequest?.model, {
            ollamaUrl: config.ollamaUrl.toString(),
            fetchImpl,
          });
          // Evicting a model changes what every other session on this machine
          // can do next, so it belongs in the audit trail like any other write.
          await audit.write({
            event: "guardian-model-unloaded",
            correlationId,
            method: request.method,
            route,
            model: result.model,
            unloaded: result.unloaded,
            freedBytes: result.freedBytes,
          });
          replyJson(response, 200, result);
        } catch (error) {
          throw new GatewayError(error.status || 502, error.code || "UNLOAD_FAILED", error.message);
        }
        return;
      }

      /* ── File ingestion ───────────────────────────────────────────────────
         Anything dropped, pasted or picked in the chat lands here and comes
         back as something a model can actually read. See files.js for which
         tool handles which kind.
         ------------------------------------------------------------------ */

      if (request.method === "GET" && route === "/api/files/capabilities") {
        replyJson(response, 200, await fileCapabilities());
        return;
      }

      if (request.method === "POST" && route === "/api/files/ingest") {
        const contentType = request.headers["content-type"] || "";
        if (!contentType.startsWith("multipart/form-data")) {
          throw new GatewayError(400, "FILE_UPLOAD_REQUIRED", "Send the file as multipart/form-data.");
        }
        let body;
        try {
          body = await readBounded(request, MAX_FILE_BYTES);
        } catch (error) {
          throw new GatewayError(error.status || 413, error.code || "FILE_TOO_LARGE", error.message);
        }

        const part = extractFilePart(body, contentType);
        if (!part.buffer || part.buffer.length === 0) {
          throw new GatewayError(400, "EMPTY_FILE", "That file is empty.");
        }

        const result = await ingestFile(part.buffer, part.filename, { mimeType: part.mimeType });
        await audit.write({
          event: "file-ingested",
          correlationId,
          method: request.method,
          route,
          kind: result.kind,
          bytes: result.bytes,
          tool: result.tool,
          // The file's contents are never written to the audit log.
          extractedChars: typeof result.text === "string" ? result.text.length : 0,
        });
        replyJson(response, 200, result);
        return;
      }

      /* ── Guardian governor ────────────────────────────────────────────────
         Can close applications, so every route here is read-only unless the
         caller explicitly confirms. See guardian-governor.js for the safety
         rules; the short version is that unknown is treated as unsafe and a
         quit is never escalated.
         ------------------------------------------------------------------ */

      if (request.method === "GET" && route === "/api/guardian/governor") {
        const settings = readGovernorSettings(config.guardianStorePath);
        const inventory = await listOpenApps();

        // Record who is in front, so idle time can be observed rather than guessed.
        if (inventory.frontmost) setFocusRegistry(trackFocus(getFocusRegistry(), inventory.frontmost));

        const snapshot = await guardianSnapshot({ processLimit: 40 });
        const byApp = new Map((snapshot.processes?.byMemory ?? []).map((entry) => [entry.name, entry]));

        // Asking every app about unsaved work is a round trip each; only the
        // ones that could actually be closed are worth interrogating.
        const apps = await Promise.all(
          inventory.apps.map(async (name) => {
            const process = byApp.get(name);
            return {
              name,
              pid: process?.pid ?? null,
              rssBytes: process?.rssBytes ?? null,
              cpuPercent: process?.cpuPercent ?? null,
              ageSeconds: null,
              hasUnsavedWork: await hasUnsavedWork(name),
            };
          }),
        );

        const plan = planClosures(apps, {
          settings,
          frontmost: inventory.frontmost,
          focusRegistry: getFocusRegistry(),
        });

        const purgeable = await purgeableBytes();
        replyJson(response, 200, {
          settings,
          supported: inventory.supported,
          detail: inventory.detail ?? null,
          frontmost: inventory.frontmost,
          apps,
          plan,
          storage: assessStorage(snapshot.disk, purgeable, settings),
        });
        return;
      }

      if (request.method === "POST" && route === "/api/guardian/governor/settings") {
        const settingsRequest = await readJson(request, config.maxJsonBytes);
        const saved = writeGovernorSettings(config.guardianStorePath, settingsRequest ?? {});
        await audit.write({
          event: "guardian-settings-changed", correlationId, method: request.method, route,
          enabled: saved.enabled, maxApps: saved.maxApps,
        });
        replyJson(response, 200, { settings: saved });
        return;
      }

      if (request.method === "POST" && route === "/api/guardian/governor/enforce") {
        const enforceRequest = await readJson(request, config.maxJsonBytes);
        const settings = readGovernorSettings(config.guardianStorePath);

        // Two independent gates: the feature must be on, and this specific run
        // must be confirmed. Neither implies the other.
        if (!settings.enabled) {
          throw new GatewayError(409, "GOVERNOR_DISABLED", "The app governor is switched off.");
        }
        if (enforceRequest?.confirm !== true) {
          throw new GatewayError(400, "CONFIRMATION_REQUIRED", "Closing apps requires an explicit confirmation.");
        }
        const names = Array.isArray(enforceRequest?.apps) ? enforceRequest.apps.filter((n) => typeof n === "string") : [];
        if (names.length === 0) {
          throw new GatewayError(400, "NO_APPS_SPECIFIED", "Name the apps to close.");
        }
        if (names.length > 10) {
          throw new GatewayError(400, "TOO_MANY_APPS", "Close at most ten apps in one run.");
        }

        // Re-derive the plan now rather than trusting the client's list: the
        // machine may have changed since it was shown, and an app that has
        // since been focused or opened a document must no longer be a target.
        const inventory = await listOpenApps();
        const snapshot = await guardianSnapshot({ processLimit: 40 });
        const byApp = new Map((snapshot.processes?.byMemory ?? []).map((entry) => [entry.name, entry]));
        const apps = await Promise.all(
          inventory.apps.map(async (name) => ({
            name,
            pid: byApp.get(name)?.pid ?? null,
            rssBytes: byApp.get(name)?.rssBytes ?? null,
            cpuPercent: byApp.get(name)?.cpuPercent ?? null,
            ageSeconds: null,
            hasUnsavedWork: await hasUnsavedWork(name),
          })),
        );
        const plan = planClosures(apps, {
          settings,
          frontmost: inventory.frontmost,
          focusRegistry: getFocusRegistry(),
        });
        const permitted = new Set(plan.selected.map((entry) => entry.name));

        const results = [];
        for (const name of names) {
          if (!permitted.has(name)) {
            results.push({ name, quit: false, detail: "No longer safe to close; skipped." });
            continue;
          }
          results.push(await quitApp(name));
        }

        await audit.write({
          event: "guardian-apps-closed", correlationId, method: request.method, route,
          requested: names.length, closed: results.filter((r) => r.quit).length,
        });
        replyJson(response, 200, { results });
        return;
      }

      if (request.method === "GET" && route === "/api/guardian/storage") {
        const settings = readGovernorSettings(config.guardianStorePath);
        const snapshot = await guardianSnapshot({});
        const [purgeable, targets] = await Promise.all([purgeableBytes(), reclaimTargets()]);
        replyJson(response, 200, {
          storage: assessStorage(snapshot.disk, purgeable, settings),
          // Reported only. Guardian never deletes anything.
          reclaim: targets,
        });
        return;
      }

      /* ── GitHub ───────────────────────────────────────────────────────────
         Prefers the already-authenticated `gh` CLI so the studio never has to
         hold a credential of its own; falls back to a stored token.
         ------------------------------------------------------------------ */

      if (request.method === "GET" && route === "/api/github/status") {
        const store = readStore(config.providerStorePath);
        const token = store.github?.token ?? process.env.GITHUB_TOKEN ?? null;
        replyJson(response, 200, await githubStatus({ token }));
        return;
      }

      if (request.method === "GET" && route === "/api/github/repos") {
        const store = readStore(config.providerStorePath);
        const token = store.github?.token ?? process.env.GITHUB_TOKEN ?? null;
        try {
          replyJson(response, 200, await listRepos({ token }));
        } catch (error) {
          throw new GatewayError(error.status || 502, error.code || "GITHUB_LIST_FAILED", error.message);
        }
        return;
      }

      if (request.method === "POST" && route === "/api/github/token") {
        const tokenRequest = await readJson(request, config.maxJsonBytes);
        const store = readStore(config.providerStorePath);
        const value = tokenRequest?.token;

        if (value === null || value === "") {
          writeStore(config.providerStorePath, { ...store, github: {} });
          await audit.write({ event: "github-token-cleared", correlationId, method: request.method, route });
          replyJson(response, 200, await githubStatus({ token: null }));
          return;
        }
        if (typeof value !== "string" || value.trim().length < 20 || /\s/.test(value.trim())) {
          throw new GatewayError(400, "INVALID_GITHUB_TOKEN", "That does not look like a GitHub token.");
        }
        const token = value.trim();
        const status = await githubStatus({ token });
        if (!status.connected) {
          throw new GatewayError(400, "GITHUB_TOKEN_REJECTED", status.detail || "GitHub rejected that token.");
        }
        writeStore(config.providerStorePath, {
          ...store,
          github: { token, updatedAt: new Date().toISOString() },
        });
        await audit.write({
          event: "github-token-set", correlationId, method: request.method, route, login: status.login,
        });
        replyJson(response, 200, status);
        return;
      }

      if (request.method === "POST" && route === "/api/github/clone") {
        const cloneRequest = await readJson(request, config.maxJsonBytes);
        const store = readStore(config.providerStorePath);
        const token = store.github?.token ?? process.env.GITHUB_TOKEN ?? null;
        try {
          // Repositories land beside the current workspace root, not inside it,
          // so a clone never nests one project within another.
          const parentDir = dirname(config.workspaceRoot);
          const cloned = await cloneRepo(cloneRequest?.repo, {
            parentDir,
            directory: typeof cloneRequest?.directory === "string" ? cloneRequest.directory : null,
            token,
          });
          // Make the clone immediately available in the project switcher.
          await rememberProject(config.projectsStorePath, { path: cloned.path, name: cloned.name });
          await audit.write({
            event: "github-repo-cloned", correlationId, method: request.method, route,
            repo: cloneRequest?.repo, path: cloned.path,
          });
          replyJson(response, 201, cloned);
        } catch (error) {
          throw new GatewayError(error.status || 502, error.code || "GITHUB_CLONE_FAILED", error.message);
        }
        return;
      }

      /* ── Device, model library, and routing ───────────────────────────────
         The library is the one place that answers "will this model actually
         run here". Everything it reports is arithmetic against the detected
         machine, so the badges mean something rather than being decorative.
         ------------------------------------------------------------------ */

      if (request.method === "GET" && route === "/api/system/device") {
        replyJson(response, 200, detectDevice());
        return;
      }

      if (request.method === "GET" && route === "/api/models/library") {
        const device = detectDevice();
        let installed = [];
        let connected = false;
        try {
          const tagsResponse = await fetchImpl(joinUrl(config.ollamaUrl, "api/tags"), {
            signal: AbortSignal.timeout(3000),
          });
          if (tagsResponse.ok) {
            installed = (await tagsResponse.json())?.models ?? [];
            connected = true;
          }
        } catch {
          // A missing Ollama is a normal state: the catalogue still renders,
          // every entry simply shows as not installed.
        }
        const library = buildLibrary(device, installed);
        replyJson(response, 200, {
          connected,
          device,
          models: library,
          routing: planRouting(library),
        });
        return;
      }

      if (request.method === "POST" && route === "/api/models/resolve") {
        const resolveRequest = await readJson(request, config.maxJsonBytes);
        const prompt = typeof resolveRequest?.prompt === "string" ? resolveRequest.prompt : "";
        const mode = ["flash", "auto", "max"].includes(resolveRequest?.mode) ? resolveRequest.mode : "auto";

        const device = detectDevice();
        let installed = [];
        try {
          const tagsResponse = await fetchImpl(joinUrl(config.ollamaUrl, "api/tags"), {
            signal: AbortSignal.timeout(3000),
          });
          if (tagsResponse.ok) installed = (await tagsResponse.json())?.models ?? [];
        } catch {
          /* Resolution still works; it will simply report a degraded plan. */
        }
        const library = buildLibrary(device, installed);
        const local = resolveModel(library, prompt, mode);

        const store = readStore(config.providerStorePath);
        const hosted = planHostedRouting(describeProviders(store));

        replyJson(response, 200, {
          mode,
          local,
          hosted: hosted.degraded
            ? { degraded: true }
            : { ...hosted, model: local.lane === "heavy" ? hosted.heavy : hosted.light },
        });
        return;
      }

      /* ── Hosted providers ─────────────────────────────────────────────────
         Keys are written 0600 and never read back out. Every response here
         carries a masked hint and a configured flag, nothing more.
         ------------------------------------------------------------------ */

      if (request.method === "GET" && route === "/api/providers") {
        const store = readStore(config.providerStorePath);
        const described = describeProviders(store);
        replyJson(response, 200, {
          providers: described,
          routing: planHostedRouting(described),
        });
        return;
      }

      if (request.method === "POST" && route === "/api/providers/key") {
        const keyRequest = await readJson(request, config.maxJsonBytes);
        const providerId = keyRequest?.provider;
        if (!PROVIDER_IDS.includes(providerId)) {
          throw new GatewayError(400, "UNKNOWN_PROVIDER", `Provider must be one of: ${PROVIDER_IDS.join(", ")}.`);
        }

        const store = readStore(config.providerStorePath);
        let next;
        if (keyRequest?.key === null || keyRequest?.key === "") {
          next = clearProviderKey(store, providerId);
        } else {
          const validation = validateKey(providerId, keyRequest?.key);
          if (!validation.ok) throw new GatewayError(400, "INVALID_API_KEY", validation.message);
          next = setProviderKey(store, providerId, validation.value);
        }
        writeStore(config.providerStorePath, next);

        await audit.write({
          event: keyRequest?.key ? "provider-key-set" : "provider-key-cleared",
          correlationId,
          method: request.method,
          route,
          provider: providerId,
          // The key itself is never written to the audit log.
        });

        const described = describeProviders(next);
        replyJson(response, 200, { providers: described, routing: planHostedRouting(described) });
        return;
      }

      if (request.method === "POST" && route === "/api/providers/lanes") {
        const laneRequest = await readJson(request, config.maxJsonBytes);
        const providerId = laneRequest?.provider;
        if (!PROVIDER_IDS.includes(providerId)) {
          throw new GatewayError(400, "UNKNOWN_PROVIDER", `Provider must be one of: ${PROVIDER_IDS.join(", ")}.`);
        }
        for (const field of ["lightModel", "heavyModel"]) {
          const value = laneRequest?.[field];
          if (value !== undefined && (typeof value !== "string" || value.trim().length === 0 || value.length > 200)) {
            throw new GatewayError(400, "INVALID_MODEL_ID", `${field} must be a non-empty model identifier.`);
          }
        }
        const store = readStore(config.providerStorePath);
        const next = setProviderLanes(store, providerId, {
          lightModel: laneRequest?.lightModel,
          heavyModel: laneRequest?.heavyModel,
          enabled: typeof laneRequest?.enabled === "boolean" ? laneRequest.enabled : undefined,
        });
        writeStore(config.providerStorePath, next);
        const described = describeProviders(next);
        replyJson(response, 200, { providers: described, routing: planHostedRouting(described) });
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

      if (request.method === "GET" && route === "/api/workspace/projects") {
        replyJson(response, 200, {
          current: { path: config.workspaceRoot, name: config.workspaceRoot.split("/").filter(Boolean).pop() || config.workspaceRoot },
          recent: await listRecentProjects(config.projectsStorePath),
        });
        return;
      }

      if (request.method === "POST" && route === "/api/workspace/open") {
        const openRequest = await readJson(request, config.maxJsonBytes);
        let project;
        try {
          project = await validateProjectRoot(openRequest?.path);
        } catch (error) {
          throw projectError(error);
        }
        // The workspace root is what every workspace and terminal route is bounded
        // to, so switching it is the one mutation that changes their reach.
        config.workspaceRoot = project.path;
        const recent = await rememberProject(config.projectsStorePath, project);
        await audit.write({ event: "workspace-opened", correlationId, method: request.method, route, path: project.path });
        replyJson(response, 200, { current: project, recent });
        return;
      }

      if (request.method === "POST" && route === "/api/workspace/projects/forget") {
        const forgetRequest = await readJson(request, config.maxJsonBytes);
        if (typeof forgetRequest?.path !== "string" || !forgetRequest.path) {
          throw new GatewayError(400, "INVALID_PROJECT_PATH", "A project path is required.");
        }
        replyJson(response, 200, { recent: await forgetProject(config.projectsStorePath, forgetRequest.path) });
        return;
      }

      if (request.method === "POST" && route === "/api/workspace/search") {
        const searchRequest = await readJson(request, config.maxJsonBytes);
        try {
          replyJson(response, 200, await searchWorkspace(config.workspaceRoot, searchRequest?.query, {
            caseSensitive: Boolean(searchRequest?.caseSensitive),
            regex: Boolean(searchRequest?.regex),
            wholeWord: Boolean(searchRequest?.wholeWord),
          }));
        } catch (error) {
          const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "SEARCH_FAILED";
          throw new GatewayError(code === "SEARCH_FAILED" ? 500 : 400, code, {
            SEARCH_QUERY_REQUIRED: "A search query is required.",
            SEARCH_QUERY_TOO_LONG: "The search query is too long.",
            SEARCH_PATTERN_INVALID: "That regular expression is not valid.",
          }[code] ?? "The workspace search failed.");
        }
        return;
      }

      if (request.method === "GET" && route === "/api/benchmarks/latest") {
        // The analyzer validates the artifact itself — provenance hashes and
        // all — so the gateway's job is only to hand over the newest one and to
        // say plainly when there is none, rather than 404 into a generic error.
        try {
          const directory = joinPath(process.cwd(), "benchmark-results");
          const names = await readNodeDir(directory);
          const candidates = names.filter((name) => name.endsWith(".json") && name.includes("score"));
          if (candidates.length === 0) {
            throw new GatewayError(404, "NO_BENCHMARK_ARTIFACT", "No benchmark score artifact has been produced yet.");
          }
          candidates.sort();
          const newest = candidates[candidates.length - 1];
          replyJson(response, 200, JSON.parse(await readNodeFile(joinPath(directory, newest), "utf8")));
        } catch (error) {
          if (error instanceof GatewayError) throw error;
          throw new GatewayError(404, "NO_BENCHMARK_ARTIFACT", "No benchmark score artifact has been produced yet.");
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

      /* ── Voice ────────────────────────────────────────────────────────────
         Three routes in front of an optional local speech sidecar. Every one
         of them treats "no sidecar" as a normal answer, because the studio is
         designed to fall back to the browser engine rather than lose voice.
         ------------------------------------------------------------------ */

      if (request.method === "GET" && route === "/api/voice/status") {
        replyJson(response, 200, await voiceStatus(config));
        return;
      }

      if (request.method === "POST" && route === "/api/voice/transcribe") {
        const status = await voiceStatus(config);
        if (!status.available || !status.asr) {
          throw new GatewayError(503, "VOICE_ASR_UNAVAILABLE", status.detail || "No speech recogniser is running.");
        }
        const contentType = request.headers["content-type"] || "";
        if (!contentType.startsWith("multipart/form-data")) {
          throw new GatewayError(400, "VOICE_AUDIO_REQUIRED", "Audio must be uploaded as multipart/form-data.");
        }
        let audio;
        try {
          audio = await readBounded(request, config.voiceMaxAudioBytes);
        } catch (error) {
          throw new GatewayError(error.status || 400, error.code || "VOICE_AUDIO_INVALID", error.message);
        }
        try {
          const language = /name="language"[\s\S]{0,120}?\r\n\r\n([^\r]+)/.exec(audio.toString("latin1"))?.[1]?.trim() ?? "auto";
          const result = await transcribe(config, { body: audio, contentType, language });
          await audit.write({
            event: "voice-transcribed",
            correlationId,
            method: request.method,
            route,
            bytes: audio.length,
            language: typeof result?.language === "string" ? result.language : null,
            // The transcript itself is never written to the audit log.
            characters: typeof result?.text === "string" ? result.text.length : 0,
          });
          replyJson(response, 200, result);
        } catch (error) {
          throw new GatewayError(error.status || 502, error.code || "VOICE_TRANSCRIBE_FAILED", error.message);
        }
        return;
      }

      if (request.method === "POST" && route === "/api/voice/speak") {
        const status = await voiceStatus(config);
        if (!status.available || !status.tts) {
          throw new GatewayError(503, "VOICE_TTS_UNAVAILABLE", status.detail || "No speech synthesiser is running.");
        }
        const speakRequest = await readJson(request, config.maxJsonBytes);
        if (typeof speakRequest?.text !== "string" || speakRequest.text.trim().length === 0) {
          throw new GatewayError(400, "VOICE_TEXT_REQUIRED", "Text to speak is required.");
        }
        if (speakRequest.text.length > 8000) {
          throw new GatewayError(400, "VOICE_TEXT_TOO_LONG", "The text to speak exceeds the allowed length.");
        }
        try {
          const audio = await speak(config, {
            text: speakRequest.text,
            language: typeof speakRequest.language === "string" ? speakRequest.language : "en-US",
            voice: typeof speakRequest.voice === "string" ? speakRequest.voice : null,
            rate: Number.isFinite(speakRequest.rate) ? speakRequest.rate : 1,
          });
          response.writeHead(200, {
            "content-type": audio.contentType,
            "content-length": audio.body.length,
            "cache-control": "no-store",
          });
          response.end(audio.body);
        } catch (error) {
          throw new GatewayError(error.status || 502, error.code || "VOICE_SPEAK_FAILED", error.message);
        }
        return;
      }

      /* ── Screen assistant ────────────────────────────────────────────────
         The only routes in this gateway that can move the operator's pointer.

         Note what /api/assistant/act does not accept: a coordinate. A step
         names an element from a stored observation and the frame the operating
         system reported for that element is what gets clicked. There is no
         request shape that lets a model's guess at a position reach the screen,
         which is the whole reason the accessibility tree is read at all.
         ──────────────────────────────────────────────────────────────────── */

      if (request.method === "GET" && route === "/api/assistant/capabilities") {
        replyJson(response, 200, await assistantCapabilities());
        return;
      }

      if (request.method === "POST" && route === "/api/assistant/permissions") {
        // Raises the system's own Accessibility dialog. Only ever on an
        // explicit operator action — never on a poll, or it would nag.
        await audit.write({ event: "assistant-permission-prompt", correlationId, method: request.method, route });
        replyJson(response, 200, await requestAccessibility());
        return;
      }

      if (request.method === "POST" && route === "/api/assistant/observe") {
        const observeRequest = await readJson(request, config.maxJsonBytes);
        const maxElements = Number(observeRequest?.maxElements);
        try {
          const observation = await observe(config, {
            maxElements: Number.isFinite(maxElements) ? Math.max(10, Math.min(400, maxElements)) : 120,
            describe: observeRequest?.describe !== false,
            fetchImpl,
          });
          await audit.write({
            event: "assistant-observed",
            correlationId,
            method: request.method,
            route,
            application: observation.application?.name ?? null,
            elements: observation.elements.length,
            truncated: observation.truncated,
            described: Boolean(observation.sceneDescription),
            limits: observation.limits,
            // Neither the frame nor its description is written to the audit log.
          });
          // The frame stays on disk under the gateway; the renderer is told an
          // id, not a path, so a screenshot of the operator's screen is not
          // handed to the page for it to do anything else with.
          replyJson(response, 200, { ...observation, frame: observation.frame ? { available: true } : null });
        } catch (error) {
          throw new GatewayError(error.code === "POINTER_HELPER_MISSING" ? 503 : 502, error.code || "ASSISTANT_OBSERVE_FAILED", error.message);
        }
        return;
      }

      if (request.method === "POST" && route === "/api/assistant/act") {
        const actRequest = await readJson(request, config.maxJsonBytes);
        if (typeof actRequest?.observationId !== "string" || !actRequest.observationId) {
          throw new GatewayError(400, "OBSERVATION_REQUIRED", "An action must name the look at the screen it came from.");
        }
        if (actRequest?.step === null || typeof actRequest?.step !== "object") {
          throw new GatewayError(400, "STEP_REQUIRED", "An action must carry a step.");
        }
        try {
          const result = await act(actRequest.observationId, actRequest.step);
          await audit.write({
            event: "assistant-acted",
            correlationId,
            method: request.method,
            route,
            kind: actRequest.step.kind,
            element: typeof actRequest.step.element === "string" ? actRequest.step.element : null,
            // What was typed is never written to the audit log; how much was, is.
            characters: typeof result.characters === "number" ? result.characters : null,
          });
          replyJson(response, 200, { ok: true, result });
        } catch (error) {
          await audit.write({
            event: "assistant-refused",
            correlationId,
            method: request.method,
            route,
            kind: typeof actRequest.step?.kind === "string" ? actRequest.step.kind : null,
            code: error.code || "ASSISTANT_ACT_FAILED",
          });
          throw new GatewayError(409, error.code || "ASSISTANT_ACT_FAILED", error.message);
        }
        return;
      }

      if (request.method === "GET" && route === "/api/agents") {
        replyJson(response, 200, { agents: await agentAvailability() });
        return;
      }

      /* ── Updates ─────────────────────────────────────────────────────────
         The check goes to GitHub's public Releases API, not the `gh` CLI. Every
         install runs this and almost none of them have gh, so the old check
         reported "the GitHub CLI is not installed" to every user who had one
         available. Publishing still uses gh — see /api/updates/publish — because
         that is an administrator action on a machine where gh is authenticated.
         ──────────────────────────────────────────────────────────────────── */

      if (request.method === "POST" && route === "/api/updates/download") {
        const downloadRequest = await readJson(request, config.maxJsonBytes);
        const abort = new AbortController();
        abortWhenClientLeaves(response, abort);

        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-correlation-id": correlationId,
        });
        const send = (event) => {
          if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
        };

        try {
          // Throttled: a 130 MB download emits thousands of chunks and a line
          // per chunk would cost more than the transfer it is describing.
          let lastSentAt = 0;
          const result = await downloadAsset({
            url: downloadRequest?.url,
            name: downloadRequest?.name,
            signal: abort.signal,
            onProgress: ({ received, total }) => {
              const now = Date.now();
              if (now - lastSentAt < 200 && received !== total) return;
              lastSentAt = now;
              send({ type: "progress", received, total });
            },
          });
          send({ type: "done", ...result });
          await audit.write({
            event: "update-downloaded",
            correlationId,
            method: request.method,
            route,
            name: downloadRequest?.name ?? null,
            bytes: result.bytes,
          });
        } catch (error) {
          const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "UPDATE_DOWNLOAD_FAILED";
          send({ type: "error", code, message: "The update could not be downloaded." });
        }
        response.end();
        return;
      }

      if (request.method === "GET" && route === "/api/updates/check") {
        // Available to every install, not just administrators: knowing you are
        // behind is not a privileged fact.
        replyJson(response, 200, await checkForUpdate({ appRoot: config.appRoot, repo: config.releaseRepo }));
        return;
      }

      if (request.method === "POST" && route === "/api/updates/publish") {
        await requireAdmin(config.adminStorePath, (message) => new GatewayError(403, "ADMIN_REQUIRED", message));
        const body = await readJson(request, config.maxJsonBytes);

        let version;
        try {
          version = await validateNextVersion(config.appRoot, body?.version);
        } catch (error) {
          const code = error instanceof Error ? error.message : "INVALID_VERSION";
          throw new GatewayError(400, code, code === "VERSION_NOT_AHEAD"
            ? `Version ${body?.version} is not ahead of ${await currentVersion(config.appRoot)}.`
            : "Provide a semver version such as 1.1.0.");
        }

        const abort = new AbortController();
        // A release is a long build; closing the tab stops it rather than
        // leaving a publish running unattended.
        abortWhenClientLeaves(response, abort);

        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-correlation-id": correlationId,
        });
        const send = (event) => {
          if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
        };

        const outcome = await publishRelease({
          appRoot: config.appRoot,
          version,
          notes: typeof body?.notes === "string" ? body.notes : "",
          // A publish now tags and pushes, and CI builds from that tag. The
          // repository is therefore part of the operation rather than something
          // only the update check needed to know.
          repo: config.releaseRepo,
          dryRun: body?.dryRun !== false,
          onEvent: send,
          signal: abort.signal,
        });
        send({ type: "finished", ...outcome });
        await audit.write({
          event: "release-publish",
          correlationId,
          method: request.method,
          route,
          version,
          dryRun: body?.dryRun !== false,
          ok: outcome.ok,
          durationMs: outcome.durationMs,
        });
        response.end();
        return;
      }

      if (request.method === "GET" && route === "/api/me") {
        replyJson(response, 200, await whoami(config.adminStorePath));
        return;
      }

      if (request.method === "POST" && route === "/api/admin/claim") {
        // Bootstrapping: the first connected GitHub account may make itself the
        // administrator, and only while there is none. Once one exists this
        // route can never widen access again — adding another admin is done by
        // an existing one, below.
        const identity = await whoami(config.adminStorePath);
        if (!identity.canClaim) {
          throw new GatewayError(
            409,
            identity.login ? "ADMIN_ALREADY_SET" : "GITHUB_NOT_CONNECTED",
            identity.login
              ? "This studio already has an administrator."
              : "Connect GitHub before claiming administrator access.",
          );
        }
        await writeAdmins(config.adminStorePath, [identity.login]);
        await audit.write({ event: "admin-claimed", correlationId, method: request.method, route, login: identity.login });
        replyJson(response, 200, await whoami(config.adminStorePath));
        return;
      }

      if (request.method === "POST" && route === "/api/admin/admins") {
        await requireAdmin(config.adminStorePath, (message) => new GatewayError(403, "ADMIN_REQUIRED", message));
        const body = await readJson(request, config.maxJsonBytes);
        const logins = Array.isArray(body?.admins) ? body.admins : null;
        if (!logins || !logins.every(isValidLogin)) {
          throw new GatewayError(400, "INVALID_ADMINS", "Provide a list of valid GitHub logins.");
        }
        const { locked } = await readAdmins(config.adminStorePath);
        // An env-pinned admin cannot be removed through the API; that is the
        // point of pinning one.
        await writeAdmins(config.adminStorePath, [...new Set([...locked, ...logins])]);
        replyJson(response, 200, await whoami(config.adminStorePath));
        return;
      }

      /* ── Benchmark arena (administrators only) ─────────────────────────
         Every route below creates directories, runs agents that write code and
         spends real money, so the gate is here on the server. The renderer also
         hides the panel, but that is a courtesy, not the control. */

      if (request.method === "POST" && route === "/api/arena/sandbox") {
        await requireAdmin(config.adminStorePath, (message) => new GatewayError(403, "ADMIN_REQUIRED", message));
        const body = await readJson(request, config.maxJsonBytes);
        if (!Array.isArray(body?.contestants) || body.contestants.length === 0) {
          throw new GatewayError(400, "CONTESTANTS_REQUIRED", "Name at least one contestant.");
        }
        if (body.contestants.length > 4) {
          throw new GatewayError(400, "TOO_MANY_CONTESTANTS", "At most four contestants in one run.");
        }
        try {
          const sandboxes = [];
          for (const contestantId of body.contestants) {
            sandboxes.push({
              contestantId,
              ...(await createSandbox({ root: config.workspaceRoot, runId: body.runId, contestantId })),
            });
          }
          await audit.write({ event: "arena-sandbox", correlationId, method: request.method, route, runId: body.runId, contestants: body.contestants.length });
          replyJson(response, 200, { runId: body.runId, sandboxes: sandboxes.map(({ path, ...rest }) => rest) });
        } catch (error) {
          const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "ARENA_SANDBOX_FAILED";
          throw new GatewayError(400, code, "The sandbox could not be prepared.");
        }
        return;
      }

      if (request.method === "POST" && route === "/api/arena/measure") {
        await requireAdmin(config.adminStorePath, (message) => new GatewayError(403, "ADMIN_REQUIRED", message));
        const body = await readJson(request, config.maxJsonBytes);
        try {
          replyJson(response, 200, await measureSandbox({
            root: config.workspaceRoot,
            runId: body?.runId,
            contestantId: body?.contestantId,
            verify: Array.isArray(body?.verify) ? body.verify.slice(0, 4) : [],
          }));
        } catch (error) {
          const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "ARENA_MEASURE_FAILED";
          throw new GatewayError(400, code, "The sandbox could not be measured.");
        }
        return;
      }

      /* The same measurement, watchable while it happens. The diff is instant
         but the checks after it are a typecheck and a full test suite, so a
         caller that waits for one JSON body stares at a spinner for a minute
         with no idea which check is running or whether the first one passed. */
      if (request.method === "POST" && route === "/api/arena/measure/stream") {
        await requireAdmin(config.adminStorePath, (message) => new GatewayError(403, "ADMIN_REQUIRED", message));
        const body = await readJson(request, config.maxJsonBytes);

        const abort = new AbortController();
        // Stopping the benchmark stops the checks: they are real processes in
        // a directory that is about to be deleted.
        abortWhenClientLeaves(response, abort);

        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-correlation-id": correlationId,
        });
        const send = (event) => {
          if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
        };

        try {
          const measurement = await measureSandbox({
            root: config.workspaceRoot,
            runId: body?.runId,
            contestantId: body?.contestantId,
            verify: Array.isArray(body?.verify) ? body.verify.slice(0, 4) : [],
            signal: abort.signal,
            onEvent: send,
          });
          // The full measurement closes the stream, so a client that missed an
          // event still ends up with the same object the blocking route returns.
          send({ type: "result", measurement });
        } catch (error) {
          const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "ARENA_MEASURE_FAILED";
          send({ type: "error", code, message: "The sandbox could not be measured." });
        }
        response.end();
        return;
      }

      if (request.method === "GET" && route === "/api/arena/history") {
        await requireAdmin(config.adminStorePath, (message) => new GatewayError(403, "ADMIN_REQUIRED", message));
        const query = new URL(request.url, "http://127.0.0.1").searchParams;
        const limit = Math.min(200, Math.max(1, Number(query.get("limit")) || 50));
        replyJson(response, 200, { runs: await readRuns(config.arenaHistoryPath, limit) });
        return;
      }

      if (request.method === "POST" && route === "/api/arena/history") {
        await requireAdmin(config.adminStorePath, (message) => new GatewayError(403, "ADMIN_REQUIRED", message));
        const body = await readJson(request, config.maxJsonBytes);
        replyJson(response, 200, { recorded: await appendRun(config.arenaHistoryPath, body) });
        return;
      }

      if (request.method === "POST" && route === "/api/arena/cleanup") {
        await requireAdmin(config.adminStorePath, (message) => new GatewayError(403, "ADMIN_REQUIRED", message));
        const body = await readJson(request, config.maxJsonBytes);
        try {
          replyJson(response, 200, await removeRun(config.workspaceRoot, body?.runId));
        } catch {
          throw new GatewayError(400, "ARENA_CLEANUP_FAILED", "The run could not be removed.");
        }
        return;
      }

      if (request.method === "GET" && route === "/api/usage") {
        const query = new URL(request.url, "http://127.0.0.1").searchParams;
        const days = Math.min(90, Math.max(1, Number(query.get("days")) || 7));
        replyJson(response, 200, await summariseUsage(config.usageLedgerPath, { days }));
        return;
      }

      if (request.method === "POST" && route === "/api/usage") {
        // The local engine counts its own tokens in the renderer, so a local
        // turn is the one kind the gateway cannot observe for itself. Agent
        // turns are recorded above and must never be posted here as well, or
        // they would be counted twice.
        const usagePost = await readJson(request, config.maxJsonBytes);
        if (usagePost?.engine === "claude" || usagePost?.engine === "codex") {
          throw new GatewayError(400, "USAGE_DOUBLE_COUNT", "Agent turns are recorded by the gateway and must not be posted.");
        }
        if (typeof usagePost?.engine !== "string" || !usagePost.engine) {
          throw new GatewayError(400, "USAGE_ENGINE_REQUIRED", "An engine is required.");
        }
        await appendUsage(
          config.usageLedgerPath,
          usageRecord({
            engine: usagePost.engine,
            model: typeof usagePost.model === "string" ? usagePost.model : null,
            models: Array.isArray(usagePost.models) ? usagePost.models : [],
            usage: usagePost.usage,
            costUsd: usagePost.costUsd,
            durationMs: usagePost.durationMs,
          }),
        );
        replyJson(response, 200, { recorded: true });
        return;
      }

      if (request.method === "GET" && route === "/api/agents/models") {
        replyJson(response, 200, await agentModels({ storePath: config.agentModelStorePath }));
        return;
      }

      if (request.method === "POST" && route === "/api/agents/run") {
        const agentRequest = await readJson(request, config.maxJsonBytes);
        const engine = agentRequest?.engine;
        if (!isAgentEngine(engine)) {
          throw new GatewayError(400, "UNKNOWN_AGENT", "Engine must be one of: " + Object.keys(AGENTS).join(", ") + ".");
        }
        if (typeof agentRequest?.prompt !== "string" || agentRequest.prompt.trim().length === 0) {
          throw new GatewayError(400, "AGENT_PROMPT_REQUIRED", "A non-empty prompt is required.");
        }
        if (agentRequest.prompt.length > AGENT_LIMITS.maxPromptLength) {
          throw new GatewayError(400, "AGENT_PROMPT_TOO_LONG", "The prompt exceeds the allowed length.");
        }
        if (agentRequest.cwd !== undefined && typeof agentRequest.cwd !== "string") {
          throw new GatewayError(400, "INVALID_AGENT_CWD", "The working directory must be a workspace-relative string.");
        }
        if (agentRequest.sessionId !== undefined && agentRequest.sessionId !== null && typeof agentRequest.sessionId !== "string") {
          throw new GatewayError(400, "INVALID_AGENT_SESSION", "The session id must be a string.");
        }

        const abort = new AbortController();
        // Closing the tab must stop the agent. It is a real process doing
        // real work in the repository; leaving it running unattended is the
        // one outcome nobody asked for.
        abortWhenClientLeaves(response, abort);

        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-correlation-id": correlationId,
        });
        const requestedModel = typeof agentRequest.model === "string" && agentRequest.model ? agentRequest.model : null;
        const send = (event) => {
          // The CLI names the model it actually resolved to. Remembering it is
          // what lets the picker stop shipping a guess and start reporting an
          // observation — see server/agent-models.js.
          if (event?.type === "session" && event.model) {
            void recordResolution(config.agentModelStorePath, engine, requestedModel, event.model);
          }
          // Recorded here rather than from the renderer: the gateway sees every
          // turn, including one whose window was closed before it finished.
          if (event?.type === "result") {
            void appendUsage(
              config.usageLedgerPath,
              usageRecord({
                engine,
                model: requestedModel,
                models: event.usage?.models ?? [],
                usage: event.usage,
                costUsd: event.costUsd,
                durationMs: event.durationMs,
              }),
            );
          }
          if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
        };

        let outcome;
        try {
          outcome = await runAgentTurn({
            engine,
            prompt: agentRequest.prompt,
            root: config.workspaceRoot,
            cwd: agentRequest.cwd || "",
            sessionId: agentRequest.sessionId || null,
            model: requestedModel,
            permission: agentRequest.permission,
            signal: abort.signal,
            onEvent: send,
          });
        } catch (error) {
          const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "AGENT_START_FAILED";
          send({ type: "error", code, message: "The agent could not be started." });
          response.end();
          return;
        }

        send({ type: "done", ...outcome, summary: undefined });
        await audit.write({
          event: "agent-turn",
          correlationId,
          method: request.method,
          route,
          engine,
          durationMs: outcome.durationMs,
          truncated: outcome.truncated,
          reason: outcome.reason,
          // The prompt itself is deliberately not written to the audit log.
          promptBytes: Buffer.byteLength(agentRequest.prompt, "utf8"),
        });
        response.end();
        return;
      }

      if (request.method === "POST" && route === "/api/terminal/exec") {
        const commandRequest = await readJson(request, config.maxJsonBytes);
        if (typeof commandRequest?.command !== "string" || commandRequest.command.trim().length === 0) {
          throw new GatewayError(400, "TERMINAL_COMMAND_REQUIRED", "A non-empty shell command is required.");
        }
        if (commandRequest.command.length > TERMINAL_LIMITS.maxCommandLength) {
          throw new GatewayError(400, "TERMINAL_COMMAND_TOO_LONG", "The command exceeds the allowed length.");
        }
        if (commandRequest.cwd !== undefined && typeof commandRequest.cwd !== "string") {
          throw new GatewayError(400, "INVALID_TERMINAL_CWD", "The working directory must be a workspace-relative string.");
        }

        const abort = new AbortController();
        abortWhenClientLeaves(response, abort);

        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-correlation-id": correlationId,
        });
        const send = (event) => {
          if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
        };

        try {
          const result = await runWorkspaceCommand({
            root: config.workspaceRoot,
            command: commandRequest.command,
            cwd: commandRequest.cwd || "",
            signal: abort.signal,
            timeoutMs: config.terminalTimeoutMs,
            maxOutputBytes: config.terminalMaxOutputBytes,
            onChunk: send,
          });
          send({ type: "exit", ...result });
          await audit.write({
            event: "terminal-command",
            correlationId,
            method: request.method,
            route,
            status: result.code,
            durationMs: result.durationMs,
            bytes: result.bytes,
          });
        } catch (error) {
          const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "TERMINAL_EXECUTION_FAILED";
          send({ type: "exit", code: null, signal: null, truncated: false, reason: code, durationMs: 0, bytes: 0 });
        }
        response.end();
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

  /* Automatic VRAM release. Guardian's advice layer can only offer an unload
     the operator clicks; on a machine whose unified memory is shared with the
     model, an idle 15 GB model left wired is felt as system-wide lag long
     before anyone reads the advice. The sweep reads its settings on every pass
     rather than closing over them, so a settings change takes effect without a
     restart. */
  const autoUnload = createAutoUnloadSweep({
    readSettings: () => readGovernorSettings(config.guardianStorePath),
    onEvent: (event) => audit.write({ ...event, correlationId: null }),
  });

  return {
    server,
    config,
    sessionToken,
    tokenFingerprint,
    health,
    autoUnload,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      autoUnload.start();
      return server.address();
    },
    async close() {
      autoUnload.stop();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await audit.flush();
    },
  };
}
