export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export class TokenBucket {
  constructor(capacity, refillRatePerSec) {
    if (typeof capacity !== 'number' || capacity <= 0 || !isFinite(capacity)) {
      throw new ValidationError('Capacity must be a positive finite number');
    }
    if (typeof refillRatePerSec !== 'number' || refillRatePerSec < 0 || !isFinite(refillRatePerSec)) {
      throw new ValidationError('Refill rate per second must be a non-negative finite number');
    }

    this.capacity = capacity;
    this.refillRatePerSec = refillRatePerSec;
    this.tokens = capacity;
    this.lastRefillMs = null;
  }

  consume(tokens = 1, timestampMs = Date.now()) {
    const elapsedTimeSec = (timestampMs - this.lastRefillMs) / 1000;
    const tokensToAdd = elapsedTimeSec * this.refillRatePerSec;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillMs = timestampMs;

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return { allowed: true, remainingTokens: this.tokens, retryAfterSec: 0 };
    } else {
      const retryAfterSec = (tokens - this.tokens) / this.refillRatePerSec;
      return { allowed: false, remainingTokens: this.tokens, retryAfterSec: Math.max(0, retryAfterSec.toFixed(3)) };
    }
  }
}