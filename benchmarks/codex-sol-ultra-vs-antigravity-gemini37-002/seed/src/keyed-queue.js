export class KeyedQueue {
  #tails = new Map();

  enqueue(key, operation) {
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }

    const previous = this.#tails.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.#tails.set(key, current);

    // Defect: an older completion can delete a newer tail for the same key.
    current.then(
      () => this.#tails.delete(key),
      () => this.#tails.delete(key),
    );
    return current;
  }
}
