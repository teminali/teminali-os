export class AsyncMemoCache {
  #entries = new Map();
  #maxEntries;
  #ttlMs;
  #clock;

  constructor({ maxEntries, ttlMs, clock = Date.now }) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError("maxEntries must be a positive integer");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError("ttlMs must be positive");
    }
    if (typeof clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
    this.#clock = clock;
  }

  async getOrLoad(key, loader) {
    if (typeof loader !== "function") {
      throw new TypeError("loader must be a function");
    }

    const startedAt = this.#clock();
    const existing = this.#entries.get(key);
    if (existing && existing.expiresAt > startedAt) {
      return existing.value;
    }

    const value = await loader();
    this.#entries.set(key, {
      value,
      expiresAt: startedAt + this.#ttlMs,
    });

    if (this.#entries.size > this.#maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      this.#entries.delete(oldestKey);
    }
    return value;
  }
}
