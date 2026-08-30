import assert from "node:assert/strict";
import test from "node:test";

import { loadRuntimeConfig } from "./runtime-config.js";
import { startGateway } from "./start-gateway.js";

const ACCESS_TOKEN = "local-gateway-access-token";
const GEMINI_SECRET = "gemini-provider-secret";
const GROQ_SECRET = "groq-provider-secret";

function validEnv() {
  return {
    GATEWAY_ACCESS_TOKEN: ACCESS_TOKEN,
    GATEWAY_MAX_REQUESTS_PER_RUN: "10",
    GATEWAY_MAX_TOKENS_PER_RUN: "50000",
    GATEWAY_MAX_USD_PER_RUN: "1.00",
    GEMINI_KEY_MAIN: GEMINI_SECRET,
    GROQ_KEY_BACKUP: GROQ_SECRET,
    GATEWAY_LANES_JSON: JSON.stringify([
      {
        alias: "gemini-main",
        provider: "gemini",
        quotaGroup: "gemini-project-terralink",
        apiKeyEnv: "GEMINI_KEY_MAIN",
        providerModel: "gemini-3.7-flash",
        limits: { rpm: 1_000, rpd: 10_000, tpm: 2_000_000 },
        pricing: { inputUsdPerMillion: "0.75", outputUsdPerMillion: "3.75" },
      },
      {
        alias: "groq-backup",
        provider: "groq",
        quotaGroup: "groq-org-backup",
        apiKeyEnv: "GROQ_KEY_BACKUP",
        providerModel: "openai/gpt-oss-120b",
        limits: { rpm: 30, rpd: 1_000, tpm: 8_000, tpd: 200_000 },
        pricing: { inputUsdPerMillion: "0.15", outputUsdPerMillion: "0.60" },
      },
    ]),
  };
}

test("runtime config builds strict local-only provider lanes", async () => {
  const runtime = loadRuntimeConfig(validEnv());
  const gatewayOptions = runtime.getGatewayOptions();

  assert.deepEqual(runtime.listen, { host: "127.0.0.1", port: 8_787 });
  assert.equal(runtime.safeSummary.mode, "enhanced");
  assert.equal(runtime.safeSummary.runBudget.maxUsdMicros, 1_000_000);
  assert.equal(gatewayOptions.allowedModels[0], "frontier-code");
  assert.equal(
    gatewayOptions.upstreams[0].transformRequest({ model: "frontier-code" }).model,
    "gemini-3.7-flash",
  );
  assert.deepEqual(await gatewayOptions.upstreams[1].getSecretHeaders(), {
    authorization: `Bearer ${GROQ_SECRET}`,
  });

  const serializedRuntime = JSON.stringify(runtime);
  assert.equal(serializedRuntime.includes(ACCESS_TOKEN), false);
  assert.equal(serializedRuntime.includes(GEMINI_SECRET), false);
  assert.equal(serializedRuntime.includes(GROQ_SECRET), false);
});

test("runtime config requires explicit quota and credential declarations", () => {
  const missingKey = validEnv();
  delete missingKey.GEMINI_KEY_MAIN;
  assert.throws(() => loadRuntimeConfig(missingKey), /GEMINI_KEY_MAIN/);

  const unsupported = validEnv();
  const lanes = JSON.parse(unsupported.GATEWAY_LANES_JSON);
  lanes[0].endpoint = "https://attacker.invalid";
  unsupported.GATEWAY_LANES_JSON = JSON.stringify(lanes);
  assert.throws(() => loadRuntimeConfig(unsupported), /unsupported field: endpoint/);
});

test("runtime config requires all hard run budgets and lane pricing", () => {
  const missingBudget = validEnv();
  delete missingBudget.GATEWAY_MAX_USD_PER_RUN;
  assert.throws(() => loadRuntimeConfig(missingBudget), /GATEWAY_MAX_USD_PER_RUN/);

  const missingPricing = validEnv();
  const lanes = JSON.parse(missingPricing.GATEWAY_LANES_JSON);
  delete lanes[0].pricing;
  missingPricing.GATEWAY_LANES_JSON = JSON.stringify(lanes);
  assert.throws(() => loadRuntimeConfig(missingPricing), /pricing/);
});

test("controlled mode must pin a configured lane", () => {
  const invalid = { ...validEnv(), GATEWAY_PINNED_ALIAS: "missing" };
  assert.throws(() => loadRuntimeConfig(invalid), /must name a configured lane/);

  const controlled = { ...validEnv(), GATEWAY_PINNED_ALIAS: "gemini-main" };
  assert.equal(loadRuntimeConfig(controlled).safeSummary.mode, "controlled");
});

test("launcher reports only a safe startup summary", async () => {
  const writes = [];
  let receivedOptions;
  let receivedListen;
  const fakeGateway = {
    async listen(options) {
      receivedListen = options;
      return "http://127.0.0.1:8787";
    },
    async close() {},
  };

  const running = await startGateway({
    env: validEnv(),
    createGatewayImpl(options) {
      receivedOptions = options;
      return fakeGateway;
    },
    stdout: { write: (value) => writes.push(value) },
  });

  assert.equal(receivedOptions.quotaLanes.length, 2);
  assert.deepEqual(receivedListen, { host: "127.0.0.1", port: 8_787 });
  assert.equal(running.gateway, fakeGateway);
  const output = writes.join("");
  assert.match(output, /model=frontier-code mode=enhanced lanes=2/);
  assert.equal(output.includes(ACCESS_TOKEN), false);
  assert.equal(output.includes(GEMINI_SECRET), false);
  assert.equal(output.includes(GROQ_SECRET), false);
});
