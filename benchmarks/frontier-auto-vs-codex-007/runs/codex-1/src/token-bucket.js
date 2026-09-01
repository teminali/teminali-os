export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export class TokenBucket {
  constructor(capacity, refillRatePerSec) {
    this.capacity = capacity;
    this.refillRatePerSec = refillRatePerSec;
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  consume(tokens = 1, timestampMs = Date.now()) {
    // Seed stub: lacks time-based refill math and strict validation
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return { allowed: true, remainingTokens: this.tokens, retryAfterSec: 0 };
    }
    return { allowed: false, remainingTokens: this.tokens, retryAfterSec: 1 };
  }
}
