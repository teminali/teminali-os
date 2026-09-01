export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export class TokenBucket {
  constructor(capacity, refillRatePerSec) {
    if (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity <= 0) {
      throw new ValidationError("Capacity must be a positive finite number.");
    }
    if (typeof refillRatePerSec !== "number" || !Number.isFinite(refillRatePerSec) || refillRatePerSec < 0) {
      throw new ValidationError("Refill rate must be a non-negative finite number.");
    }
    this.capacity = capacity;
    this.refillRatePerSec = refillRatePerSec;
    this.tokens = capacity;
    this.lastRefillMs = null;
  }

  refill(timestampMs = Date.now()) {
    if (this.lastRefillMs === null) {
      this.lastRefillMs = timestampMs;
      return;
    }
    if (timestampMs > this.lastRefillMs) {
      const elapsedSec = (timestampMs - this.lastRefillMs) / 1000;
      const addedTokens = elapsedSec * this.refillRatePerSec;
      this.tokens = Math.min(this.capacity, this.tokens + addedTokens);
      this.lastRefillMs = timestampMs;
    }
  }

  consume(tokens = 1, timestampMs = Date.now()) {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) {
      throw new ValidationError("Requested tokens must be a positive finite number.");
    }
    this.refill(timestampMs);
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return {
        allowed: true,
        remainingTokens: Number(this.tokens.toFixed(4)),
        retryAfterSec: 0,
      };
    }
    const needed = tokens - this.tokens;
    const retryAfterSec = this.refillRatePerSec > 0
      ? Math.ceil((needed / this.refillRatePerSec) * 100) / 100
      : Infinity;
    return {
      allowed: false,
      remainingTokens: Number(this.tokens.toFixed(4)),
      retryAfterSec,
    };
  }
}
