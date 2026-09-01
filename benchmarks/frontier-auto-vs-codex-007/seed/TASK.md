# Benchmark 007: Multi-Tenant Ingress Token Bucket & Circuit Breaker Gatekeeper

## Objective
Implement and repair the multi-tenant API ingress gatekeeper in `src/token-bucket.js`, `src/circuit-breaker.js`, and `src/gatekeeper.js`.

The gatekeeper coordinates rate limiting, circuit breaking, request signature verification, and idempotent command replay for high-throughput distributed microservices.

## Mandatory Contracts & Invariant Families

1. **Strict Input Validation & Errors**:
   - `ValidationError` must be thrown for any non-positive numeric capacity, negative refill rate, non-object request payload, missing signature, or non-string tenant identifier.
   - Values must not be silently coerced (e.g. string `"5"` is not a valid numeric capacity).

2. **Canonical Key Normalization**:
   - Tenant identifiers must be trimmed and lowercased consistently across registration, token bucket mapping, circuit breaker state, and request routing (e.g., `"  Tenant_Acme  "` maps to `"tenant_acme"`).

3. **Token Bucket Rate Limiting**:
   - `TokenBucket(capacity, refillRatePerSec)` refills tokens smoothly based on elapsed millisecond timestamps (`Date.now()` or explicit `timestampMs`).
   - Tokens cannot exceed `capacity`.
   - `consume(tokens, timestampMs)` deducts tokens if available and returns `{ allowed: true, remainingTokens }`. If insufficient, returns `{ allowed: false, remainingTokens, retryAfterSec }` without decrementing.

4. **Sliding Window Circuit Breaker**:
   - `CircuitBreaker({ failureThreshold, recoveryTimeoutMs, halfOpenSuccessThreshold })`.
   - Starts in `CLOSED` state.
   - When consecutive failures reach `failureThreshold`, state transitions to `OPEN`.
   - While `OPEN`, `canExecute(timestampMs)` returns `false` until `recoveryTimeoutMs` elapses, at which point it transitions to `HALF_OPEN`.
   - In `HALF_OPEN`, successful calls increment consecutive half-open successes. When reaching `halfOpenSuccessThreshold`, it transitions back to `CLOSED`. If any failure occurs in `HALF_OPEN`, it immediately trips back to `OPEN`.

5. **Idempotency & Request Intent Conflict**:
   - If a request includes `idempotencyKey`, repeated executions with the identical payload and signature must return the cached evaluation result without re-consuming rate limit tokens or altering circuit breaker metrics.
   - If an `idempotencyKey` is reused with a different path, tenant, or payload, throw a `ConflictError`.

6. **Request Signature Verification**:
   - Verify HMAC-SHA256 request signatures over canonical request string `${tenantId}:${path}:${timestamp}:${idempotencyKey}` using the tenant's secret.

7. **Clean Multi-Module Integration**:
   - All modules must cleanly export their required classes and functions (`ValidationError`, `ConflictError`, `TokenBucket`, `CircuitBreaker`, `IngressGatekeeper`).
