import { ValidationError, TokenBucket } from './token-bucket.js';
import { CircuitBreaker } from './circuit-breaker.js';
import crypto from 'crypto';

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
    this.idempotencyCache = new Map();
  }

  registerTenant(tenantId, { secret, capacity = 10, refillRatePerSec = 1 } = {}) {
    const normalizedTenantId = tenantId.trim().toLowerCase();
    if (typeof secret !== 'string' || !secret) {
      throw new ValidationError('Secret must be a non-empty string');
    }

    this.tenants.set(normalizedTenantId, { secret });
    this.buckets.set(normalizedTenantId, new TokenBucket(capacity, refillRatePerSec));
    this.breakers.set(normalizedTenantId, new CircuitBreaker());
  }

  evaluateRequest(request) {
    if (request === null || typeof request !== 'object') {
      throw new ValidationError('Request must be a non-null object');
    }

    const { tenantId: rawTenantId, path = '', idempotencyKey, signature } = request;
    const normalizedTenantId = rawTenantId.trim().toLowerCase();

    if (typeof normalizedTenantId !== 'string' || !normalizedTenantId) {
      throw new ValidationError('Tenant identifier must be a non-empty string');
    }

    const tenant = this.tenants.get(normalizedTenantId);
    if (!tenant) {
      return { status: 404, allowed: false, reason: 'TENANT_NOT_FOUND' };
    }

    if (idempotencyKey) {
      const cachedEntry = this.idempotencyCache.get(idempotencyKey);
      if (cachedEntry) {
        if (cachedEntry.tenantId !== normalizedTenantId || cachedEntry.path !== path) {
          throw new ConflictError('Idempotency key reused with different tenant or path');
        }
        return { ...cachedEntry.response, idempotentReplay: true };
      }
    }

    const breaker = this.breakers.get(normalizedTenantId);
    if (!breaker.canExecute()) {
      return { status: 503, allowed: false, reason: 'CIRCUIT_BREAKER_OPEN' };
    }

    const bucket = this.buckets.get(normalizedTenantId);
    const result = bucket.consume();
    if (!result.allowed) {
      breaker.recordFailure();
      return { status: 429, allowed: false, reason: 'RATE_LIMITED', retryAfterSec: result.retryAfterSec };
    }

    if (signature) {
      const canonicalRequest = `${normalizedTenantId}:${path}:${request.timestamp || ''}:${idempotencyKey || ''}`;
      const expectedSignature = crypto.createHmac('sha256', tenant.secret)
                                  .update(canonicalRequest)
                                  .digest('hex');

      if (signature !== expectedSignature) {
        return { status: 401, allowed: false, reason: 'INVALID_SIGNATURE' };
      }
    }

    const response = {
      status: 200,
      allowed: true,
      tenantId: normalizedTenantId,
      remainingTokens: result.remainingTokens
    };

    if (idempotencyKey) {
      this.idempotencyCache.set(idempotencyKey, { tenantId: normalizedTenantId, path, response });
    }

    return response;
  }
}
