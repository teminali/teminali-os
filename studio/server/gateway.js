import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { dirname, relative, sep, basename } from "node:path";
import { Readable, pipeline } from "node:stream";
import {
  MODEL_MODES,
  PROFILES,
  isExpertModelQualified,
  selectProfileForMode,
} from "../../gateway/frontier-runner.js";
import { BoundedAuditLog } from "./audit-log.js";
import { createConfig } from "./config.js";
import { countSeriesVideos, createWorkspaceDirectory, deleteWorkspaceFile, isStreamableWorkspaceFile, isViewableWorkspaceFile, listWorkspaceTree, readWorkspaceFile, resolveWorkspacePath, searchWorkspace, SERIES_MIN_EPISODES, WORKSPACE_LIMITS, writeWorkspaceFile } from "./workspace.js";
import { createPlayerRegistry, describePlayer, parsePlayerCommand, PlayerCommandError } from "./player-state.js";
import { extractSubtitleVtt, mediaTools, playbackPlan, probeMedia } from "./media-probe.js";
import { TERMINAL_LIMITS, runWorkspaceCommand } from "./terminal.js";
import { searchMachine } from "./machine-search.js";
import { forgetVoiceStatus, readBounded, speak, transcribe, voiceStatus } from "./voice.js";
import { act, assistantCapabilities, observe, requestAccessibility } from "./assistant.js";
import { AGENTS, AGENT_LIMITS, agentAvailability, isAgentEngine, runAgentTurn } from "./agent-cli.js";
import { emitToRun, requestApproval, requestCameraFrame, resolveApproval, resolveCameraFrame, runAuthorises, runHasEnded } from "./permission-bridge.js";
import { agentModels, recordResolution } from "./agent-models.js";
import { appendUsage, summariseUsage, usageRecord } from "./usage-ledger.js";
import { agentAccounts, readPlanLimits, recordPlanLimits } from "./plan.js";
import {
  grants,
  listPlans,
  pollSignIn,
  profileAllowed,
  readEntitlement,
  readOrder,
  refreshLicence,
  refusal,
  signOut,
  startCheckout,
  startSignIn,
} from "./licence.js";
import { CAPABILITIES, PLANS, PROFILE_CAPABILITY } from "../../licence/entitlements.js";
import { isValidLogin, readAdmins, requireAdmin, whoami, writeAdmins } from "./admin.js";
import { appendRun, createSandbox, measureSandbox, readRuns, removeRun } from "./arena.js";
import { currentVersion, publishRelease, validateNextVersion } from "./releases.js";
import { checkForUpdate, downloadAsset, listReleases } from "./updates.js";
import { lstat as lstatNodeFile, readdir as readNodeDir, readFile as readNodeFile, stat as statNodeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_FILE_BYTES, extractFilePart, fileCapabilities, ingestFile } from "./files.js";
import { detectDevice } from "./device.js";
import { guardianSnapshot, unloadModel } from "./guardian.js";
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_OPENAI_BASE,
  formatAnthropicJsonResponse,
  normalizeGeminiModel,
  streamOpenAIToAnthropic,
  translateAnthropicToOpenAI,
} from "./geminiBridge.js";
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
import { addBookmark, clearHistory, isBrowsableUrl, mergeImported, readBrowserData, recordDownload, recordVisit, removeBookmark, searchHistory } from "./browser-data.js";
import { BrowserImportError, discoverImportSources, readImport } from "./browser-import.js";
import { resolveProjectPhrase } from "./project-phrase.js";
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

/**
 * The host of a URL, or nothing.
 *
 * Audit lines record that a page was opened and where, never the path or the
 * query — the same rule that keeps typed text out of the log, since a URL is
 * just as likely to carry a token or a document id.
 */
function safeHost(value) {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
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
  return {
    defaultMode: "auto",
    maxQualified: true,
    modes: {
      flash: { ...MODEL_MODES.flash, available: true },
      auto: { ...MODEL_MODES.auto, available: true },
      max: {
        label: "Frontier Max",
        description: "Official flagship online paid tier powered by Claude Code with Google Gemini.",
        available: true,
      },
    },
    models: {
      flash: { model: flash.model, contextTokens: flash.contextTokens },
      max: { model: "gemini-2.5-flash", contextTokens: 1048576 },
    },
  };
}

function resolveFrontierMode(mode, prompt, expertQualified) {
  if (mode === "max") {
    return {
      mode: "max",
      profile: "max",
      reason: "max_always_heavy",
      expertQualified: true,
      label: "Frontier Max (Google Gemini online)",
      model: "gemini-2.5-flash",
      contextTokens: 1048576,
    };
  }
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
  if (code === "WORKSPACE_FILE_STREAMED") return new GatewayError(415, code, "Video and audio are streamed to the desktop app's player, not read as JSON.");
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

/** When this process started, against which its own source files are compared. */
const bootedAt = Date.now();

/** The two routes an agent CLI's screen shim may reach, and the only two. */
const SCREEN_AGENT_ROUTES = new Set(["/api/assistant/agent/observe", "/api/assistant/agent/act"]);

/**
 * The nine routes an agent CLI's workspace shim may reach, and the only nine.
 *
 * `reveal`, `open-file` and `projects` only show — the first two at a path the
 * workspace guard has already proved is inside the root, and neither writes a
 * byte. `open-project` rebinds the workspace root, and is reachable here
 * because the operator has already been asked: the CLI pre-approves the
 * showing tools alone, so that call arrived through the same permission prompt
 * that gates a shell command.
 *
 * The browser five: `browse` shows a page in the operator's browser panel,
 * `bookmarks`, `browsing-history` and `downloads` read what the panel
 * remembers, and `bookmark` is the one that writes — so it is the one the
 * CLI does not pre-approve. See server/browser-data.js.
 */
const WORKSPACE_AGENT_ROUTES = new Set([
  "/api/workspace/agent/reveal",
  "/api/workspace/agent/open-file",
  "/api/workspace/agent/projects",
  "/api/workspace/agent/open-project",
  "/api/workspace/agent/browse",
  "/api/workspace/agent/bookmarks",
  "/api/workspace/agent/bookmark",
  "/api/workspace/agent/browsing-history",
  "/api/workspace/agent/downloads",
  "/api/workspace/agent/player",
  "/api/workspace/agent/player-control",
]);

export async function createGateway(options = {}) {
  const config = createConfig(options.environment, options.config);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const expertQualifiedProvider = options.expertQualifiedProvider || isExpertModelQualified;
  const modeResolver = options.resolveFrontierMode || resolveFrontierMode;
  if (typeof fetchImpl !== "function") throw new Error("A Fetch-compatible implementation is required.");

  /**
   * May this machine use the VibeVoice tier?
   *
   * Read per request rather than cached with the gateway, because the licence
   * file changes underneath a running process — a sign-in, a refresh, or a
   * sign-out all rewrite it — and an entitlement pinned at startup would mean
   * the user has to restart the app to get what they just paid for.
   */
  const voiceTierEntitled = async () => grants(await readEntitlement(config.licenceStorePath), "voice.vibevoice");

  /*
    The last thing the window said its media player was showing, for the
    agent's `player` tool. One slot, because the window mounts one pane at a
    time; see server/player-state.js.
  */
  const player = options.playerRegistry || createPlayerRegistry();

  const sessionToken = options.sessionToken || randomBytes(32).toString("base64url");
  const tokenFingerprint = createHash("sha256").update(sessionToken).digest("hex").slice(0, 12);
  const audit = options.audit || new BoundedAuditLog(config.auditPath, {
    maxBytes: config.auditMaxBytes,
    maxFiles: config.auditMaxFiles,
  });
  await audit.initialize();

  /**
   * The entitlement, as the UI needs it.
   *
   * It carries the catalogue as well as the state, because an upgrade screen
   * has to name what Pro adds, and the only honest source for that is the same
   * registry the gates read. A hand-written feature list in a component is a
   * list that silently stops matching what the product actually does.
   */
  const entitlementPayload = async (known = null) => {
    const entitlement = known ?? (await readEntitlement(config.licenceStorePath));
    return {
      plan: entitlement.plan,
      planLabel: PLANS[entitlement.plan]?.label ?? PLANS.free.label,
      capabilities: entitlement.capabilities,
      state: entitlement.state,
      reason: entitlement.reason,
      expiresAt: entitlement.expiresAt,
      refreshAfter: entitlement.refreshAfter,
      signedIn: entitlement.signedIn,
      // Null means this build was never pointed at a billing service, which is
      // a legitimate configuration — the free lanes need no account — and the
      // UI must offer no upgrade button rather than a broken one.
      billingConfigured: Boolean(config.billingBaseUrl),
      catalog: CAPABILITIES,
      plans: Object.values(PLANS).map((plan) => ({ id: plan.id, label: plan.label, capabilities: [...plan.capabilities] })),
    };
  };

  /**
   * How old the running code is. A gateway left up across an edit serves the
   * previous build and every symptom points at the wrong place: the studio
   * looks broken while the source on disk is correct. `npm run dev:full`
   * restarts on change (`node --watch`), but a gateway started by hand does
   * not, so /health reports it and anything can notice.
   */
  const sourceAge = async () => {
    try {
      const directory = dirname(fileURLToPath(import.meta.url));
      const names = (await readNodeDir(directory)).filter((name) => name.endsWith(".js"));
      const times = await Promise.all(
        names.map(async (name) => (await statNodeFile(`${directory}/${name}`)).mtimeMs),
      );
      const newest = Math.max(0, ...times);
      return {
        startedAt: new Date(bootedAt).toISOString(),
        sourceChangedAt: new Date(newest).toISOString(),
        // Sources newer than the process: this gateway is running old code.
        stale: newest > bootedAt,
      };
    } catch {
      // Never fail a health check over its own diagnostics.
      return {};
    }
  };

  const health = async () => {
    const [ollama, cutMcp] = await Promise.all([
      probe(fetchImpl, joinUrl(config.ollamaUrl, "api/tags"), config.healthTimeoutMs, (body) => Array.isArray(body.models)),
      probe(fetchImpl, joinUrl(config.mcpUrl, "health"), config.healthTimeoutMs),
    ]);
    return {
      state: ollama.state === "healthy" && cutMcp.state === "healthy" ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      gateway: { state: "healthy", bind: config.host, ...(await sourceAge()) },
      dependencies: { ollama, teminaliCutMcp: cutMcp, kerfMcp: cutMcp },
    };
  };

  /* ── The screen, once, for both of its callers ───────────────────────────
     The renderer reaches these through the bearer-guarded routes below; an
     agent CLI reaches the same two functions through /api/assistant/agent/*
     carrying its run's token. One implementation rather than two, because the
     second caller was the whole point of writing the checks in `assistant.js`
     and a forked copy here would drift out of agreement with them.
     ──────────────────────────────────────────────────────────────────────── */

  const observeScreen = async ({ body, correlationId, method, route }) => {
    const maxElements = Number(body?.maxElements);
    // `observe` has always taken a pid — the route dropped it, so every
    // observation silently fell back to the frontmost application. That is
    // usually right, and wrong exactly when the caller knows better.
    const observePid = Number(body?.pid);
    let observation;
    try {
      observation = await observe(config, {
        pid: Number.isInteger(observePid) && observePid > 0 ? observePid : null,
        maxElements: Number.isFinite(maxElements) ? Math.max(10, Math.min(400, maxElements)) : 120,
        describe: body?.describe !== false,
        fetchImpl,
      });
    } catch (error) {
      throw new GatewayError(error.code === "POINTER_HELPER_MISSING" ? 503 : 502, error.code || "ASSISTANT_OBSERVE_FAILED", error.message);
    }
    await audit.write({
      event: "assistant-observed",
      correlationId,
      method,
      route,
      application: observation.application?.name ?? null,
      elements: observation.elements.length,
      truncated: observation.truncated,
      described: Boolean(observation.sceneDescription),
      limits: observation.limits,
      // Neither the frame nor its description is written to the audit log.
    });
    // The frame stays on disk under the gateway; the caller is told an id, not
    // a path, so a screenshot of the operator's screen is not handed to the
    // page — or to an agent process — for it to do anything else with.
    return { ...observation, frame: observation.frame ? { available: true } : null };
  };

  const actOnScreen = async ({ body, correlationId, method, route }) => {
    if (typeof body?.observationId !== "string" || !body.observationId) {
      throw new GatewayError(400, "OBSERVATION_REQUIRED", "An action must name the look at the screen it came from.");
    }
    if (body?.step === null || typeof body?.step !== "object") {
      throw new GatewayError(400, "STEP_REQUIRED", "An action must carry a step.");
    }
    try {
      const result = await act(body.observationId, body.step);
      await audit.write({
        event: "assistant-acted",
        correlationId,
        method,
        route,
        kind: body.step.kind,
        element: typeof body.step.element === "string" ? body.step.element : null,
        // What was typed is never written to the audit log; how much was, is.
        characters: typeof result.characters === "number" ? result.characters : null,
        // A launch is worth naming: it is the one step that starts something
        // rather than touching something already running. The address is
        // recorded as its host, on the same rule that keeps typed text out.
        app: typeof result.app === "string" ? result.app : null,
        host: typeof result.url === "string" ? safeHost(result.url) : null,
      });
      return { ok: true, result };
    } catch (error) {
      await audit.write({
        event: "assistant-refused",
        correlationId,
        method,
        route,
        kind: typeof body.step?.kind === "string" ? body.step.kind : null,
        code: error.code || "ASSISTANT_ACT_FAILED",
      });
      throw new GatewayError(409, error.code || "ASSISTANT_ACT_FAILED", error.message);
    }
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
          "access-control-allow-headers": "authorization, content-type, x-correlation-id, x-teminali-permission-token",
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

      /*
        The permission prompt tool, answered before the bearer gate.

        The shim that calls this is spawned by the agent CLI, not by the app,
        and `agentEnvironment()` deliberately strips the session token before
        an agent starts so a CLI that shells out cannot drive the gateway.
        Giving the shim that token back would undo it. It carries a token
        minted for one run instead, which authorises exactly this route and
        dies when the run does — see permission-bridge.js.
      */
      if (request.method === "POST" && route === "/api/agents/permission") {
        const body = await readJson(request, config.maxJsonBytes);
        const decision = await requestApproval({
          runId: typeof body?.runId === "string" ? body.runId : "",
          token: request.headers["x-teminali-permission-token"] || "",
          toolName: typeof body?.toolName === "string" ? body.toolName : "",
          input: body?.input && typeof body.input === "object" ? body.input : {},
        });
        replyJson(response, 200, decision);
        return;
      }

      /*
        The screen, reachable by an agent CLI, answered before the bearer gate.

        Same reasoning as the permission route directly above, and the same
        credential: the shim that calls this is spawned by the CLI, and
        `agentEnvironment()` strips the session token before an agent starts so
        a CLI that shells out cannot drive the gateway. The run's own token
        authorises exactly these two routes and dies when the run does.

        What this is NOT is a way around the checks. Both handlers are the same
        two functions the renderer's routes call, so the observation TTL, the
        frontmost guard, the element lookup and the refusal to accept a
        coordinate all apply unchanged — see `act` in assistant.js. The
        operator's consent is asked for separately and earlier, by the CLI's own
        permission prompt: `screenMcpArgs` pre-approves `look` and nothing else,
        so every tool that touches the machine goes through the same dialog in
        the same agent tab as a shell command does.
      */
      if (request.method === "POST" && SCREEN_AGENT_ROUTES.has(route)) {
        const body = await readJson(request, config.maxJsonBytes);
        const runId = typeof body?.runId === "string" ? body.runId : "";
        if (!runAuthorises(runId, request.headers["x-teminali-screen-token"] || "")) {
          // A turn the operator stopped takes its token with it (`closeRun`),
          // and the shim's next call lands here. Told only that it was
          // rejected, the agent reported "the screen connection dropped".
          // The bridge is fine; its turn is over, and it is told so.
          if (runHasEnded(runId)) {
            throw new GatewayError(410, "SCREEN_RUN_ENDED",
              "This agent turn has ended — it was stopped or completed — so the screen can no longer be reached from it. The screen bridge itself is fine; the next turn gets its own hands.");
          }
          // Deliberately not 401: there is no credential the caller could
          // supply to make this work other than being a live agent run.
          throw new GatewayError(403, "SCREEN_BRIDGE_FORBIDDEN", "The screen bridge rejected the caller.");
        }
        const context = { body, correlationId, method: request.method, route };
        if (route === "/api/assistant/agent/observe") {
          replyJson(response, 200, { observation: await observeScreen(context) });
        } else {
          replyJson(response, 200, await actOnScreen(context));
        }
        return;
      }

      /*
        The workspace UI, reachable by an agent CLI, answered before the bearer
        gate — same credential and same reasoning as the screen routes above.

        This is what stops the agent being blind to the application around it.
        `reveal` puts a `workspace` event on the run's own NDJSON stream, which
        is the only channel back to the renderer during a turn: the window
        holding the file tree is the window that opened this stream by starting
        the turn. `open-project` is the one call that changes anything, and the
        CLI has already asked the operator about it — `workspaceMcpArgs`
        pre-approves `reveal` and nothing else.
      */
      /*
        The camera, reachable by an agent CLI on the same credential as the
        screen and the workspace, and answered before the bearer gate for the
        same reason: the caller is a live agent run, not a browser session.

        The gateway is a plain Node process. It has `screencapture` for the
        screen and nothing whatever for a camera — on macOS the only way to
        open one is `getUserMedia`, which needs a renderer. So this asks the
        window that opened this run's stream, and waits for the frame to come
        back on its own request. `requestCameraFrame` owns that wait.

        Nothing is pre-approved on the camera server, so by the time this route
        is reached the operator has already been asked and has said yes.
      */
      if (request.method === "POST" && route === "/api/assistant/agent/camera") {
        const body = await readJson(request, config.maxJsonBytes);
        const runId = typeof body?.runId === "string" ? body.runId : "";
        if (!runAuthorises(runId, request.headers["x-teminali-camera-token"] || "")) {
          if (runHasEnded(runId)) {
            throw new GatewayError(410, "CAMERA_RUN_ENDED",
              "This agent turn has ended, so the camera can no longer be opened from it. The next turn gets its own.");
          }
          throw new GatewayError(403, "CAMERA_BRIDGE_FORBIDDEN", "The camera bridge rejected the caller.");
        }
        const token = request.headers["x-teminali-camera-token"] || "";
        let frame;
        try {
          frame = await requestCameraFrame({
            runId, token,
            frames: Number(body?.frames) || 1,
            spanMs: Number(body?.spanMs) || 1200,
          });
        } catch (error) {
          throw new GatewayError(503, "CAMERA_UNAVAILABLE", error instanceof Error ? error.message : "The camera could not be opened.");
        }
        await audit.write({ event: "camera-frame-taken-by-agent", correlationId, method: request.method, route });
        replyJson(response, 200, { frame });
        return;
      }

      if (request.method === "POST" && WORKSPACE_AGENT_ROUTES.has(route)) {
        const body = await readJson(request, config.maxJsonBytes);
        const runId = typeof body?.runId === "string" ? body.runId : "";
        if (!runAuthorises(runId, request.headers["x-teminali-workspace-token"] || "")) {
          if (runHasEnded(runId)) {
            throw new GatewayError(410, "WORKSPACE_RUN_ENDED",
              "This agent turn has ended — it was stopped or completed — so the workspace can no longer be driven from it. The next turn gets its own.");
          }
          throw new GatewayError(403, "WORKSPACE_BRIDGE_FORBIDDEN", "The workspace bridge rejected the caller.");
        }
        const token = request.headers["x-teminali-workspace-token"] || "";

        if (route === "/api/workspace/agent/projects") {
          replyJson(response, 200, {
            current: { path: config.workspaceRoot, name: basename(config.workspaceRoot) || config.workspaceRoot },
            recent: await listRecentProjects(config.projectsStorePath),
          });
          return;
        }

        if (route === "/api/workspace/agent/reveal") {
          // Resolved through the same guard every read route uses, so there is
          // no path here that a read could not already have named — and a typo
          // comes back as a refusal rather than as an empty tree.
          let absolutePath;
          try {
            absolutePath = resolveWorkspacePath(config.workspaceRoot, String(body?.path ?? ""));
          } catch (error) {
            throw workspaceError(error);
          }
          if (!existsSync(absolutePath)) {
            throw new GatewayError(404, "WORKSPACE_PATH_NOT_FOUND", `There is nothing at "${body?.path}" in this workspace.`);
          }
          const revealed = relative(config.workspaceRoot, absolutePath).split(sep).join("/");
          const delivered = emitToRun(runId, token, { type: "workspace", action: "reveal", path: revealed });
          replyJson(response, 200, {
            result: delivered
              ? { revealed, note: "The operator's file tree is now showing it." }
              : { revealed, note: "The path is valid, but this turn's stream is closed, so the tree was not moved." },
          });
          return;
        }

        /*
          Open a file in the operator's editor.

          `reveal` scrolls their tree to a path and says so in its own
          description; until this route existed, nothing an agent could call
          put a file in front of them, and the model's fallback was to drive
          the application's own UI with the pointer — eleven clicks to open one
          file, and it still could not tell whether it had worked.

          The bytes are not sent from here. This puts one event on the run's
          stream and the window reads the file back through the same
          `/api/workspace/file` route a click uses, so an agent-opened tab and a
          clicked one are the same tab, read under the same limits. What this
          route owes the model is a truthful refusal before a tab is opened for
          a format the pane cannot show.
        */
        if (route === "/api/workspace/agent/open-file") {
          let absolutePath;
          try {
            absolutePath = resolveWorkspacePath(config.workspaceRoot, String(body?.path ?? ""));
          } catch (error) {
            throw workspaceError(error);
          }
          // lstat, not stat, and for the same reason `readWorkspaceFile` uses
          // it: a symlink is refused by the read this tab is about to make, so
          // reporting the file open would be a lie one step ahead of itself.
          let stats;
          try {
            stats = await lstatNodeFile(absolutePath);
          } catch {
            throw new GatewayError(404, "WORKSPACE_PATH_NOT_FOUND", `There is nothing at "${body?.path}" in this workspace.`);
          }
          if (stats.isDirectory() && !stats.isSymbolicLink()) {
            /*
              A folder opens as a gallery of what is in it — the same panel a
              click in the tree opens (`galleryOf` in
              src/services/workspaceGallery.ts), so what the agent opens and
              what the operator opens are the same surface. A folder holding
              `SERIES_MIN_EPISODES` videos or more is additionally a series,
              and the note says so, because "you can start episode 3" and "here
              are the files" are different next moves for the model.
            */
            const videos = await countSeriesVideos(absolutePath);
            const opened = relative(config.workspaceRoot, absolutePath).split(sep).join("/");
            const delivered = emitToRun(runId, token, { type: "workspace", action: "open-folder", path: opened });
            const note = videos >= SERIES_MIN_EPISODES
              ? `It is open in the operator's editor as a series of ${videos} episodes — the gallery, nothing playing yet. \`player_control\` with action "episode" and a number starts one.`
              : "It is open in the operator's editor as a gallery of its contents. A card opens the file it shows.";
            replyJson(response, 200, {
              result: delivered
                ? { opened, videos, series: videos >= SERIES_MIN_EPISODES, note }
                : { opened, videos, series: videos >= SERIES_MIN_EPISODES, note: "The folder is readable, but this turn's stream is closed, so no gallery was opened." },
            });
            return;
          }
          if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new GatewayError(400, "WORKSPACE_FILE_REQUIRED",
              `"${body?.path}" is not a regular file the editor will open — a symlink, or something that is not a file. \`open_file\` opens a file into an editor tab, or a folder of videos as a series; \`reveal\` is the one that shows a folder in the tree.`);
          }
          if (!isViewableWorkspaceFile(absolutePath)) {
            throw new GatewayError(415, "WORKSPACE_FILE_UNSUPPORTED",
              `The editor has no viewer for "${body?.path}". It opens text, images, PDFs, spreadsheets, video and audio; anything else it will not pretend to show.`);
          }
          // The cap belongs to the JSON reader; a film is streamed and has none.
          if (!isStreamableWorkspaceFile(absolutePath) && stats.size > WORKSPACE_LIMITS.maxFileBytes) {
            throw new GatewayError(413, "WORKSPACE_FILE_TOO_LARGE",
              `"${body?.path}" is ${Math.round(stats.size / (1024 * 1024))} MB, past the ${WORKSPACE_LIMITS.maxFileBytes / (1024 * 1024)} MB the editor will open.`);
          }
          const opened = relative(config.workspaceRoot, absolutePath).split(sep).join("/");
          const delivered = emitToRun(runId, token, { type: "workspace", action: "open-file", path: opened });
          replyJson(response, 200, {
            result: delivered
              ? { opened, note: "It is open in the operator's editor and is the tab they are looking at." }
              : { opened, note: "The file is readable, but this turn's stream is closed, so no tab was opened." },
          });
          return;
        }

        /*
          The player, from the agent's side.

          The gateway holds no handle on the element. `player` answers with
          the last snapshot the window published to `/api/workspace/player/state`
          (behind the bearer, below), and `player-control` checks the request
          and puts it on the run's stream for the pane to execute. Both are
          pre-approved: they act on a file the operator opened, in a pane they
          are looking at, and write nothing. See server/player-state.js.
        */
        if (route === "/api/workspace/agent/player") {
          const current = player.current();
          replyJson(response, 200, { result: { player: current, summary: describePlayer(current) } });
          return;
        }

        if (route === "/api/workspace/agent/player-control") {
          let command;
          try {
            command = parsePlayerCommand(body);
          } catch (error) {
            if (error instanceof PlayerCommandError) throw new GatewayError(400, error.code, error.message);
            throw error;
          }
          const before = player.current();
          if (!before) {
            throw new GatewayError(409, "PLAYER_NOT_OPEN",
              "No video or audio is open in the operator's editor. `open_file` a media file, or a folder of videos, first.");
          }
          const delivered = emitToRun(runId, token, { type: "workspace", action: "player", command });
          replyJson(response, 200, {
            result: delivered
              ? { command, note: `Sent to the player. Before it: ${describePlayer(before)} Call \`player\` to read the result.` }
              : { command, note: "The player is open, but this turn's stream is closed, so the command was not delivered." },
          });
          return;
        }

        /*
          The browser, from the agent's side.

          `browse` puts a page in front of the operator the way `open-file`
          puts a file there: one event on the run's stream, and the window
          opens or navigates a browser panel. The address is checked here to
          the same line main draws — http(s) only — so a refusal comes back
          as a tool result rather than as a panel that opens onto nothing.
        */
        if (route === "/api/workspace/agent/browse") {
          const url = typeof body?.url === "string" ? body.url.trim() : "";
          if (!isBrowsableUrl(url)) {
            throw new GatewayError(400, "BROWSER_URL_INVALID",
              "Give a full http or https address. The browser panel opens nothing else — not file:, not javascript:, and not a bare search term.");
          }
          const newTab = body?.newTab === true;
          const delivered = emitToRun(runId, token, { type: "workspace", action: "browse", url, newTab });
          replyJson(response, 200, {
            result: delivered
              ? { url, note: newTab ? "It is open in a new browser tab in front of the operator." : "It is showing in the operator's browser panel." }
              : { url, note: "The address is valid, but this turn's stream is closed, so no panel was opened." },
          });
          return;
        }

        if (route === "/api/workspace/agent/bookmarks") {
          replyJson(response, 200, { result: { bookmarks: (await readBrowserData(config.browserStorePath)).bookmarks } });
          return;
        }

        if (route === "/api/workspace/agent/bookmark") {
          const url = typeof body?.url === "string" ? body.url.trim() : "";
          if (!isBrowsableUrl(url)) {
            throw new GatewayError(400, "BROWSER_URL_INVALID", "A bookmark needs a full http or https address.");
          }
          const bookmarks = await addBookmark(config.browserStorePath, { url, title: body?.title });
          await audit.write({ event: "browser-bookmarked-by-agent", correlationId, method: request.method, route, url });
          replyJson(response, 200, { result: { bookmarked: bookmarks.find((entry) => entry.url === url), bookmarks } });
          return;
        }

        if (route === "/api/workspace/agent/browsing-history") {
          const { history } = await readBrowserData(config.browserStorePath);
          replyJson(response, 200, { result: { history: searchHistory(history, body?.query, Number(body?.limit)) } });
          return;
        }

        if (route === "/api/workspace/agent/downloads") {
          replyJson(response, 200, { result: { downloads: (await readBrowserData(config.browserStorePath)).downloads } });
          return;
        }

        // open-project. Either an explicit path, or the operator's own words
        // resolved against the recents by `resolveProjectPhrase`.
        const recent = await listRecentProjects(config.projectsStorePath);
        let requestedPath = typeof body?.path === "string" && body.path.trim() ? body.path : "";
        if (!requestedPath) {
          const phrase = typeof body?.phrase === "string" ? body.phrase : "";
          if (!phrase.trim()) {
            throw new GatewayError(400, "PROJECT_CHOICE_REQUIRED",
              `Say which project: give a path, or a phrase such as "the last video project". Recent: ${recent.map((entry) => `${entry.name} (${entry.kind})`).join(", ") || "none"}.`);
          }
          const { project, reason } = resolveProjectPhrase(phrase, recent, { currentPath: config.workspaceRoot });
          if (!project) throw new GatewayError(404, "PROJECT_PHRASE_UNRESOLVED", reason);
          requestedPath = project.path;
        }

        let project;
        try {
          project = await validateProjectRoot(requestedPath);
        } catch (error) {
          throw projectError(error);
        }
        config.workspaceRoot = project.path;
        const updatedRecent = await rememberProject(config.projectsStorePath, project);
        await audit.write({ event: "workspace-opened-by-agent", correlationId, method: request.method, route, path: project.path });
        /*
          `kind` rides along because opening a video recording is not the same
          act as opening a folder of code. A human clicking one in the sidebar
          gets the video editor brought up first (`ProjectsPanel`), and the
          agent's open used to stop at rebinding the root: the workspace
          switched, the agent could read the timeline through the video bridge
          and describe it in detail, and the operator was looking at an empty
          pane being told what was on a timeline they could not see.
        */
        emitToRun(runId, token, {
          type: "workspace", action: "open-project",
          path: project.path, name: project.name, kind: project.kind === "video" ? "video" : "code",
        });
        replyJson(response, 200, { result: { opened: project, recent: updatedRecent } });
        return;
      }

      /* ── Gemini Bridge for Claude Code (Frontier Max) ────────────────────── */
      if (
        route.startsWith("/api/gemini/") ||
        route.startsWith("/gemini/") ||
        route === "/api/gemini" ||
        route === "/gemini"
      ) {
        if (request.method === "GET") {
          replyJson(response, 200, {
            data: [
              { id: "gemini-2.5-flash", object: "model" },
              { id: "gemini-2.5-pro", object: "model" },
              { id: "gemini-3.8-flash", object: "model" },
            ],
          });
          return;
        }

        if (request.method === "POST" && (route.endsWith("/count_tokens") || route.endsWith("/count-tokens"))) {
          replyJson(response, 200, { input_tokens: 100 });
          return;
        }

        if (request.method === "POST" && (route.endsWith("/messages") || route.endsWith("/v1/messages"))) {
          const authHeader = request.headers.authorization;
          const apiKey =
            request.headers["x-api-key"] ||
            (typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null) ||
            readStore(config.providerStorePath).providers?.google?.key ||
            process.env.GEMINI_API_KEY;

          if (!apiKey || typeof apiKey !== "string" || !apiKey.trim() || apiKey.trim() === "AIza-frontier-max") {
            throw new GatewayError(
              401,
              "GEMINI_KEY_REQUIRED",
              "Google Gemini API key is required. Add GEMINI_API_KEY to your .env or configure Google in Provider Settings.",
            );
          }

          const anthropicBody = await readJson(request, config.maxJsonBytes);
          const openAIPayload = translateAnthropicToOpenAI(anthropicBody);
          const endpoint = `${GEMINI_OPENAI_BASE}/chat/completions`;

          await audit.write({
            event: "frontier-max-gemini-request",
            correlationId,
            method: request.method,
            route,
            model: openAIPayload.model,
            stream: openAIPayload.stream,
          });

          const abort = abortContext(request, response, config.requestTimeoutMs);
          let upstream;
          try {
            upstream = await fetchImpl(endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${apiKey.trim()}`,
              },
              body: JSON.stringify(openAIPayload),
              signal: abort.signal,
            });
          } catch (error) {
            if (abort.signal.aborted) {
              throw new GatewayError(abort.wasCancelled() ? 499 : 504, abort.wasCancelled() ? "CLIENT_CANCELLED" : "UPSTREAM_TIMEOUT", "Gemini request timed out or cancelled.");
            }
            throw new GatewayError(502, "GEMINI_UPSTREAM_ERROR", "Could not reach Google Gemini API.", { cause: error });
          }

          if (!upstream.ok) {
            const errorText = await upstream.text().catch(() => "");
            let errorJson = null;
            try { errorJson = JSON.parse(errorText); } catch { errorJson = { error: { message: errorText } }; }
            throw new GatewayError(
              upstream.status,
              errorJson?.error?.code || "GEMINI_API_ERROR",
              errorJson?.error?.message || `Google Gemini API returned HTTP ${upstream.status}.`,
            );
          }

          if (openAIPayload.stream) {
            await streamOpenAIToAnthropic(upstream, response, { model: openAIPayload.model });
            abort.finish();
            return;
          }

          const openaiJson = await upstream.json();
          const anthropicJson = formatAnthropicJsonResponse(openaiJson, openAIPayload.model);
          abort.finish();
          replyJson(response, 200, anthropicJson);
          return;
        }
      }

      if (!bearerMatches(request.headers.authorization, sessionToken)) {
        throw new GatewayError(401, "AUTH_REQUIRED", "A valid session bearer token is required.");
      }

      /*
        The frame, on its own request, for the same reason an approval's answer
        arrives that way: the run's stream is one-way. An `error` here is the
        window saying why it could not — no camera, permission refused — and it
        reaches the agent as the tool failing rather than as a silent timeout.
      */
      if (request.method === "POST" && route === "/api/assistant/camera-frame") {
        const body = await readJson(request, config.maxJsonBytes);
        if (typeof body?.runId !== "string" || typeof body?.id !== "string") {
          throw new GatewayError(400, "CAMERA_FRAME_ID_REQUIRED", "A run id and a request id are required.");
        }
        const outcome = resolveCameraFrame({
          runId: body.runId,
          id: body.id,
          image: typeof body.image === "string" ? body.image : "",
          error: typeof body.error === "string" ? body.error : "",
        });
        replyJson(response, outcome.ok ? 200 : 409, outcome);
        return;
      }

      /* The operator's answer, on its own request: the run's stream is one-way. */
      if (request.method === "POST" && route === "/api/agents/permission/resolve") {
        const body = await readJson(request, config.maxJsonBytes);
        if (typeof body?.runId !== "string" || typeof body?.id !== "string") {
          throw new GatewayError(400, "PERMISSION_ID_REQUIRED", "A run id and a request id are required.");
        }
        const outcome = resolveApproval({
          runId: body.runId,
          id: body.id,
          behavior: body.behavior === "allow" ? "allow" : "deny",
          message: typeof body.message === "string" ? body.message : "",
          updatedInput: body.updatedInput && typeof body.updatedInput === "object" ? body.updatedInput : undefined,
          remember: body.remember === true,
        });
        if (!outcome.ok) throw new GatewayError(409, "PERMISSION_GONE", outcome.reason);
        replyJson(response, 200, { accepted: true });
        return;
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
        const selection = mode === "max"
          ? resolveFrontierMode("max", prompt, true)
          : modeResolver(mode, prompt, expertQualified);

        // The entitlement gate. It sits AFTER resolution rather than before it
        // because only the resolver knows which profile a mode lands on: Auto
        // is free when it stays local and Pro when it escalates, and asking
        // before resolving would either over-block Auto or let escalation
        // through. Resolving first costs nothing — it is a pure function of the
        // mode and the prompt, with no upstream call.
        const entitlement = await readEntitlement(config.licenceStorePath);
        if (!profileAllowed(selection.profile, entitlement.capabilities)) {
          const denial = refusal(PROFILE_CAPABILITY[selection.profile], entitlement);
          await audit.write({
            event: "model-mode-refused",
            correlationId,
            method: request.method,
            route,
            mode: selection.mode,
            profile: selection.profile,
            capability: denial.capability,
            plan: entitlement.plan,
          });
          // 402 rather than 403: this is not "you may never", it is "not on
          // this plan", and the client renders an upgrade path from the code.
          throw new GatewayError(402, denial.code, denial.message, {
            details: { capability: denial.capability, plan: denial.plan, stale: denial.stale },
          });
        }
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
          current: { path: config.workspaceRoot, name: basename(config.workspaceRoot) || config.workspaceRoot },
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

      /*
        Remember a project WITHOUT switching to it.

        `/api/workspace/open` does two things at once — it records the project
        and it rebinds `config.workspaceRoot`, which is what bounds every
        workspace and terminal route. That pairing is right for a code project
        and wrong for a video one: opening a timeline must not silently point
        the file tree, the search and the terminals at the folder holding it.

        So this is a second route rather than a `kind` branch inside `open`.
        Branching would have left one route whose name says "switch" and whose
        behaviour sometimes does not, and callers cannot see a branch — they
        can see which route they called.
      */
      if (request.method === "POST" && route === "/api/workspace/projects/remember") {
        const rememberRequest = await readJson(request, config.maxJsonBytes);
        let project;
        try {
          project = await validateProjectRoot(rememberRequest?.path);
        } catch (error) {
          throw projectError(error);
        }
        const recent = await rememberProject(config.projectsStorePath, project);
        await audit.write({ event: "workspace-remembered", correlationId, method: request.method, route, path: project.path });
        replyJson(response, 200, { recent });
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

      /*
        The browser panel's memory: bookmarks, history, downloads.

        Read whole and written one row at a time. A visit is the panel's
        global subscriber reporting a navigation; a download is main reporting
        where Electron's own save dialog put a file. Neither carries progress:
        that stays on IPC. See server/browser-data.js.
      */
      if (request.method === "GET" && route === "/api/workspace/browser") {
        replyJson(response, 200, await readBrowserData(config.browserStorePath));
        return;
      }

      if (request.method === "POST" && route === "/api/workspace/browser/bookmark") {
        const body = await readJson(request, config.maxJsonBytes);
        if (!isBrowsableUrl(body?.url)) throw new GatewayError(400, "BROWSER_URL_INVALID", "A bookmark needs a full http or https address.");
        replyJson(response, 200, { bookmarks: await addBookmark(config.browserStorePath, { url: body.url, title: body.title }) });
        return;
      }

      if (request.method === "POST" && route === "/api/workspace/browser/unbookmark") {
        const body = await readJson(request, config.maxJsonBytes);
        if (typeof body?.url !== "string") throw new GatewayError(400, "BROWSER_URL_INVALID", "An address is required.");
        replyJson(response, 200, { bookmarks: await removeBookmark(config.browserStorePath, body.url) });
        return;
      }

      if (request.method === "POST" && route === "/api/workspace/browser/visit") {
        const body = await readJson(request, config.maxJsonBytes);
        if (!isBrowsableUrl(body?.url)) throw new GatewayError(400, "BROWSER_URL_INVALID", "A visit needs a full http or https address.");
        replyJson(response, 200, { visit: await recordVisit(config.browserStorePath, { url: body.url, title: body.title }) });
        return;
      }

      if (request.method === "POST" && route === "/api/workspace/browser/history/clear") {
        replyJson(response, 200, { history: await clearHistory(config.browserStorePath) });
        return;
      }

      if (request.method === "POST" && route === "/api/workspace/browser/download") {
        const body = await readJson(request, config.maxJsonBytes);
        let downloads;
        try {
          downloads = await recordDownload(config.browserStorePath, body ?? {});
        } catch {
          throw new GatewayError(400, "BROWSER_DOWNLOAD_INVALID", "A download needs its http(s) address and a filename.");
        }
        replyJson(response, 200, { downloads });
        return;
      }

      /*
        Bringing bookmarks and history over from the browser used before.

        Two routes because they are two different questions. Discovery is a GET
        that reads nothing but directory entries and answers what is on this
        machine; the import itself is a POST because it writes the store. The
        renderer never names a path — it names a source and a profile, and
        `browser-import.js` is the only thing that turns those into a path.

        Safari is discovered but not importable, and says why rather than being
        hidden; autofill is reported unsupported rather than half-built. See
        server/browser-import.js.
      */
      if (request.method === "GET" && route === "/api/workspace/browser/import/sources") {
        replyJson(response, 200, await discoverImportSources());
        return;
      }

      if (request.method === "POST" && route === "/api/workspace/browser/import") {
        const body = await readJson(request, config.maxJsonBytes);
        let read;
        try {
          read = await readImport(body?.source, body?.profile, {
            kinds: {
              bookmarks: body?.bookmarks !== false,
              history: body?.history !== false,
            },
          });
        } catch (error) {
          if (error instanceof BrowserImportError) throw new GatewayError(400, error.code, error.message);
          throw new GatewayError(500, "BROWSER_IMPORT_FAILED", "That browser's data could not be read.");
        }
        const counts = await mergeImported(config.browserStorePath, read);
        replyJson(response, 200, {
          ...counts,
          read: { bookmarks: read.bookmarks.length, history: read.history.length },
          data: await readBrowserData(config.browserStorePath),
        });
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

      /*
        Files and folders on the machine, outside the workspace.

        A GET with the query in the address, because it reads nothing and
        changes nothing — and because the answer is a list of paths, not their
        contents. Spotlight only, home directory only, bounded in time and
        count; a platform without an index says so rather than walking a disk.
        See server/machine-search.js.
      */
      if (request.method === "GET" && route === "/api/workspace/machine-search") {
        const query = new URL(request.url, "http://127.0.0.1").searchParams;
        replyJson(response, 200, await searchMachine(query.get("q")));
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

      /*
        The window telling the gateway what its player is showing, so the
        agent's `player` tool has something to read. `player: null` is the
        pane unmounting. Bounded and typed by `sanitisePlayerSnapshot`.
      */
      if (request.method === "POST" && route === "/api/workspace/player/state") {
        const report = await readJson(request, config.maxJsonBytes);
        replyJson(response, 200, { ok: true, player: player.report(report?.player ?? null) });
        return;
      }

      /*
        What a media file holds and how it will be played — ffprobe's summary,
        the plan (`direct`, `remux`, `transcode`, `unplayable`) and whether the
        tools are installed. The pane asks before it points an element at the
        protocol, so a `.mkv` holding HEVC is streamed through ffmpeg rather
        than handed to a player that will only fire `error`. Same path guard
        as the reader; see server/media-probe.js.
      */
      if (request.method === "POST" && route === "/api/workspace/media/probe") {
        const probeRequest = await readJson(request, config.maxJsonBytes);
        if (typeof probeRequest?.path !== "string" || probeRequest.path.length > 2_048) {
          throw new GatewayError(400, "INVALID_WORKSPACE_PATH", "A bounded workspace-relative file path is required.");
        }
        let absolutePath;
        try {
          absolutePath = resolveWorkspacePath(config.workspaceRoot, probeRequest.path);
        } catch (error) {
          throw workspaceError(error);
        }
        let stats;
        try {
          stats = await lstatNodeFile(absolutePath);
        } catch {
          throw new GatewayError(404, "WORKSPACE_FILE_NOT_FOUND", "The workspace file no longer exists.");
        }
        if (!stats.isFile() || stats.isSymbolicLink()) throw new GatewayError(400, "WORKSPACE_FILE_REQUIRED", "A regular workspace file is required.");
        if (!isStreamableWorkspaceFile(absolutePath)) throw new GatewayError(415, "WORKSPACE_FILE_UNSUPPORTED", "Only video and audio are probed.");
        const tools = await mediaTools();
        const probe = await probeMedia(absolutePath, tools);
        const plan = playbackPlan(probe, { ffmpeg: tools.ffmpeg, path: absolutePath });
        replyJson(response, 200, { probe, plan, tools: { ffmpeg: Boolean(tools.ffmpeg), ffprobe: Boolean(tools.ffprobe) } });
        return;
      }

      /* One embedded text subtitle stream, as WebVTT, for the player's track menu. */
      if (request.method === "POST" && route === "/api/workspace/media/subtitle") {
        const subtitleRequest = await readJson(request, config.maxJsonBytes);
        if (typeof subtitleRequest?.path !== "string" || subtitleRequest.path.length > 2_048) {
          throw new GatewayError(400, "INVALID_WORKSPACE_PATH", "A bounded workspace-relative file path is required.");
        }
        const stream = Number(subtitleRequest.stream);
        if (!Number.isInteger(stream) || stream < 0 || stream > 64) throw new GatewayError(400, "MEDIA_STREAM_REQUIRED", "`stream` is the subtitle stream's index, from the probe.");
        let absolutePath;
        try {
          absolutePath = resolveWorkspacePath(config.workspaceRoot, subtitleRequest.path);
        } catch (error) {
          throw workspaceError(error);
        }
        if (!isStreamableWorkspaceFile(absolutePath)) throw new GatewayError(415, "WORKSPACE_FILE_UNSUPPORTED", "Only video and audio carry subtitle streams.");
        const tools = await mediaTools();
        try {
          const vtt = await extractSubtitleVtt(absolutePath, stream, tools);
          replyJson(response, 200, { vtt });
        } catch (error) {
          throw new GatewayError(422, "MEDIA_SUBTITLE_FAILED", error instanceof Error ? error.message : "The subtitle stream could not be read.");
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

      /* Rejecting a proposed change to a file the assistant created: the
         file has to go, not be blanked. Nothing else calls this. */
      if (request.method === "POST" && route === "/api/workspace/delete") {
        const deleteRequest = await readJson(request, config.maxJsonBytes);
        if (typeof deleteRequest?.path !== "string" || deleteRequest.path.length > 2_048) {
          throw new GatewayError(400, "INVALID_WORKSPACE_PATH", "A bounded workspace-relative file path is required.");
        }
        try {
          const removed = await deleteWorkspaceFile(config.workspaceRoot, deleteRequest.path);
          await audit.write({ event: "workspace-file-deleted", correlationId, method: request.method, route, path: removed.path });
          replyJson(response, 200, removed);
        } catch (error) {
          throw workspaceError(error);
        }
        return;
      }

      if (request.method === "POST" && route === "/api/workspace/mkdir") {
        const dirRequest = await readJson(request, config.maxJsonBytes);
        if (typeof dirRequest?.path !== "string" || dirRequest.path.length > 2_048) {
          throw new GatewayError(400, "INVALID_WORKSPACE_PATH", "A bounded workspace-relative directory path is required.");
        }
        try {
          const created = await createWorkspaceDirectory(config.workspaceRoot, dirRequest.path);
          await audit.write({ event: "workspace-directory-created", correlationId, method: request.method, route, path: created.path });
          replyJson(response, 200, created);
        } catch (error) {
          throw workspaceError(error);
        }
        return;
      }

      /* ── Entitlement ──────────────────────────────────────────────────────
         What this machine may do, and how it comes to be allowed more.

         The gates themselves live at the routes they guard — escalation at
         /api/frontier/resolve-mode, the speech tier at the voice routes. These
         routes exist so the UI can show the state and act on it without
         inferring the plan from a refusal it happened to receive.

         Sign-in is a device-code flow because a desktop app has no redirect
         URI worth trusting; see server/licence.js for why.
         ------------------------------------------------------------------ */

      if (request.method === "GET" && route === "/api/entitlement") {
        replyJson(response, 200, await entitlementPayload());
        return;
      }

      if (request.method === "POST" && route === "/api/entitlement/refresh") {
        const entitlement = await refreshLicence(config.licenceStorePath, { baseUrl: config.billingBaseUrl });
        // The voice probe caches per entitlement, and the entitlement just
        // changed. Without this the user waits out a TTL for the tier they own.
        forgetVoiceStatus();
        await audit.write({ event: "licence-refreshed", correlationId, method: request.method, route, plan: entitlement.plan, state: entitlement.state });
        replyJson(response, 200, await entitlementPayload(entitlement));
        return;
      }

      if (request.method === "POST" && route === "/api/entitlement/sign-in") {
        const body = await readJson(request, config.maxJsonBytes).catch(() => ({}));
        try {
          const started = await startSignIn({
            baseUrl: config.billingBaseUrl,
            deviceName: typeof body?.deviceName === "string" ? body.deviceName.slice(0, 120) : null,
            // Passed through so a future account screen can offer Google
            // beside GitHub; omitted, the client sends its own default rather
            // than letting the service pick.
            ...(typeof body?.provider === "string" ? { provider: body.provider } : {}),
          });
          await audit.write({ event: "licence-sign-in-started", correlationId, method: request.method, route });
          replyJson(response, 200, started);
        } catch (error) {
          throw new GatewayError(error.status || 502, error.code || "SIGN_IN_FAILED", error.message);
        }
        return;
      }

      if (request.method === "POST" && route === "/api/entitlement/sign-in/poll") {
        const body = await readJson(request, config.maxJsonBytes);
        try {
          const result = await pollSignIn(config.licenceStorePath, {
            baseUrl: config.billingBaseUrl,
            deviceCode: typeof body?.deviceCode === "string" ? body.deviceCode : null,
          });
          if (result.status !== "granted") {
            replyJson(response, 200, { status: result.status });
            return;
          }
          forgetVoiceStatus();
          await audit.write({ event: "licence-signed-in", correlationId, method: request.method, route, plan: result.entitlement.plan });
          replyJson(response, 200, { status: "granted", ...(await entitlementPayload(result.entitlement)) });
        } catch (error) {
          throw new GatewayError(error.status || 502, error.code || "SIGN_IN_FAILED", error.message);
        }
        return;
      }

      if (request.method === "POST" && route === "/api/entitlement/sign-out") {
        // Revoke at the service before forgetting locally — see signOut in
        // server/licence.js. The local half happens either way, so this route
        // cannot fail; `revoked` records whether the server half got through.
        const goodbye = await signOut(config.licenceStorePath, { baseUrl: config.billingBaseUrl });
        forgetVoiceStatus();
        await audit.write({
          event: "licence-signed-out",
          correlationId,
          method: request.method,
          route,
          revoked: goodbye.revoked,
          reason: goodbye.reason,
        });
        replyJson(response, 200, await entitlementPayload());
        return;
      }

      /* ── Upgrade ──────────────────────────────────────────────────────────
         The three routes between "I want Pro" and a licence that says so.

         All three are thin proxies. The gateway holds the session token and
         the service address; the renderer holds neither, and must not, because
         a token reachable from the page is a token reachable from anything the
         page ever renders.

         Nothing here decides what a plan costs or what it unlocks. The prices
         come from the service, the capabilities from licence/entitlements.js
         via the service, and the licence itself only ever arrives through
         /api/entitlement/refresh where it is verified before it is stored. */

      if (request.method === "GET" && route === "/api/entitlement/plans") {
        try {
          replyJson(response, 200, await listPlans({ baseUrl: config.billingBaseUrl }));
        } catch (error) {
          throw new GatewayError(error.status || 502, error.code || "PLANS_UNAVAILABLE", error.message);
        }
        return;
      }

      if (request.method === "POST" && route === "/api/entitlement/checkout") {
        const body = await readJson(request, config.maxJsonBytes);
        try {
          const started = await startCheckout(config.licenceStorePath, {
            baseUrl: config.billingBaseUrl,
            rail: typeof body?.rail === "string" ? body.rail : null,
            priceId: typeof body?.priceId === "string" ? body.priceId : null,
            // Sent only when the user typed one. The service falls back to the
            // number already on the account, and an empty string here would
            // override a good number with a bad one.
            msisdn: typeof body?.msisdn === "string" && body.msisdn.trim() ? body.msisdn.trim() : null,
          });
          // The amount is not logged. An audit trail that records what someone
          // paid is a financial record, and this file is a debugging aid.
          await audit.write({ event: "checkout-started", correlationId, method: request.method, route, rail: body?.rail ?? null });
          replyJson(response, 200, started);
        } catch (error) {
          throw new GatewayError(error.status || 502, error.code || "CHECKOUT_FAILED", error.message);
        }
        return;
      }

      const orderMatch = route.match(/^\/api\/entitlement\/order\/([A-Za-z0-9_-]{1,120})$/);
      if (request.method === "GET" && orderMatch) {
        try {
          replyJson(response, 200, await readOrder(config.licenceStorePath, { baseUrl: config.billingBaseUrl, orderId: orderMatch[1] }));
        } catch (error) {
          throw new GatewayError(error.status || 502, error.code || "ORDER_UNAVAILABLE", error.message);
        }
        return;
      }

      /* ── Voice ────────────────────────────────────────────────────────────
         Three routes in front of an optional local speech sidecar. Every one
         of them treats "no sidecar" as a normal answer, because the studio is
         designed to fall back to the browser engine rather than lose voice.

         The entitlement enters here as a tier, not as a gate: `voice.vibevoice`
         is Pro, and a free caller is routed to the local engines rather than
         refused. Compare /api/frontier/resolve-mode, which does refuse — the
         difference is that escalation has a per-turn cost and no local
         substitute, while the sidecar has neither.
         ------------------------------------------------------------------ */

      if (request.method === "GET" && route === "/api/voice/status") {
        replyJson(response, 200, await voiceStatus(config, { allowVibeVoice: await voiceTierEntitled() }));
        return;
      }

      if (request.method === "POST" && route === "/api/voice/transcribe") {
        const allowVibeVoice = await voiceTierEntitled();
        const status = await voiceStatus(config, { allowVibeVoice });
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
          const fields = audio.toString("latin1");
          const field = (name) =>
            new RegExp(`name="${name}"[\\s\\S]{0,120}?\\r\\n\\r\\n([^\\r]+)`).exec(fields)?.[1]?.trim();
          const language = field("language") ?? "auto";
          /* Caption-shaped segments, for a caller laying subtitles down.
             Absent means whisper's own segmentation, one cue an utterance. */
          const maxSegmentChars = Math.max(0, Math.min(120, Number(field("maxSegmentChars")) || 0));
          /* The open project's names, for a recogniser that takes a vocabulary
             prompt. A malformed field costs the prompt, never the sentence. */
          let hints = [];
          try {
            const raw = field("hints");
            if (raw) hints = JSON.parse(raw).filter((entry) => typeof entry === "string").slice(0, 64);
          } catch {}
          const result = await transcribe(config, {
            body: audio, contentType, language, maxSegmentChars, hints, allowVibeVoice,
          });
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
        const allowVibeVoice = await voiceTierEntitled();
        const status = await voiceStatus(config, { allowVibeVoice });
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
            stream: speakRequest.stream === true,
          }, { allowVibeVoice });
          if (audio.stream) {
            response.writeHead(200, { "content-type": audio.contentType, "cache-control": "no-store" });
            // The studio hanging up (a barge-in) must reach the sidecar, which
            // stops rendering. `pipeline` destroys the upstream when the
            // response closes early; nothing here is an error to report.
            pipeline(audio.stream, response, () => {});
            return;
          }
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
        const body = await readJson(request, config.maxJsonBytes);
        replyJson(response, 200, await observeScreen({ body, correlationId, method: request.method, route }));
        return;
      }

      if (request.method === "POST" && route === "/api/assistant/act") {
        const body = await readJson(request, config.maxJsonBytes);
        replyJson(response, 200, await actOnScreen({ body, correlationId, method: request.method, route }));
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

      if (request.method === "GET" && route === "/api/updates/releases") {
        // What the version control in the corner reads to know what it could go
        // back to. Public for the same reason the check is: which builds exist
        // is not a privileged fact, and rolling back a bad update is something
        // every install has to be able to do for itself.
        replyJson(response, 200, await listReleases({ appRoot: config.appRoot, repo: config.releaseRepo }));
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
          // A publish now tags and pushes, and CI builds from that tag. Both
          // repositories are therefore part of the operation rather than
          // something only the update check needed to know: the tag and the
          // workflow belong to the source repository, the release and its notes
          // to the public one.
          repo: config.releaseRepo,
          sourceRepo: config.sourceRepo,
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

      if (request.method === "GET" && route === "/api/plan") {
        // Two different questions in one answer, because the panel asks them
        // together: who am I signed in as, and how much of that plan is left.
        replyJson(response, 200, {
          accounts: await agentAccounts(),
          limits: await readPlanLimits(config.planStorePath),
        });
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
          // Plan headroom rides the turn rather than costing a request of its
          // own — see server/plan.js. Recorded here for the same reason usage
          // is: the gateway sees turns whose window has since been closed.
          if (event?.type === "limits") {
            void recordPlanLimits(config.planStorePath, engine, event);
          }
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

        /*
          Whether this turn gets hands.

          Asked here, per turn, rather than assumed at start-up: the operator
          may grant Accessibility while the application is running, and a build
          that decided once at boot would keep telling the agent it has no
          screen tools until they restarted. A machine that has not granted it
          gets no screen server and a briefing that says so, which is better
          than tools that fail on their first call.
        */
        let screenControl = false;
        try {
          const permissions = await assistantCapabilities();
          screenControl = Boolean(permissions.supported && permissions.helperBuilt && permissions.accessibilityTrusted);
        } catch {
          /* No answer is a no. */
        }

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
            // The correlation id is already unique per request and already
            // travels to the client on the response header, so it is the run
            // id the operator's answer will come back naming.
            runId: correlationId,
            screenControl,
            frontierMax: Boolean(agentRequest.frontierMax),
            gatewayUrl: `http://127.0.0.1:${config.port || 4310}`,
            geminiApiKey: readStore(config.providerStorePath).providers?.google?.key || process.env.GEMINI_API_KEY || null,
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
