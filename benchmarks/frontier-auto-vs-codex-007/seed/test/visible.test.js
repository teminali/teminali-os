import test from "node:test";
import assert from "node:assert/strict";
import { TokenBucket, ValidationError } from "../src/token-bucket.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { IngressGatekeeper, ConflictError } from "../src/gatekeeper.js";

test("strict input validation: invalid capacity throws ValidationError", () => {
  assert.throws(() => new TokenBucket(-5, 1), (err) => err instanceof ValidationError || err?.name === "ValidationError", "validationerror: positive integer capacity required");
  assert.throws(() => new TokenBucket("10", 1), (err) => err instanceof ValidationError || err?.name === "ValidationError", "validationerror: no string coercion");
});

test("canonical key normalization: tenant lookup normalizes case and trims whitespace", () => {
  const gk = new IngressGatekeeper();
  gk.registerTenant("  Acme_Corp  ", { secret: "sec-1", capacity: 5, refillRatePerSec: 1 });
  const res = gk.evaluateRequest({ tenantId: "acme_corp", path: "/v1/data", timestamp: Date.now() });
  assert.notEqual(res.status, 404, "canonical-key-normalization: tenant should be found");
});

test("token bucket basic rate limiting", () => {
  const bucket = new TokenBucket(2, 1);
  const r1 = bucket.consume(1);
  assert.equal(r1.allowed, true);
  const r2 = bucket.consume(1);
  assert.equal(r2.allowed, true);
  const r3 = bucket.consume(1);
  assert.equal(r3.allowed, false, "aggregate-state-accounting: capacity exceeded");
});
