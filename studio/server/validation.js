import { GatewayError } from "./errors.js";

export const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

function invalid(message, details) {
  return new GatewayError(400, "INVALID_REQUEST", message, { details });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readJson(request, maxBytes = DEFAULT_MAX_JSON_BYTES) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new GatewayError(413, "PAYLOAD_TOO_LARGE", `JSON body exceeds the ${maxBytes}-byte limit.`);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new GatewayError(413, "PAYLOAD_TOO_LARGE", `JSON body exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(chunk);
  }

  if (size === 0) throw invalid("A JSON request body is required.");
  try {
    const parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!isPlainObject(parsed)) throw invalid("The JSON body must be an object.");
    return parsed;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw invalid("The request body is not valid JSON.");
  }
}

export function validateOllamaRequest(kind, body) {
  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    throw invalid("Ollama requests require a non-empty model.", { field: "model" });
  }
  if (kind === "generate" && typeof body.prompt !== "string") {
    throw invalid("Ollama generate requests require a prompt string.", { field: "prompt" });
  }
  if (kind === "chat" && (!Array.isArray(body.messages) || body.messages.length === 0)) {
    throw invalid("Ollama chat requests require a non-empty messages array.", { field: "messages" });
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw invalid("stream must be a boolean when provided.", { field: "stream" });
  }
}

export function validateAnthropicRequest(body) {
  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    throw invalid("Anthropic requests require a non-empty model.", { field: "model" });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalid("Anthropic requests require a non-empty messages array.", { field: "messages" });
  }
  if (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
    throw invalid("Anthropic requests require a positive integer max_tokens.", { field: "max_tokens" });
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw invalid("stream must be a boolean when provided.", { field: "stream" });
  }
}

export function validateMcpRequest(body) {
  if (body.jsonrpc !== "2.0") {
    throw invalid('MCP requests require jsonrpc: "2.0".', { field: "jsonrpc" });
  }
  if (typeof body.method !== "string" || body.method.trim().length === 0) {
    throw invalid("MCP requests require a non-empty method.", { field: "method" });
  }
  if (body.params !== undefined && !Array.isArray(body.params) && !isPlainObject(body.params)) {
    throw invalid("MCP params must be an object or array.", { field: "params" });
  }
  if (body.id !== undefined && body.id !== null && typeof body.id !== "string" && typeof body.id !== "number") {
    throw invalid("MCP id must be a string, number, null, or omitted.", { field: "id" });
  }
}

export function parseBoundedJsonBuffer(buffer, maxBytes, source) {
  if (buffer.length > maxBytes) {
    throw new GatewayError(502, "UPSTREAM_RESPONSE_TOO_LARGE", `${source} returned an oversized response.`, {
      retryable: false,
    });
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new GatewayError(502, "MALFORMED_UPSTREAM_RESPONSE", `${source} returned malformed JSON.`, {
      retryable: true,
    });
  }
}

export function validateJsonRpcResponse(body, requestId) {
  if (!isPlainObject(body) || body.jsonrpc !== "2.0") return false;
  if (requestId !== undefined && body.id !== requestId) return false;
  return Object.hasOwn(body, "result") !== Object.hasOwn(body, "error");
}

export function validateOllamaResponse(kind, body) {
  if (!isPlainObject(body) || typeof body.done !== "boolean") return false;
  if (kind === "generate") return typeof body.response === "string";
  return isPlainObject(body.message) && typeof body.message.content === "string";
}

export function validateAnthropicResponse(body) {
  return isPlainObject(body) && body.type === "message" && typeof body.id === "string" && Array.isArray(body.content);
}

const CLIENT_AUDIT_EVENTS = new Set(["prompt", "model_call", "tool_call", "patch", "verification", "client_error"]);
const CLIENT_AUDIT_PROVIDERS = new Set(["ollama", "anthropic", "teminali-cut-mcp", "kerf-mcp", "client"]);
const CLIENT_AUDIT_FIELDS = new Set(["event", "provider", "status", "durationMs", "requestBytes", "responseBytes", "errorCode", "retryable"]);

export function validateClientAuditEvent(body) {
  const unexpected = Object.keys(body).filter((key) => !CLIENT_AUDIT_FIELDS.has(key));
  if (unexpected.length > 0) {
    throw invalid("Client audit events contain unsupported fields.", { fields: unexpected });
  }
  if (!CLIENT_AUDIT_EVENTS.has(body.event)) {
    throw invalid("Client audit event has an unsupported event type.", { field: "event" });
  }
  if (body.provider !== undefined && !CLIENT_AUDIT_PROVIDERS.has(body.provider)) {
    throw invalid("Client audit event has an unsupported provider.", { field: "provider" });
  }
  if (body.status !== undefined && (!Number.isInteger(body.status) || body.status < 100 || body.status > 599)) {
    throw invalid("Client audit status must be a valid HTTP status.", { field: "status" });
  }
  for (const field of ["durationMs", "requestBytes", "responseBytes"]) {
    if (body[field] !== undefined && (!Number.isFinite(body[field]) || body[field] < 0)) {
      throw invalid(`Client audit ${field} must be a non-negative number.`, { field });
    }
  }
  if (body.errorCode !== undefined && (typeof body.errorCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(body.errorCode))) {
    throw invalid("Client audit errorCode must be an uppercase machine-readable code.", { field: "errorCode" });
  }
  if (body.retryable !== undefined && typeof body.retryable !== "boolean") {
    throw invalid("Client audit retryable must be a boolean.", { field: "retryable" });
  }
  return body;
}
