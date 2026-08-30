import assert from "node:assert/strict";
import test from "node:test";

import { DeliveryError, ReliableDispatcher } from "../src/index.js";
import { FakeScheduler, flush } from "./fake-scheduler.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("delivers an event and validates public inputs", async () => {
  const scheduler = new FakeScheduler();
  const dispatcher = new ReliableDispatcher({
    scheduler,
    deliver: async (event, attempt) => `${event.id}:${attempt}`,
  });

  assert.equal(await dispatcher.submit({ id: "a", key: "account" }), "a:1");
  assert.throws(() => dispatcher.submit(null), /event/);
  assert.throws(() => dispatcher.submit({ id: "", key: "a" }), /event.id/);
  assert.throws(() => dispatcher.submit({ id: "a", key: "" }), /event.key/);
});

test("serializes two events sharing a key", async () => {
  const scheduler = new FakeScheduler();
  const firstGate = deferred();
  const started = [];
  const dispatcher = new ReliableDispatcher({
    scheduler,
    deliver: async (event) => {
      started.push(event.id);
      if (event.id === "first") await firstGate.promise;
      return event.id;
    },
  });

  const first = dispatcher.submit({ id: "first", key: "same" });
  const second = dispatcher.submit({ id: "second", key: "same" });
  await flush();
  assert.deepEqual(started, ["first"]);
  firstGate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(started, ["first", "second"]);
});

test("runs different keys up to maxConcurrent", async () => {
  const scheduler = new FakeScheduler();
  const gates = [deferred(), deferred()];
  const started = [];
  const dispatcher = new ReliableDispatcher({
    scheduler,
    maxConcurrent: 2,
    deliver: async (event) => {
      const index = started.length;
      started.push(event.id);
      await gates[index].promise;
      return event.id;
    },
  });

  const first = dispatcher.submit({ id: "a", key: "a" });
  const second = dispatcher.submit({ id: "b", key: "b" });
  await flush();
  assert.deepEqual(started, ["a", "b"]);
  gates[0].resolve();
  gates[1].resolve();
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
});

test("coalesces concurrent duplicate ids", async () => {
  const scheduler = new FakeScheduler();
  const gate = deferred();
  let calls = 0;
  const dispatcher = new ReliableDispatcher({
    scheduler,
    deliver: async () => {
      calls += 1;
      await gate.promise;
      return "shared";
    },
  });

  const first = dispatcher.submit({ id: "same", key: "a" });
  const second = dispatcher.submit({ id: "same", key: "a" });
  await flush();
  assert.equal(calls, 1);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["shared", "shared"]);
});

test("retries through the injected scheduler", async () => {
  const scheduler = new FakeScheduler();
  const attempts = [];
  const dispatcher = new ReliableDispatcher({
    scheduler,
    baseDelayMs: 7,
    deliver: async (_event, attempt) => {
      attempts.push(attempt);
      if (attempt === 1) {
        throw new DeliveryError("temporary", { retryable: true });
      }
      return "ok";
    },
  });

  const result = dispatcher.submit({ id: "retry", key: "a" });
  await flush();
  assert.deepEqual(attempts, [1]);
  assert.deepEqual(scheduler.delays, [7]);
  await scheduler.advanceBy(7);
  assert.equal(await result, "ok");
  assert.deepEqual(attempts, [1, 2]);
});
