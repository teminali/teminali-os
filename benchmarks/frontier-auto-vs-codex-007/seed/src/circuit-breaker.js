import { ValidationError } from "./token-bucket.js";

export class CircuitBreaker {
  constructor({ failureThreshold = 5, recoveryTimeoutMs = 10000, halfOpenSuccessThreshold = 2 } = {}) {
    this.failureThreshold = failureThreshold;
    this.recoveryTimeoutMs = recoveryTimeoutMs;
    this.halfOpenSuccessThreshold = halfOpenSuccessThreshold;
    this.state = "CLOSED";
    this.failureCount = 0;
  }

  recordSuccess() {
    this.failureCount = 0;
  }

  recordFailure() {
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
    }
  }

  canExecute(timestampMs = Date.now()) {
    // Seed stub: does not transition from OPEN to HALF_OPEN after timeout
    return this.state !== "OPEN";
  }

  getState() {
    return this.state;
  }
}
