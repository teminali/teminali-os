export class IdempotencyRegistry {
  #records = new Map();

  run(id, operation) {
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }

    const existing = this.#records.get(id);
    if (existing) return existing;

    const promise = Promise.resolve().then(operation);
    this.#records.set(id, promise);

    // Defect: fulfilled results should remain available for replay.
    promise.then(
      () => this.#records.delete(id),
      () => this.#records.delete(id),
    );
    return promise;
  }
}
