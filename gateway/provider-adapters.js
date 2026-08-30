const GROQ_CHAT_COMPLETIONS =
  "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_CHAT_COMPLETIONS =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const ANTHROPIC_CHAT_COMPLETIONS =
  "https://api.anthropic.com/v1/chat/completions";

const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function normalizeModelMap(modelMap) {
  if (modelMap === null || typeof modelMap !== "object" || Array.isArray(modelMap)) {
    throw new TypeError("modelMap must be an object");
  }

  const entries = Object.entries(modelMap);
  if (entries.length === 0) throw new TypeError("modelMap must contain at least one model");

  return new Map(
    entries.map(([logicalModel, providerModel]) => {
      if (logicalModel.length === 0) {
        throw new TypeError("logical model names must be non-empty strings");
      }
      if (typeof providerModel !== "string" || providerModel.length === 0) {
        throw new TypeError("provider model names must be non-empty strings");
      }
      return [logicalModel, providerModel];
    }),
  );
}

function createOpenAICompatibleUpstream({
  alias,
  endpoint,
  getApiKey,
  modelMap,
}) {
  if (typeof alias !== "string" || alias.length === 0) {
    throw new TypeError("alias must be a non-empty string");
  }
  if (typeof getApiKey !== "function") {
    throw new TypeError("getApiKey must be a function");
  }

  const models = normalizeModelMap(modelMap);

  return Object.freeze({
    alias,
    endpoint,
    async getSecretHeaders() {
      const apiKey = await getApiKey();
      if (typeof apiKey !== "string" || apiKey.length < 8) {
        throw new TypeError(`API key unavailable for upstream: ${alias}`);
      }
      return { authorization: `Bearer ${apiKey}` };
    },
    transformRequest(body) {
      const providerModel = models.get(body.model);
      if (providerModel === undefined) {
        throw new TypeError(`model is not mapped for upstream: ${alias}`);
      }
      return { ...body, model: providerModel };
    },
  });
}

export function createGroqUpstream({
  alias,
  getApiKey,
  modelMap = { "frontier-code": "openai/gpt-oss-120b" },
  endpoint = GROQ_CHAT_COMPLETIONS,
}) {
  return createOpenAICompatibleUpstream({ alias, endpoint, getApiKey, modelMap });
}

export function createGeminiUpstream({
  alias,
  getApiKey,
  modelMap = { "frontier-code": "gemini-3.7-flash" },
  endpoint = GEMINI_CHAT_COMPLETIONS,
}) {
  return createOpenAICompatibleUpstream({ alias, endpoint, getApiKey, modelMap });
}

export function createAnthropicUpstream({
  alias,
  getApiKey,
  getWorkspaceId,
  modelMap = { "frontier-code": "claude-sonnet-5" },
  effort = "medium",
  endpoint = ANTHROPIC_CHAT_COMPLETIONS,
}) {
  if (typeof getWorkspaceId !== "function") {
    throw new TypeError("getWorkspaceId must be a function");
  }
  if (!CLAUDE_EFFORTS.has(effort)) {
    throw new TypeError("effort must be low, medium, high, xhigh, or max");
  }

  const compatible = createOpenAICompatibleUpstream({
    alias,
    endpoint,
    getApiKey,
    modelMap,
  });

  return Object.freeze({
    ...compatible,
    async getSecretHeaders() {
      const headers = await compatible.getSecretHeaders();
      const workspaceId = await getWorkspaceId();
      if (typeof workspaceId !== "string" || !/^wrkspc_[A-Za-z0-9]+$/.test(workspaceId)) {
        throw new TypeError(`workspace ID unavailable for upstream: ${alias}`);
      }
      return {
        ...headers,
        "anthropic-workspace-id": workspaceId,
      };
    },
    transformRequest(body) {
      const transformed = compatible.transformRequest(body);
      const { reasoning_effort: _ignored, ...request } = transformed;
      return {
        ...request,
        output_config: {
          ...(request.output_config ?? {}),
          effort,
        },
      };
    },
  });
}
