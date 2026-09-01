const DEFAULT_ROUTE = "/api/mcp";
const DEFAULT_HEALTH_ROUTE = "/api/health";
const DEFAULT_STATE_TOOL = "frontiercut_timeline_state";

export class McpContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "McpContractError";
    this.code = code;
    this.details = details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonResponse(response, source) {
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.clone().json();
      detail = body?.error?.message || detail;
    } catch {
      detail = `${detail}; response was not JSON`;
    }
    throw new McpContractError("GATEWAY_REJECTED", `${source} rejected the request: ${detail}`, {
      status: response.status,
    });
  }
  if (!/(?:application|text)\/(?:[^;]+\+)?json\b/i.test(contentType)) {
    throw new McpContractError("INVALID_CONTENT_TYPE", `${source} returned '${contentType || "unknown"}', not JSON.`);
  }
  try {
    return await response.json();
  } catch {
    throw new McpContractError("MALFORMED_JSON", `${source} returned malformed JSON.`);
  }
}

/**
 * Real browser transport. It bootstraps the process-scoped bearer token and
 * sends all RPC calls to the authenticated local gateway route.
 */
export function createAuthenticatedGatewayTransport(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const route = options.route || DEFAULT_ROUTE;
  const healthRoute = options.healthRoute || DEFAULT_HEALTH_ROUTE;
  const sessionRoute = options.sessionRoute || "/api/session";
  if (typeof fetchImpl !== "function") {
    throw new McpContractError("FETCH_UNAVAILABLE", "A Fetch-compatible implementation is required.");
  }
  let tokenPromise;

  const token = async () => {
    if (!tokenPromise) {
      tokenPromise = fetchImpl(sessionRoute, {
        method: "POST",
        headers: { Accept: "application/json" },
      })
        .then((response) => readJsonResponse(response, "Gateway session"))
        .then((body) => {
          if (!isRecord(body) || typeof body.token !== "string" || !body.token) {
            throw new McpContractError("INVALID_SESSION", "Gateway session response omitted its bearer token.");
          }
          return body.token;
        })
        .catch((error) => {
          tokenPromise = undefined;
          throw error;
        });
    }
    return tokenPromise;
  };

  const sendOnce = async (request, bearer) =>
    fetchImpl(route, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(request),
    });

  return {
    route,
    async health() {
      const response = await fetchImpl(healthRoute, { method: "GET", headers: { Accept: "application/json" } });
      return readJsonResponse(response, "Gateway health");
    },
    async send(request) {
      let response = await sendOnce(request, await token());
      if (response.status === 401) {
        tokenPromise = undefined;
        response = await sendOnce(request, await token());
      }
      return readJsonResponse(response, "MCP gateway");
    },
  };
}

export function validateJsonRpcResponse(response, expectedId) {
  if (!isRecord(response) || response.jsonrpc !== "2.0" || response.id !== expectedId) {
    throw new McpContractError("INVALID_JSON_RPC", "MCP response has an invalid version or correlation id.", {
      expectedId,
      receivedId: isRecord(response) ? response.id : undefined,
    });
  }
  const hasResult = Object.hasOwn(response, "result");
  const hasError = Object.hasOwn(response, "error");
  if (hasResult === hasError) {
    throw new McpContractError("INVALID_JSON_RPC", "MCP response must contain exactly one of result or error.");
  }
  if (hasError) {
    const rpcError = isRecord(response.error) ? response.error : {};
    throw new McpContractError(
      "RPC_ERROR",
      typeof rpcError.message === "string" ? rpcError.message : "MCP returned an unspecified JSON-RPC error.",
      { rpcCode: rpcError.code, rpcData: rpcError.data },
    );
  }
  return response.result;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function sha256Text(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseTextContent(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export function unwrapToolResult(result) {
  if (!isRecord(result)) throw new McpContractError("INVALID_TOOL_RESULT", "MCP tool result is not an object.");
  if (result.isError === true) {
    throw new McpContractError("TOOL_ERROR", "MCP tool reported an error result.", { result });
  }
  if (isRecord(result.structuredContent)) return result.structuredContent;
  if (Array.isArray(result.content)) {
    const textItem = result.content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
    if (textItem) return parseTextContent(textItem.text);
  }
  return result;
}

function assertIdempotencyKey(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{8,160}$/.test(value)) {
    throw new McpContractError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency keys must be 8-160 safe ASCII characters.",
    );
  }
  return value;
}

function extractUndo(result) {
  if (!isRecord(result) || !isRecord(result.undo)) return null;
  if (typeof result.undo.token !== "string" || !result.undo.token) return null;
  return {
    token: result.undo.token,
    tool: typeof result.undo.tool === "string" ? result.undo.tool : null,
    expiresAt: typeof result.undo.expiresAt === "string" ? result.undo.expiresAt : null,
  };
}

function dependencyState(report) {
  if (!isRecord(report)) return undefined;
  if (isRecord(report.dependencies) && isRecord(report.dependencies.kerfMcp)) {
    return report.dependencies.kerfMcp.state;
  }
  if (isRecord(report.kerfMcp)) return report.kerfMcp.state;
  return undefined;
}

export class FrontierMcpClient {
  constructor(options = {}) {
    this.transport = options.transport || createAuthenticatedGatewayTransport(options);
    this.stateTool = options.stateTool || DEFAULT_STATE_TOOL;
    this.sequence = 0;
    this.discovered = null;
  }

  async rpc(method, params = {}) {
    const id = `frontier-mcp-${++this.sequence}`;
    const request = { jsonrpc: "2.0", id, method, params };
    const response = await this.transport.send(request);
    return validateJsonRpcResponse(response, id);
  }

  async requireHealthy() {
    let report;
    try {
      report = await this.transport.health();
    } catch (error) {
      throw new McpContractError("MCP_HEALTH_UNAVAILABLE", "Kerf MCP health could not be established.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const state = dependencyState(report);
    if (state !== "healthy") {
      throw new McpContractError("MCP_UNHEALTHY", `Kerf MCP is '${state || "unknown"}'; mutations are disabled.`, {
        health: report,
      });
    }
    return report;
  }

  async discoverCapabilities(options = {}) {
    if (!options.skipHealth) await this.requireHealthy();
    const initialized = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "frontier-studio", version: "1.0.0" },
      capabilities: {},
    });
    if (!isRecord(initialized) || !isRecord(initialized.capabilities)) {
      throw new McpContractError("INVALID_CAPABILITIES", "MCP initialize response omitted capabilities.");
    }
    const listed = await this.rpc("tools/list");
    if (!isRecord(listed) || !Array.isArray(listed.tools)) {
      throw new McpContractError("INVALID_CAPABILITIES", "MCP tools/list response omitted its tools array.");
    }
    const tools = listed.tools.filter(
      (tool) => isRecord(tool) && typeof tool.name === "string" && isRecord(tool.inputSchema),
    );
    if (tools.length !== listed.tools.length) {
      throw new McpContractError("INVALID_CAPABILITIES", "MCP returned a malformed tool declaration.");
    }
    this.discovered = { protocolVersion: initialized.protocolVersion || null, capabilities: initialized.capabilities, tools };
    return this.discovered;
  }

  async callTool(name, argumentsValue, metadata = {}) {
    const result = await this.rpc("tools/call", {
      name,
      arguments: argumentsValue,
      _meta: metadata,
    });
    return unwrapToolResult(result);
  }

  async snapshotTimeline() {
    const state = await this.callTool(this.stateTool, {}, { purpose: "timeline-state-verification" });
    return { state, hash: await sha256Text(canonicalJson(state)) };
  }

  /**
   * Preview-first mutation protocol. A successful commit is reported only
   * after post-state verification and usable undo metadata are both present.
   */
  async mutateTimeline(request) {
    const idempotencyKey = assertIdempotencyKey(request.idempotencyKey || globalThis.crypto.randomUUID());
    await this.requireHealthy();
    const capabilities = this.discovered || (await this.discoverCapabilities({ skipHealth: true }));
    const names = new Set(capabilities.tools.map((tool) => tool.name));
    if (!names.has(this.stateTool)) {
      throw new McpContractError("STATE_TOOL_UNAVAILABLE", `Required state tool '${this.stateTool}' was not discovered.`);
    }
    if (!names.has(request.toolName)) {
      throw new McpContractError("MUTATION_TOOL_UNAVAILABLE", `Mutation tool '${request.toolName}' was not discovered.`);
    }

    const pre = await this.snapshotTimeline();
    const previewArguments = {
      ...(isRecord(request.arguments) ? request.arguments : {}),
      dryRun: true,
      idempotencyKey: `${idempotencyKey}:preview`,
    };
    const preview = await this.callTool(request.toolName, previewArguments, {
      phase: "preview",
      idempotencyKey: `${idempotencyKey}:preview`,
    });
    if (request.dryRun === true) {
      return {
        success: true,
        status: "previewed",
        idempotencyKey,
        preStateHash: pre.hash,
        postStateHash: null,
        preview,
        mutation: null,
        undo: null,
        verification: { committed: false, changed: false },
      };
    }

    let mutation;
    try {
      mutation = await this.callTool(
        request.toolName,
        {
          ...(isRecord(request.arguments) ? request.arguments : {}),
          dryRun: false,
          idempotencyKey,
        },
        { phase: "commit", idempotencyKey },
      );
    } catch (error) {
      return this.resolveFailure({ error, phase: "mutation", idempotencyKey, pre, preview });
    }

    const undo = extractUndo(mutation);
    let post;
    try {
      post = await this.snapshotTimeline();
    } catch (error) {
      return {
        success: false,
        status: "partial_failure",
        phase: "post_verification",
        idempotencyKey,
        preStateHash: pre.hash,
        postStateHash: null,
        preview,
        mutation,
        undo,
        verification: { committed: true, changed: null },
        failure: error instanceof Error ? error.message : String(error),
      };
    }

    const changed = post.hash !== pre.hash;
    const expectedHash = isRecord(mutation) && typeof mutation.postStateHash === "string" ? mutation.postStateHash : null;
    const expectedHashMatched = expectedHash === null || expectedHash === post.hash;
    if (!undo || (!changed && request.allowNoop !== true) || !expectedHashMatched) {
      return {
        success: false,
        status: "partial_failure",
        phase: "post_verification",
        idempotencyKey,
        preStateHash: pre.hash,
        postStateHash: post.hash,
        preview,
        mutation,
        undo,
        verification: { committed: true, changed, expectedHash, expectedHashMatched },
        failure: !undo
          ? "Mutation response omitted usable undo metadata."
          : !expectedHashMatched
            ? "Post-state hash did not match the mutation result."
            : "Timeline state did not change.",
      };
    }

    return {
      success: true,
      status: "verified",
      idempotencyKey,
      preStateHash: pre.hash,
      postStateHash: post.hash,
      preview,
      mutation,
      undo,
      verification: { committed: true, changed, expectedHash, expectedHashMatched },
    };
  }

  async resolveFailure({ error, phase, idempotencyKey, pre, preview }) {
    try {
      const post = await this.snapshotTimeline();
      const changed = post.hash !== pre.hash;
      return {
        success: false,
        status: changed ? "partial_failure" : "failed",
        phase,
        idempotencyKey,
        preStateHash: pre.hash,
        postStateHash: post.hash,
        preview,
        mutation: null,
        undo: null,
        verification: { committed: changed ? null : false, changed },
        failure: error instanceof Error ? error.message : String(error),
      };
    } catch (verificationError) {
      return {
        success: false,
        status: "partial_failure",
        phase,
        idempotencyKey,
        preStateHash: pre.hash,
        postStateHash: null,
        preview,
        mutation: null,
        undo: null,
        verification: { committed: null, changed: null },
        failure: error instanceof Error ? error.message : String(error),
        verificationFailure: verificationError instanceof Error ? verificationError.message : String(verificationError),
      };
    }
  }
}
