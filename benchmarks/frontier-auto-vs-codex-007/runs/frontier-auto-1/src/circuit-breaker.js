import { ValidationError } from './token-bucket.js';

export class CircuitBreaker {
  constructor({ failureThreshold = 5, recoveryTimeoutMs = 10000, halfOpenSuccessThreshold = 2 } = {}) {
    if (typeof failureThreshold !== 'number' || failureThreshold <= 0 || !isFinite(failureThreshold)) {
      throw new ValidationError('Failure threshold must be a positive finite number');
    }
    if (typeof recoveryTimeoutMs !== 'number' || recoveryTimeoutMs < 0 || !isFinite(recoveryTimeoutMs)) {
      throw new ValidationError('Recovery timeout in milliseconds must be a non-negative finite number');
    }
    if (typeof halfOpenSuccessThreshold !== 'number' || halfOpenSuccessThreshold <= 0 || !isFinite(halfOpenSuccessThreshold)) {
      throw new ValidationError('Half-open success threshold must be a positive finite number');
    }

    this.failureThreshold = failureThreshold;
    this.recoveryTimeoutMs = recoveryTimeoutMs;
    this.halfOpenSuccessThreshold = halfOpenSuccessThreshold;
    this.state = "CLOSED";
    this.failureCount = 0;
  }

  recordFailure(timestampMs = Date.now()) {
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
    } else {
      this.failureCount++;
      if (this.state === 'CLOSED' && this.failureCount >= this.failureThreshold) {
        this.lastFailureTsMs = timestampMs;
        this.state = 'OPEN';
      }
    }
  }

  recordSuccess() {
    if (this.state === 'HALF_OPEN') {
      let successCount = this.successCount || 0;
      successCount++;
      this.successCount = successCount;
      if (successCount >= this.halfOpenSuccessThreshold) {
        this.state = 'CLOSED';
        delete this.successCount;
      }
    } else {
      this.failureCount = 0;
    }
  }

  canExecute(timestampMs = Date.now()) {
    const elapsedTimeSec = (timestampMs - this.lastFailureTsMs) / 1000;
    if (this.state === 'CLOSED') {
      return true;
    } else if (this.state === 'OPEN' && (elapsedTimeSec > this.recoveryTimeoutMs / 1000)) {
      this.state = 'HALF_OPEN';
      delete this.successCount;
      return true;
    }

    return false;
  }

  getState() {
    return this.state;
  }
}