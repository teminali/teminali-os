import assert from "node:assert/strict";
import test from "node:test";

import {
  BudgetExceededError,
  normalizePricing,
  parseUsdMicros,
  RunBudget,
} from "./run-budget.js";

const GEMINI_PRICING = {
  inputUsdPerMillion: "0.75",
  outputUsdPerMillion: "3.75",
};

test("parses USD values exactly into integer micro-dollars", () => {
  assert.equal(parseUsdMicros("0.01"), 10_000);
  assert.equal(parseUsdMicros("1.000001"), 1_000_001);
  assert.deepEqual(normalizePricing(GEMINI_PRICING), {
    inputMicrosPerMillion: 750_000,
    outputMicrosPerMillion: 3_750_000,
  });
  assert.throws(() => parseUsdMicros("0.0000001"), /non-negative USD amount/);
});

test("commits a conservative worst-case token and USD reservation", () => {
  const budget = new RunBudget({
    maxRequests: 2,
    maxTokens: 10_000,
    maxUsdMicros: 20_000,
  });
  const lease = budget.reserve({
    inputTokens: 1_000,
    outputTokens: 2_000,
    pricing: GEMINI_PRICING,
  });
  assert.equal(lease.estimatedUsdMicros, 8_250);
  assert.equal(budget.snapshot().reservedTokens, 3_000);
  lease.commit();

  assert.deepEqual(budget.snapshot(), {
    requests: 1,
    tokens: 3_000,
    reservedTokens: 0,
    usdMicros: 8_250,
    reservedUsdMicros: 0,
    usedUsd: "0.008250",
    maxRequests: 2,
    maxTokens: 10_000,
    maxUsdMicros: 20_000,
    maxUsd: "0.020000",
    remainingRequests: 1,
    remainingTokens: 7_000,
    remainingUsdMicros: 11_750,
  });
});

test("a failed upstream releases token and USD usage but consumes an attempt", () => {
  const budget = new RunBudget({
    maxRequests: 1,
    maxTokens: 1_000,
    maxUsdMicros: 10_000,
  });
  budget
    .reserve({ inputTokens: 100, outputTokens: 100, pricing: GEMINI_PRICING })
    .releaseUsage();

  const snapshot = budget.snapshot();
  assert.equal(snapshot.requests, 1);
  assert.equal(snapshot.tokens, 0);
  assert.equal(snapshot.usdMicros, 0);
  assert.throws(
    () =>
      budget.reserve({
        inputTokens: 100,
        outputTokens: 100,
        pricing: GEMINI_PRICING,
      }),
    (error) => error instanceof BudgetExceededError && error.reason === "requests",
  );
});

test("rejects token and USD exhaustion before creating a reservation", () => {
  const tokenBudget = new RunBudget({
    maxRequests: 10,
    maxTokens: 100,
    maxUsdMicros: 1_000_000,
  });
  assert.throws(
    () =>
      tokenBudget.reserve({
        inputTokens: 60,
        outputTokens: 60,
        pricing: GEMINI_PRICING,
      }),
    (error) => error instanceof BudgetExceededError && error.reason === "tokens",
  );
  assert.equal(tokenBudget.snapshot().requests, 0);

  const usdBudget = new RunBudget({
    maxRequests: 10,
    maxTokens: 10_000,
    maxUsdMicros: 100,
  });
  assert.throws(
    () =>
      usdBudget.reserve({
        inputTokens: 100,
        outputTokens: 100,
        pricing: GEMINI_PRICING,
      }),
    (error) => error instanceof BudgetExceededError && error.reason === "usd",
  );
  assert.equal(usdBudget.snapshot().requests, 0);
});
