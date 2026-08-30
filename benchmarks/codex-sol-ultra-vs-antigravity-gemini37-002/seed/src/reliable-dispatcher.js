import { IdempotencyRegistry } from "./idempotency-registry.js";
import { KeyedQueue } from "./keyed-queue.js";

export class ReliableDispatcher {
  #deliver;
  #scheduler;
  #maxConcurrent;
  #maxAttempts;
  #baseDelayMs;
  #active = 0;
  #waiters = [];
  #registry = new IdempotencyRegistry();
  #queue = new KeyedQueue();

  constructor({
    deliver,
    scheduler,
    maxConcurrent = 2,
    maxAttempts = 3,
    baseDelayMs = 10,
  }) {
    if (typeof deliver !== "function") {
      throw new TypeError("deliver must be a function");
    }
    if (!scheduler || typeof scheduler.sleep !== "function") {
      throw new TypeError("scheduler must provide sleep");
    }
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new TypeError("maxConcurrent must be a positive integer");
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new TypeError("maxAttempts must be a positive integer");
    }
    if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
      throw new TypeError("baseDelayMs must be non-negative");
    }
    this.#deliver = deliver;
    this.#scheduler = scheduler;
    this.#maxConcurrent = maxConcurrent;
    this.#maxAttempts = maxAttempts;
    this.#baseDelayMs = baseDelayMs;
  }

  submit(event) {
    if (!event || typeof event !== "object") {
      throw new TypeError("event must be an object");
    }
    if (typeof event.id !== "string" || event.id.length === 0) {
      throw new TypeError("event.id must be a non-empty string");
    }
    if (typeof event.key !== "string" || event.key.length === 0) {
      throw new TypeError("event.key must be a non-empty string");
    }

    return this.#registry.run(event.id, () =>
      this.#queue.enqueue(event.key, () => this.#run(event)),
    );
  }

  async #run(event) {
    // Defect: one delivery slot remains occupied during retry backoff.
    await this.#acquire();
    try {
      for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
        try {
          return await this.#deliver(event, attempt);
        } catch (error) {
          if (error?.retryable !== true || attempt === this.#maxAttempts) {
            throw error;
          }
          // Defect: an explicit zero retry delay is ignored.
          const delay = error.retryAfterMs || this.#baseDelayMs * 2 ** (attempt - 1);
          await this.#scheduler.sleep(delay);
        }
      }
    } finally {
      this.#release();
    }
  }

  #acquire() {
    return new Promise((resolve) => {
      if (this.#active < this.#maxConcurrent) {
        this.#active += 1;
        resolve();
      } else {
        this.#waiters.push(resolve);
      }
    });
  }

  #release() {
    this.#active -= 1;
    const next = this.#waiters.shift();
    if (next) {
      this.#active += 1;
      next();
    }
  }
}
