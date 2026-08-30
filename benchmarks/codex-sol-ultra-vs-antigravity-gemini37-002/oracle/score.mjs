import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) throw new Error("target directory is required");

const nonce = `${Date.now()}-${Math.random()}`;
const moduleUrl = `${pathToFileURL(path.join(path.resolve(target), "src/index.js"))}?oracle=${nonce}`;
const {
  DeliveryError,
  KeyedQueue,
  ReliableDispatcher,
} = await import(moduleUrl);
const schedulerUrl = `${pathToFileURL(path.join(path.resolve(target), "test/fake-scheduler.js"))}?oracle=${nonce}`;
const { FakeScheduler, flush } = await import(schedulerUrl);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function withinLimit(operation, limitMs = 1500) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("hidden check timed out")), limitMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

const checks = [];
async function check(name, operation) {
  try {
    await withinLimit(operation);
    checks.push({ name, passed: true, points: 10 });
  } catch (error) {
    checks.push({
      name,
      passed: false,
      points: 0,
      error: error?.message ?? String(error),
    });
  }
}

await check("duplicate coalescing and fulfilled-result replay", async () => {
  const scheduler = new FakeScheduler();
  const attempts = [];
  const dispatcher = new ReliableDispatcher({
    scheduler,
    baseDelayMs: 4,
    deliver: async (_event, attempt) => {
      attempts.push(attempt);
      if (attempt === 1) {
        throw new DeliveryError("again", { retryable: true });
      }
      return "done";
    },
  });

  const first = dispatcher.submit({ id: "same", key: "one" });
  await flush();
  const duplicate = dispatcher.submit({ id: "same", key: "another" });
  assert.equal(scheduler.pendingCount, 1);
  await scheduler.advanceBy(4);
  assert.deepEqual(await Promise.all([first, duplicate]), ["done", "done"]);
  const replay = dispatcher.submit({ id: "same", key: "third" });
  await flush();
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(await replay, "done");
  assert.equal(scheduler.pendingCount, 0);
});

await check("terminal failure cleanup and later retry", async () => {
  const scheduler = new FakeScheduler();
  const terminal = new Error("terminal");
  let calls = 0;
  const dispatcher = new ReliableDispatcher({
    scheduler,
    deliver: async () => {
      calls += 1;
      if (calls === 1) throw terminal;
      return "recovered";
    },
  });

  const first = dispatcher.submit({ id: "recover", key: "a" });
  const duplicate = dispatcher.submit({ id: "recover", key: "a" });
  await assert.rejects(first, (error) => error === terminal);
  await assert.rejects(duplicate, (error) => error === terminal);
  assert.equal(
    await dispatcher.submit({ id: "recover", key: "a" }),
    "recovered",
  );
  assert.equal(calls, 2);
  assert.equal(scheduler.pendingCount, 0);
});

await check("same-key FIFO under settlement races", async () => {
  const queue = new KeyedQueue();
  const firstGate = deferred();
  const secondGate = deferred();
  const order = [];

  const first = queue.enqueue("key", async () => {
    order.push("first:start");
    await firstGate.promise;
    order.push("first:end");
    return "first";
  });
  const second = queue.enqueue("key", async () => {
    order.push("second:start");
    await secondGate.promise;
    order.push("second:end");
    return "second";
  });

  await flush();
  assert.deepEqual(order, ["first:start"]);
  firstGate.resolve();
  assert.equal(await first, "first");
  await flush();
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);

  const third = queue.enqueue("key", async () => {
    order.push("third:start");
    return "third";
  });
  await flush();
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
  secondGate.resolve();
  assert.deepEqual(await Promise.all([second, third]), ["second", "third"]);
  assert.deepEqual(order, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
    "third:start",
  ]);
});

await check("retrying head preserves per-key order", async () => {
  const scheduler = new FakeScheduler();
  const calls = [];
  const dispatcher = new ReliableDispatcher({
    scheduler,
    maxConcurrent: 2,
    baseDelayMs: 3,
    deliver: async (event, attempt) => {
      calls.push(`${event.id}:${attempt}`);
      if (event.id === "first" && attempt === 1) {
        throw new DeliveryError("retry", { retryable: true });
      }
      return event.id;
    },
  });

  const first = dispatcher.submit({ id: "first", key: "same" });
  const second = dispatcher.submit({ id: "second", key: "same" });
  await flush();
  assert.deepEqual(calls, ["first:1"]);
  await scheduler.advanceBy(3);
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(calls, ["first:1", "first:2", "second:1"]);
});

await check("cross-key work conservation during retry backoff", async () => {
  const scheduler = new FakeScheduler();
  const calls = [];
  const dispatcher = new ReliableDispatcher({
    scheduler,
    maxConcurrent: 1,
    baseDelayMs: 10,
    deliver: async (event, attempt) => {
      calls.push(`${event.id}:${attempt}`);
      if (event.id === "blocked" && attempt === 1) {
        throw new DeliveryError("later", { retryable: true });
      }
      return event.id;
    },
  });

  const blocked = dispatcher.submit({ id: "blocked", key: "a" });
  await flush();
  const ready = dispatcher.submit({ id: "ready", key: "b" });
  await flush();
  assert.deepEqual(calls, ["blocked:1", "ready:1"]);
  assert.equal(await ready, "ready");
  await scheduler.advanceBy(10);
  assert.equal(await blocked, "blocked");
});

await check("global active-delivery concurrency bound", async () => {
  const scheduler = new FakeScheduler();
  const gates = [];
  let active = 0;
  let peak = 0;
  const dispatcher = new ReliableDispatcher({
    scheduler,
    maxConcurrent: 2,
    deliver: async (event) => {
      active += 1;
      peak = Math.max(peak, active);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      active -= 1;
      return event.id;
    },
  });

  const results = ["a", "b", "c", "d"].map((id) =>
    dispatcher.submit({ id, key: id }),
  );
  await flush();
  assert.equal(gates.length, 2);
  assert.equal(active, 2);
  gates[0].resolve();
  gates[1].resolve();
  await flush();
  assert.equal(gates.length, 4);
  assert.equal(active, 2);
  gates[2].resolve();
  gates[3].resolve();
  assert.deepEqual(await Promise.all(results), ["a", "b", "c", "d"]);
  assert.equal(peak, 2);
});

await check("attempt numbering retry delay and exhaustion", async () => {
  const zeroScheduler = new FakeScheduler();
  const zeroAttempts = [];
  const zeroDispatcher = new ReliableDispatcher({
    scheduler: zeroScheduler,
    baseDelayMs: 9,
    deliver: async (_event, attempt) => {
      zeroAttempts.push(attempt);
      if (attempt === 1) {
        throw new DeliveryError("immediate", {
          retryable: true,
          retryAfterMs: 0,
        });
      }
      return "zero-ok";
    },
  });
  const zeroResult = zeroDispatcher.submit({ id: "zero", key: "zero" });
  await flush();
  assert.deepEqual(zeroScheduler.delays, [0]);
  await zeroScheduler.advanceBy(0);
  assert.equal(await zeroResult, "zero-ok");
  assert.deepEqual(zeroAttempts, [1, 2]);

  const backoffScheduler = new FakeScheduler();
  const backoffAttempts = [];
  const backoffDispatcher = new ReliableDispatcher({
    scheduler: backoffScheduler,
    maxAttempts: 3,
    baseDelayMs: 5,
    deliver: async (_event, attempt) => {
      backoffAttempts.push([attempt, backoffScheduler.now]);
      if (attempt < 3) {
        throw new DeliveryError(`retry-${attempt}`, { retryable: true });
      }
      return "backoff-ok";
    },
  });
  const backoffResult = backoffDispatcher.submit({ id: "backoff", key: "b" });
  await flush();
  assert.deepEqual(backoffScheduler.delays, [5]);
  await backoffScheduler.advanceBy(5);
  assert.deepEqual(backoffScheduler.delays, [5, 10]);
  await backoffScheduler.advanceBy(10);
  assert.equal(await backoffResult, "backoff-ok");
  assert.deepEqual(backoffAttempts, [[1, 0], [2, 5], [3, 15]]);

  const exhaustedScheduler = new FakeScheduler();
  const finalError = new DeliveryError("final", { retryable: true });
  let exhaustedCalls = 0;
  const exhaustedDispatcher = new ReliableDispatcher({
    scheduler: exhaustedScheduler,
    maxAttempts: 2,
    baseDelayMs: 2,
    deliver: async (_event, attempt) => {
      exhaustedCalls += 1;
      if (attempt === 2) throw finalError;
      throw new DeliveryError("first", { retryable: true });
    },
  });
  const exhausted = exhaustedDispatcher.submit({ id: "exhausted", key: "e" });
  await flush();
  await exhaustedScheduler.advanceBy(2);
  await assert.rejects(exhausted, (error) => error === finalError);
  assert.equal(exhaustedCalls, 2);
  assert.equal(exhaustedScheduler.pendingCount, 0);
});

await check("no stale scheduled retry after terminal completion", async () => {
  const scheduler = new FakeScheduler();
  let calls = 0;
  const dispatcher = new ReliableDispatcher({
    scheduler,
    maxAttempts: 2,
    baseDelayMs: 1,
    deliver: async (_event, attempt) => {
      calls += 1;
      if (attempt === 1) {
        throw new DeliveryError("once", { retryable: true });
      }
      return "ok";
    },
  });
  const result = dispatcher.submit({ id: "clean", key: "clean" });
  await flush();
  await scheduler.advanceBy(1);
  assert.equal(await result, "ok");
  assert.equal(calls, 2);
  assert.equal(scheduler.pendingCount, 0);
  await scheduler.advanceBy(1000);
  assert.equal(calls, 2);

  const terminalScheduler = new FakeScheduler();
  const terminalDispatcher = new ReliableDispatcher({
    scheduler: terminalScheduler,
    deliver: async () => {
      throw new DeliveryError("stop", { retryable: false });
    },
  });
  await assert.rejects(
    terminalDispatcher.submit({ id: "stop", key: "stop" }),
    /stop/,
  );
  assert.equal(terminalScheduler.pendingCount, 0);
});

process.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`);
