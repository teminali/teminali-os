import crypto from "node:crypto";
import { TokenBucket, ValidationError } from "./token-bucket.js";
import { CircuitBreaker } from "./circuit-breaker.js";

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
  }
}

export function normalizeTenantId(tenantId) {
  if (typeof tenantId !== "string" || !tenantId.trim()) {
    throw new ValidationError("Tenant identifier must be a non-empty string.");
  }
  return tenantId.trim().toLowerCase();
}

export function computeSignature(secret, canonicalPayload) {
  return crypto.createHmac("sha256", secret).update(canonicalPayload).digest("hex");
}

export class IngressGatekeeper {
  constructor() {
    this.tenants = new Map();
    this.buckets = new Map();
    this.breakers = new Map();
    this.idempotencyLedger = new Map();
  }

  registerTenant(tenantId, {
    secret,
    capacity = 10,
    refillRatePerSec = 2,
    failureThreshold = 5,
    recoveryTimeoutMs = 10000,
  } = {}) {
    if (!secret || typeof secret !== "string") {
      throw new ValidationError("Tenant secret is required and must be a string.");
    }
    const normalizedId = normalizeTenantId(tenantId);
    this.tenants.set(normalizedId, { secret });
    this.buckets.set(normalizedId, new TokenBucket(capacity, refillRatePerSec));
    this.breakers.set(normalizedId, new CircuitBreaker({ failureThreshold, recoveryTimeoutMs }));
  }

  evaluateRequest(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new ValidationError("Request payload must be a non-null object.");
    }
    const {
      tenantId: rawTenantId,
      path,
      timestamp = Date.now(),
      signature,
      idempotencyKey,
      tokens = 1,
    } = request;

    if (!rawTenantId) {
      throw new ValidationError("tenantId is required in request.");
    }
    const tenantId = normalizeTenantId(rawTenantId);
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return { status: 404, allowed: false, reason: "TENANT_NOT_FOUND" };
    }

    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new ValidationError("path must be a valid root-relative URL string.");
    }

    // Check Idempotency and Intent Conflict
    if (idempotencyKey) {
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        throw new ValidationError("idempotencyKey must be a non-empty string.");
      }
      const existing = this.idempotencyLedger.get(idempotencyKey);
      if (existing) {
        if (existing.tenantId !== tenantId || existing.path !== path) {
          throw new ConflictError("idempotencyKey reused for conflicting request intent.");
        }
        return { ...existing.result, idempotentReplay: true };
      }
    }

    // Verify Signature
    if (signature) {
      const canonical = `${tenantId}:${path}:${timestamp}:${idempotencyKey || ""}`;
      const expectedSignature = computeSignature(tenant.secret, canonical);
      if (signature !== expectedSignature) {
        return { status: 401, allowed: false, reason: "INVALID_SIGNATURE" };
      }
    }

    // Circuit Breaker check
    const breaker = this.breakers.get(tenantId);
    if (breaker && !breaker.canExecute(timestamp)) {
      return { status: 503, allowed: false, reason: "CIRCUIT_BREAKER_OPEN" };
    }

    // Token Bucket rate limit check
    const bucket = this.buckets.get(tenantId);
    const consumption = bucket.consume(tokens, timestamp);
    if (!consumption.allowed) {
      return {
        status: 429,
        allowed: false,
        reason: "RATE_LIMITED",
        remainingTokens: consumption.remainingTokens,
        retryAfterSec: consumption.retryAfterSec,
      };
    }

    const result = {
      status: 200,
      allowed: true,
      tenantId,
      remainingTokens: consumption.remainingTokens,
    };

    if (idempotencyKey) {
      this.idempotencyLedger.set(idempotencyKey, {
        tenantId,
        path,
        result,
      });
    }

    return result;
  }

  recordBackendOutcome(tenantId, success, timestamp = Date.now()) {
    const normalized = normalizeTenantId(tenantId);
    const breaker = this.breakers.get(normalized);
    if (breaker) {
      if (success) breaker.recordSuccess();
      else breaker.recordFailure(timestamp);
    }
  }
}
