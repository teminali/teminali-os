import { AgentRuntimeError, throwIfAborted } from "./errors.js";

function boundedJson(text, maxBytes) {
  if (Buffer.byteLength(text) > maxBytes) throw new AgentRuntimeError("MODEL_RESPONSE_TOO_LARGE", "The model response exceeded the configured limit.");
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch {
    throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model returned invalid structured JSON.");
  }
}

function validateEdits(value) {
  if (!Array.isArray(value.edits) || value.edits.length === 0 || value.edits.length > 20) {
    throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model must return between 1 and 20 exact replacement edits.");
  }
  for (const edit of value.edits) {
    if (!edit || typeof edit.path !== "string" || typeof edit.before !== "string" || typeof edit.after !== "string" || edit.before.length === 0) {
      throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "Every model edit requires path, before, and after strings.");
    }
  }
  return { edits: value.edits, rationale: typeof value.rationale === "string" ? value.rationale : "" };
}

function stageInstruction(stage) {
  if (stage === "review") {
    return "Return JSON only: {\"approved\":boolean,\"findings\":[string]}. Approve only when the supplied command evidence passes and the scoped changes satisfy every acceptance criterion.";
  }
  return "Return JSON only: {\"edits\":[{\"path\":string,\"before\":string,\"after\":string}],\"rationale\":string}. Each edit must be an exact, unique replacement and may target only an editable path.";
}

function loopbackGatewayUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new AgentRuntimeError("INVALID_PLANNER_CONFIG", "The model gateway must be an HTTP loopback URL.");
  }
  return url;
}

export class GatewayPlanner {
  constructor(options) {
    if (!options?.gatewayUrl || !options?.token || !options?.model) {
      throw new AgentRuntimeError("INVALID_PLANNER_CONFIG", "GatewayPlanner requires gatewayUrl, token, and model.");
    }
    this.gatewayUrl = loopbackGatewayUrl(options.gatewayUrl);
    this.token = options.token;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  }

  static async bootstrap(options) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const endpoint = new URL("/api/session", options.gatewayUrl);
    const response = await fetchImpl(endpoint, { method: "POST", headers: { origin: options.origin } });
    if (!response.ok) throw new AgentRuntimeError("SESSION_BOOTSTRAP_FAILED", `Gateway session bootstrap failed with HTTP ${response.status}.`);
    const session = await response.json();
    if (typeof session.token !== "string" || session.token.length < 32) throw new AgentRuntimeError("SESSION_BOOTSTRAP_FAILED", "Gateway returned an invalid session token.");
    return new GatewayPlanner({ ...options, token: session.token, fetchImpl });
  }

  plan(context, signal) {
    return this.#call("plan", context, signal);
  }

  repair(context, signal) {
    return this.#call("repair", context, signal);
  }

  review(context, signal) {
    return this.#call("review", context, signal);
  }

  async #call(stage, context, signal) {
    throwIfAborted(signal);
    let response;
    try {
      response = await this.fetchImpl(new URL("/api/ollama/chat", this.gatewayUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: "json",
          options: { temperature: 0 },
          messages: [
            { role: "system", content: `You are the Frontier single-agent ${stage} stage. ${stageInstruction(stage)}` },
            { role: "user", content: JSON.stringify(context) },
          ],
        }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new AgentRuntimeError("CANCELLED", "The model call was cancelled.");
      throw new AgentRuntimeError("MODEL_OFFLINE", "The model gateway is unavailable.", { cause: error?.name });
    }
    if (!response.ok) {
      throw new AgentRuntimeError("MODEL_REQUEST_FAILED", `The model gateway returned HTTP ${response.status}.`, { retryable: response.status === 429 || response.status >= 500 });
    }
    const text = await response.text();
    const envelope = boundedJson(text, this.maxResponseBytes);
    if (typeof envelope?.message?.content !== "string") throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The Ollama response is missing message.content.");
    const value = boundedJson(envelope.message.content, this.maxResponseBytes);
    const usage = {
      source: "ollama",
      model: typeof envelope.model === "string" ? envelope.model : this.model,
      promptTokens: Number.isInteger(envelope.prompt_eval_count) ? envelope.prompt_eval_count : null,
      completionTokens: Number.isInteger(envelope.eval_count) ? envelope.eval_count : null,
      totalDurationNs: Number.isInteger(envelope.total_duration) ? envelope.total_duration : null,
    };
    if (stage === "review") {
      if (typeof value.approved !== "boolean" || !Array.isArray(value.findings) || value.findings.some((finding) => typeof finding !== "string")) {
        throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "Review responses require approved and findings fields.");
      }
      return { value: { approved: value.approved, findings: value.findings }, usage };
    }
    return { value: validateEdits(value), usage };
  }
}
