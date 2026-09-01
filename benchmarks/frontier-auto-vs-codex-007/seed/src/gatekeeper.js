import { ValidationError } from "./token-bucket.js";
import { TokenBucket } from "./token-bucket.js";
import { CircuitBreaker } from "./circuit-breaker.js";

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
  }
}

export class IngressGatekeeper {
  constructor() {
    this.tenants = new Map();
    this.buckets = new Map();
    this.breakers = new Map();
  }

  registerTenant(tenantId, { secret, capacity = 10, refillRatePerSec = 1 } = {}) {
    // Seed stub: no canonical normalization or input validation
    this.tenants.set(tenantId, { secret });
    this.buckets.set(tenantId, new TokenBucket(capacity, refillRatePerSec));
    this.breakers.set(tenantId, new CircuitBreaker());
  }

  evaluateRequest(request) {
    // Seed stub: lacks signature verification, idempotency cache, and conflict detection
    const tenant = this.tenants.get(request?.tenantId);
    if (!tenant) {
      return { status: 404, allowed: false, reason: "TENANT_NOT_FOUND" };
    }
    const bucket = this.buckets.get(request.tenantId);
    const result = bucket.consume(1);
    if (!result.allowed) {
      return { status: 429, allowed: false, reason: "RATE_LIMITED", retryAfterSec: result.retryAfterSec };
    }
    return { status: 200, allowed: true, tenantId: request.tenantId };
  }
}
