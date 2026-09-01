# Benchmark 007: Multi-Tenant Ingress Token Bucket & Circuit Breaker Gatekeeper

## Objective
Implement and repair the multi-tenant API ingress gatekeeper in `src/token-bucket.js`, `src/circuit-breaker.js`, and `src/gatekeeper.js`.

The gatekeeper coordinates rate limiting, circuit breaking, request signature verification, and idempotent command replay for high-throughput distributed microservices.

## Mandatory Contracts & Invariant Families

1. **Strict Input Validation & Errors**:
   - `ValidationError` must be thrown for non-object or null request payloads, non-positive numeric capacity, negative refill rate, non-positive consume token counts, or non-string/empty tenant identifier.
   - Values must not be silently coerced (e.g. string `"5"` is not a valid numeric capacity).
   - Export `ValidationError` and `TokenBucket` from `src/token-bucket.js`.

2. **Canonical Key Normalization**:
   - Tenant identifiers must be trimmed and lowercased consistently across registration, token bucket mapping, circuit breaker state, and request routing (e.g., `"  Tenant_Acme  "` maps to `"tenant_acme"`).
   - `evaluateRequest` returns the canonicalized `tenantId: normalizedTenantId` in the result object with `status: 200, allowed: true`.

3. **Token Bucket Rate Limiting**:
   - `TokenBucket(capacity, refillRatePerSec)` initializes with full capacity (`this.tokens = capacity; this.lastRefillMs = null;`).
   - `consume(tokens = 1, timestampMs = Date.now())`: refills tokens continuously based on elapsed time `((timestampMs - lastRefillMs) / 1000) * refillRatePerSec` up to `capacity`.
   - If `this.tokens >= tokens`, consumes tokens and returns `{ allowed: true, remainingTokens: this.tokens }`.
   - If `this.tokens < tokens`, returns `{ allowed: false, remainingTokens: this.tokens, retryAfterSec: (tokens - this.tokens) / refillRatePerSec }` without decrementing tokens.

4. **Sliding Window Circuit Breaker**:
   - `CircuitBreaker({ failureThreshold = 5, recoveryTimeoutMs = 10000, halfOpenSuccessThreshold = 2 } = {})`.
   - Starts in `CLOSED` state. Exposes `getState()` method returning `'CLOSED' | 'OPEN' | 'HALF_OPEN'`.
   - `recordFailure(timestampMs)`: consecutive failures >= `failureThreshold` transitions state to `OPEN`. In `HALF_OPEN`, any failure immediately trips back to `OPEN`.
   - `canExecute(timestampMs)`: returns `false` during `OPEN`. After `recoveryTimeoutMs` elapses, transitions to `HALF_OPEN` and returns `true`. Returns `true` in `CLOSED`.
   - `recordSuccess()`: in `HALF_OPEN`, reaching `halfOpenSuccessThreshold` successes transitions back to `CLOSED`.

5. **Idempotency & Request Intent Conflict**:
   - `IngressGatekeeper` methods (including `evaluateRequest(request)`) are synchronous (do not declare `async evaluateRequest`).
   - In `evaluateRequest(request)`:
     - Check `if (request === null || typeof request !== 'object') throw new ValidationError('Request must be a non-null object');` at the very first line before accessing properties.
     - Normalize `tenantId` by trimming and lowercasing.
     - If `request.idempotencyKey` is provided:
       - Check `this.idempotencyCache.get(request.idempotencyKey)`.
       - If cached entry exists:
         - If `cached.tenantId !== normalizedTenantId || cached.path !== request.path`, throw `new ConflictError('Idempotency key reused with different tenant or path')`.
         - Otherwise, return `{ ...cached.response, idempotentReplay: true }`.
     - When evaluation succeeds with status 200, cache `{ tenantId: normalizedTenantId, path: request.path, response: { ...result } }` in `this.idempotencyCache`.
   - Export `ConflictError` and `IngressGatekeeper` from `src/gatekeeper.js`.

6. **Request Signature Verification**:
   - If `request.signature` is provided, verify HMAC-SHA256 request signature over `${tenantId}:${path}:${timestamp}:${idempotencyKey || ''}` using the tenant's secret. Return `{ status: 401, allowed: false, reason: 'INVALID_SIGNATURE' }` if mismatched. If `request.signature` is omitted, proceed normally.

7. **Clean Multi-Module Integration**:
   - All modules must cleanly export their required classes (`ValidationError`, `TokenBucket`, `CircuitBreaker`, `ConflictError`, `IngressGatekeeper`).
