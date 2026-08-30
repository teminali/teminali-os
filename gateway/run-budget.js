const MICROS_PER_USD = 1_000_000;
const TOKENS_PER_MILLION = 1_000_000n;

export class BudgetExceededError extends Error {
  constructor(reason) {
    super(`Run budget exhausted: ${reason}`);
    this.name = "BudgetExceededError";
    this.reason = reason;
    this.status = 429;
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export function parseUsdMicros(value, name = "USD value") {
  const text = String(value);
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new TypeError(`${name} must be a non-negative USD amount`);
  const whole = BigInt(match[1]);
  const fractional = BigInt((match[2] ?? "").padEnd(6, "0"));
  const micros = whole * BigInt(MICROS_PER_USD) + fractional;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${name} is too large`);
  }
  return Number(micros);
}

export function normalizePricing(pricing, name = "pricing") {
  if (pricing === null || typeof pricing !== "object" || Array.isArray(pricing)) {
    throw new TypeError(`${name} must be an object`);
  }
  const allowed = new Set(["inputUsdPerMillion", "outputUsdPerMillion"]);
  for (const key of Object.keys(pricing)) {
    if (!allowed.has(key)) throw new TypeError(`${name} has unsupported field: ${key}`);
  }
  return Object.freeze({
    inputMicrosPerMillion: parseUsdMicros(
      pricing.inputUsdPerMillion,
      `${name}.inputUsdPerMillion`,
    ),
    outputMicrosPerMillion: parseUsdMicros(
      pricing.outputUsdPerMillion,
      `${name}.outputUsdPerMillion`,
    ),
  });
}

function estimatedCostMicros(inputTokens, outputTokens, pricing) {
  const numerator =
    BigInt(inputTokens) * BigInt(pricing.inputMicrosPerMillion) +
    BigInt(outputTokens) * BigInt(pricing.outputMicrosPerMillion);
  return Number((numerator + TOKENS_PER_MILLION - 1n) / TOKENS_PER_MILLION);
}

function usdString(micros) {
  const whole = Math.floor(micros / MICROS_PER_USD);
  const fractional = String(micros % MICROS_PER_USD).padStart(6, "0");
  return `${whole}.${fractional}`;
}

export class RunBudget {
  #limits;
  #requests = 0;
  #tokens = 0;
  #reservedTokens = 0;
  #usdMicros = 0;
  #reservedUsdMicros = 0;

  constructor({ maxRequests, maxTokens, maxUsdMicros }) {
    this.#limits = Object.freeze({
      maxRequests: positiveInteger(maxRequests, "maxRequests"),
      maxTokens: positiveInteger(maxTokens, "maxTokens"),
      maxUsdMicros: positiveInteger(maxUsdMicros, "maxUsdMicros"),
    });
  }

  reserve({ inputTokens, outputTokens, pricing }) {
    positiveInteger(inputTokens, "inputTokens");
    positiveInteger(outputTokens, "outputTokens");
    const normalizedPricing = normalizePricing(pricing);
    const estimatedTokens = inputTokens + outputTokens;
    const estimatedUsdMicros = estimatedCostMicros(
      inputTokens,
      outputTokens,
      normalizedPricing,
    );

    if (this.#requests + 1 > this.#limits.maxRequests) {
      throw new BudgetExceededError("requests");
    }
    if (
      this.#tokens + this.#reservedTokens + estimatedTokens >
      this.#limits.maxTokens
    ) {
      throw new BudgetExceededError("tokens");
    }
    if (
      this.#usdMicros + this.#reservedUsdMicros + estimatedUsdMicros >
      this.#limits.maxUsdMicros
    ) {
      throw new BudgetExceededError("usd");
    }

    this.#requests += 1;
    this.#reservedTokens += estimatedTokens;
    this.#reservedUsdMicros += estimatedUsdMicros;
    let settled = false;
    const settle = (actualUsage) => {
      if (settled) throw new Error("budget lease is already settled");
      let committedTokens = estimatedTokens;
      let committedUsdMicros = estimatedUsdMicros;
      if (actualUsage !== undefined) {
        if (
          actualUsage === null ||
          typeof actualUsage !== "object" ||
          Array.isArray(actualUsage)
        ) {
          throw new TypeError("actualUsage must be an object");
        }
        const inputTokens = nonNegativeInteger(
          actualUsage.inputTokens,
          "actualUsage.inputTokens",
        );
        const outputTokens = nonNegativeInteger(
          actualUsage.outputTokens,
          "actualUsage.outputTokens",
        );
        committedTokens = inputTokens + outputTokens;
        if (!Number.isSafeInteger(committedTokens) || committedTokens <= 0) {
          throw new TypeError("actualUsage total must be a positive safe integer");
        }
        committedUsdMicros = estimatedCostMicros(
          inputTokens,
          outputTokens,
          normalizedPricing,
        );
      }

      settled = true;
      this.#reservedTokens -= estimatedTokens;
      this.#reservedUsdMicros -= estimatedUsdMicros;
      this.#tokens += committedTokens;
      this.#usdMicros += committedUsdMicros;
    };
    const release = () => {
      if (settled) throw new Error("budget lease is already settled");
      settled = true;
      this.#reservedTokens -= estimatedTokens;
      this.#reservedUsdMicros -= estimatedUsdMicros;
    };

    return Object.freeze({
      estimatedTokens,
      estimatedUsdMicros,
      commit(actualUsage) {
        settle(actualUsage);
      },
      releaseUsage() {
        release();
      },
    });
  }

  snapshot() {
    return Object.freeze({
      requests: this.#requests,
      tokens: this.#tokens,
      reservedTokens: this.#reservedTokens,
      usdMicros: this.#usdMicros,
      reservedUsdMicros: this.#reservedUsdMicros,
      usedUsd: usdString(this.#usdMicros),
      maxRequests: this.#limits.maxRequests,
      maxTokens: this.#limits.maxTokens,
      maxUsdMicros: this.#limits.maxUsdMicros,
      maxUsd: usdString(this.#limits.maxUsdMicros),
      remainingRequests: this.#limits.maxRequests - this.#requests,
      remainingTokens:
        this.#limits.maxTokens - this.#tokens - this.#reservedTokens,
      remainingUsdMicros:
        this.#limits.maxUsdMicros -
        this.#usdMicros -
        this.#reservedUsdMicros,
    });
  }
}
