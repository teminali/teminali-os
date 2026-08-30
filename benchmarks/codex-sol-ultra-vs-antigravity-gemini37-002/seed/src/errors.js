export class DeliveryError extends Error {
  constructor(message, { retryable = false, retryAfterMs } = {}) {
    super(message);
    this.name = "DeliveryError";
    this.retryable = retryable;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}
