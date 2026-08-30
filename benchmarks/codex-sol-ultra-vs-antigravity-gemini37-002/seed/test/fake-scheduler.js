export class FakeScheduler {
  #now = 0;
  #nextId = 1;
  #tasks = [];

  delays = [];

  get now() {
    return this.#now;
  }

  get pendingCount() {
    return this.#tasks.length;
  }

  sleep(delayMs) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new TypeError("delayMs must be non-negative");
    }
    this.delays.push(delayMs);
    const task = {
      id: this.#nextId,
      due: this.#now + delayMs,
    };
    this.#nextId += 1;
    const promise = new Promise((resolve) => {
      task.resolve = resolve;
    });
    this.#tasks.push(task);
    return promise;
  }

  async advanceBy(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new TypeError("ms must be non-negative");
    }
    const target = this.#now + ms;
    while (true) {
      this.#tasks.sort((left, right) => left.due - right.due || left.id - right.id);
      const next = this.#tasks[0];
      if (!next || next.due > target) break;
      this.#tasks.shift();
      this.#now = next.due;
      next.resolve();
      await flush();
    }
    this.#now = target;
    await flush();
  }

  async runNext() {
    this.#tasks.sort((left, right) => left.due - right.due || left.id - right.id);
    const next = this.#tasks[0];
    if (!next) throw new Error("no scheduled task");
    await this.advanceBy(next.due - this.#now);
  }
}

export async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}
