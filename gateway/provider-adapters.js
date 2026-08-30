const GROQ_CHAT_COMPLETIONS =
  "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_CHAT_COMPLETIONS =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

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
