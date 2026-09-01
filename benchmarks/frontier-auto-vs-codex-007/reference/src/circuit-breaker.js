import { ValidationError } from "./token-bucket.js";

export class CircuitBreaker {
  constructor({
    failureThreshold = 5,
    recoveryTimeoutMs = 10000,
    halfOpenSuccessThreshold = 2,
  } = {}) {
    if (typeof failureThreshold !== "number" || failureThreshold <= 0) {
      throw new ValidationError("failureThreshold must be a positive number.");
    }
    if (typeof recoveryTimeoutMs !== "number" || recoveryTimeoutMs <= 0) {
      throw new ValidationError("recoveryTimeoutMs must be a positive number.");
    }
    if (typeof halfOpenSuccessThreshold !== "number" || halfOpenSuccessThreshold <= 0) {
      throw new ValidationError("halfOpenSuccessThreshold must be a positive number.");
    }

    this.failureThreshold = failureThreshold;
    this.recoveryTimeoutMs = recoveryTimeoutMs;
    this.halfOpenSuccessThreshold = halfOpenSuccessThreshold;

    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAtMs = null;
  }

  canExecute(timestampMs = Date.now()) {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (this.openedAtMs && timestampMs - this.openedAtMs >= this.recoveryTimeoutMs) {
        this.state = "HALF_OPEN";
        this.consecutiveSuccesses = 0;
        return true;
      }
      return false;
    }
    if (this.state === "HALF_OPEN") {
      return true;
    }
    return false;
  }

  recordSuccess() {
    if (this.state === "HALF_OPEN") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.halfOpenSuccessThreshold) {
        this.state = "CLOSED";
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
        this.openedAtMs = null;
      }
    } else if (this.state === "CLOSED") {
      this.consecutiveFailures = 0;
    }
  }

  recordFailure(timestampMs = Date.now()) {
    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.openedAtMs = timestampMs;
      this.consecutiveSuccesses = 0;
    } else if (this.state === "CLOSED") {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.state = "OPEN";
        this.openedAtMs = timestampMs;
      }
    }
  }

  getState() {
    return this.state;
  }
}
