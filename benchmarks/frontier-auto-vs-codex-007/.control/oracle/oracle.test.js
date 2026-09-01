import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { TokenBucket, ValidationError } from "../../src/token-bucket.js";
import { CircuitBreaker } from "../../src/circuit-breaker.js";
import { IngressGatekeeper, ConflictError, computeSignature } from "../../src/gatekeeper.js";

function isValidationError(err) {
  return err instanceof ValidationError || err?.name === "ValidationError" || /validation/i.test(err?.message || "");
}

function isConflictError(err) {
  return err instanceof ConflictError || err?.name === "ConflictError" || /conflict/i.test(err?.message || "");
}

// -------------------------------------------------------------
// Category 1: Strict Input Validation (15 points)
// -------------------------------------------------------------
test("Category 1 [15pts]: Strict numeric and type validation without coercion", () => {
  assert.throws(() => new TokenBucket(-1, 1), isValidationError, "negative capacity must throw ValidationError");
  assert.throws(() => new TokenBucket(0, 1), isValidationError, "zero capacity must throw ValidationError");
  assert.throws(() => new TokenBucket("10", 1), isValidationError, "string capacity must throw ValidationError");
  assert.throws(() => new TokenBucket(10, -0.5), isValidationError, "negative refill rate must throw ValidationError");

  const bucket = new TokenBucket(5, 1);
  assert.throws(() => bucket.consume(-1), isValidationError, "negative tokens requested must throw ValidationError");
  assert.throws(() => bucket.consume("1"), isValidationError, "string tokens requested must throw ValidationError");

  const gk = new IngressGatekeeper();
  assert.throws(() => gk.registerTenant("", { secret: "sec" }), isValidationError, "empty tenantId must throw ValidationError");
  assert.throws(() => gk.registerTenant("t1", { secret: "" }), isValidationError, "empty secret must throw ValidationError");
  assert.throws(() => gk.evaluateRequest(null), isValidationError, "null request must throw ValidationError");
});

// -------------------------------------------------------------
// Category 2: Canonical Key Normalization (15 points)
// -------------------------------------------------------------
test("Category 2 [15pts]: Canonical identifier normalization across boundaries", () => {
  const gk = new IngressGatekeeper();
  gk.registerTenant("  Alpha_Tenant  ", { secret: "secret-alpha", capacity: 10, refillRatePerSec: 1 });

  const req1 = gk.evaluateRequest({ tenantId: "alpha_tenant", path: "/api/v1/test", timestamp: 1000 });
  assert.equal(req1.status, 200, "lowercase lookup must match registered tenant");

  const req2 = gk.evaluateRequest({ tenantId: "  ALPHA_TENANT  ", path: "/api/v1/test", timestamp: 1000 });
  assert.equal(req2.status, 200, "uppercase and spaced lookup must match registered tenant");
  assert.equal(req2.tenantId, "alpha_tenant", "evaluated tenantId must be canonicalized");
});

// -------------------------------------------------------------
// Category 3: Token Bucket Rate Limiting (15 points)
// -------------------------------------------------------------
test("Category 3 [15pts]: Time-based token bucket replenishment and quota bounding", () => {
  const bucket = new TokenBucket(4, 2); // 4 tokens capacity, 2 tokens/sec
  const t0 = 1000000;

  // Consume initial capacity
  const c1 = bucket.consume(3, t0);
  assert.equal(c1.allowed, true);
  assert.equal(c1.remainingTokens, 1);

  const c2 = bucket.consume(2, t0); // requires 2, only 1 left
  assert.equal(c2.allowed, false);
  assert.equal(c2.remainingTokens, 1);
  assert.equal(c2.retryAfterSec, 0.5); // 1 token needed at 2/sec = 0.5s

  // Advance time by 1.5 seconds (adds 3 tokens: 1 + 3 = 4 cap)
  const c3 = bucket.consume(4, t0 + 1500);
  assert.equal(c3.allowed, true);
  assert.equal(c3.remainingTokens, 0);

  // Advance time by 10 seconds (cap must not exceed capacity 4)
  const c4 = bucket.consume(1, t0 + 11500);
  assert.equal(c4.allowed, true);
  assert.equal(c4.remainingTokens, 3);
});

// -------------------------------------------------------------
// Category 4: Circuit Breaker State Machine (15 points)
// -------------------------------------------------------------
test("Category 4 [15pts]: Circuit breaker CLOSED -> OPEN -> HALF_OPEN -> CLOSED state lifecycle", () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 5000, halfOpenSuccessThreshold: 2 });
  const t0 = 1000000;

  assert.equal(breaker.getState(), "CLOSED");
  assert.equal(breaker.canExecute(t0), true);

  // Record 2 failures (under threshold)
  breaker.recordFailure(t0);
  breaker.recordFailure(t0);
  assert.equal(breaker.getState(), "CLOSED");
  assert.equal(breaker.canExecute(t0), true);

  // 3rd failure trips to OPEN
  breaker.recordFailure(t0);
  assert.equal(breaker.getState(), "OPEN");
  assert.equal(breaker.canExecute(t0 + 1000), false); // Within recovery window

  // Advance past recovery timeout (5000ms) -> transitions to HALF_OPEN
  assert.equal(breaker.canExecute(t0 + 5001), true);
  assert.equal(breaker.getState(), "HALF_OPEN");

  // 1st success in HALF_OPEN
  breaker.recordSuccess();
  assert.equal(breaker.getState(), "HALF_OPEN");

  // 2nd success completes halfOpenSuccessThreshold -> transitions to CLOSED
  breaker.recordSuccess();
  assert.equal(breaker.getState(), "CLOSED");

  // Trip to OPEN again and test failure in HALF_OPEN immediately re-tripping
  breaker.recordFailure(t0 + 6000);
  breaker.recordFailure(t0 + 6000);
  breaker.recordFailure(t0 + 6000);
  assert.equal(breaker.getState(), "OPEN");

  // Advance to HALF_OPEN
  assert.equal(breaker.canExecute(t0 + 12000), true);
  assert.equal(breaker.getState(), "HALF_OPEN");

  // Failure in HALF_OPEN immediately trips back to OPEN
  breaker.recordFailure(t0 + 12001);
  assert.equal(breaker.getState(), "OPEN");
});

// -------------------------------------------------------------
// Category 5: Idempotent Command Replay (15 points)
// -------------------------------------------------------------
test("Category 5 [15pts]: Idempotent command replay without double-consumption", () => {
  const gk = new IngressGatekeeper();
  gk.registerTenant("tenant-beta", { secret: "beta-sec", capacity: 2, refillRatePerSec: 0 });

  const req = {
    tenantId: "tenant-beta",
    path: "/payments/charge",
    timestamp: 1000,
    idempotencyKey: "idem-req-001",
    tokens: 1,
  };

  // Turn 1: Initial call consumes 1 token (1 remaining)
  const res1 = gk.evaluateRequest(req);
  assert.equal(res1.status, 200);
  assert.equal(res1.remainingTokens, 1);

  // Turn 2: Duplicate call returns identical cached result without consuming the 2nd token
  const res2 = gk.evaluateRequest(req);
  assert.equal(res2.status, 200);
  assert.equal(res2.idempotentReplay, true);

  // Verify that the second token is still available for a new request
  const res3 = gk.evaluateRequest({ ...req, idempotencyKey: "idem-req-002" });
  assert.equal(res3.status, 200);
  assert.equal(res3.remainingTokens, 0);
});

// -------------------------------------------------------------
// Category 6: Request Intent Conflict Detection (15 points)
// -------------------------------------------------------------
test("Category 6 [15pts]: Reusing idempotency key with conflicting payload throws ConflictError", () => {
  const gk = new IngressGatekeeper();
  gk.registerTenant("tenant-gamma", { secret: "gamma-sec", capacity: 10 });
  gk.registerTenant("tenant-delta", { secret: "delta-sec", capacity: 10 });

  gk.evaluateRequest({
    tenantId: "tenant-gamma",
    path: "/orders/create",
    timestamp: 1000,
    idempotencyKey: "idem-order-999",
  });

  // Reusing same idempotencyKey for different path must throw ConflictError
  assert.throws(() => {
    gk.evaluateRequest({
      tenantId: "tenant-gamma",
      path: "/orders/cancel",
      timestamp: 1000,
      idempotencyKey: "idem-order-999",
    });
  }, isConflictError, "differing path with same idempotency key must throw ConflictError");

  // Reusing same idempotencyKey for different tenant must throw ConflictError
  assert.throws(() => {
    gk.evaluateRequest({
      tenantId: "tenant-delta",
      path: "/orders/create",
      timestamp: 1000,
      idempotencyKey: "idem-order-999",
    });
  }, isConflictError, "differing tenant with same idempotency key must throw ConflictError");
});

// -------------------------------------------------------------
// Category 7: Request Signature Verification & Gatekeeper Routing (10 points)
// -------------------------------------------------------------
test("Category 7 [10pts]: HMAC-SHA256 signature verification over canonical request string", () => {
  const gk = new IngressGatekeeper();
  const secret = "secret-key-777";
  gk.registerTenant("tenant-secure", { secret, capacity: 5, refillRatePerSec: 1 });

  const path = "/api/v2/secure-resource";
  const timestamp = 1700000000000;
  const idempotencyKey = "key-sec-1";
  const canonical = `tenant-secure:${path}:${timestamp}:${idempotencyKey}`;
  const validSignature = crypto.createHmac("sha256", secret).update(canonical).digest("hex");

  // Valid signature
  const resValid = gk.evaluateRequest({
    tenantId: "tenant-secure",
    path,
    timestamp,
    idempotencyKey,
    signature: validSignature,
  });
  assert.equal(resValid.status, 200);

  // Tampered signature
  const resInvalid = gk.evaluateRequest({
    tenantId: "tenant-secure",
    path,
    timestamp,
    idempotencyKey: "key-sec-2", // different key without updating signature
    signature: validSignature,
  });
  assert.equal(resInvalid.status, 401);
  assert.equal(resInvalid.reason, "INVALID_SIGNATURE");
});
