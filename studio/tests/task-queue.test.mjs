/**
 * A second instruction while the first is still running.
 *
 * `delegateTask` used to open by aborting whatever was in flight, so a second
 * Enter mid-turn killed the running turn with nothing said about it anywhere.
 * These are the rules that replaced that.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  QUEUE_LIMIT,
  describeQueue,
  describeRejection,
  dequeueTask,
  enqueueTask,
} from "../src/utils/taskQueue.ts";

const task = (prompt, id = prompt) => ({ id, prompt });

test("a prompt joins the queue and is trimmed", () => {
  const { queue, accepted, reason } = enqueueTask([], task("  run the tests  "));
  assert.equal(accepted, true);
  assert.equal(reason, null);
  assert.deepEqual(queue.map((entry) => entry.prompt), ["run the tests"]);
});

test("a blank prompt is turned away", () => {
  const { accepted, reason } = enqueueTask([], task("   "));
  assert.equal(accepted, false);
  assert.equal(reason, "empty");
});

test("the same prompt does not queue twice", () => {
  const first = enqueueTask([], task("run the tests")).queue;
  const second = enqueueTask(first, task("run the tests", "other-id"));
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(second.queue.length, 1, "and the queue is unchanged");
});

test("the queue has a floor it will not go past", () => {
  let queue = [];
  for (let index = 0; index < QUEUE_LIMIT; index += 1) queue = enqueueTask(queue, task(`task ${index}`)).queue;
  const over = enqueueTask(queue, task("one too many"));
  assert.equal(over.accepted, false);
  assert.equal(over.reason, "full");
  assert.equal(over.queue.length, QUEUE_LIMIT);
});

test("the queue drains in the order it was filled", () => {
  let queue = [];
  for (const prompt of ["first", "second", "third"]) queue = enqueueTask(queue, task(prompt)).queue;
  const one = dequeueTask(queue);
  assert.equal(one.next.prompt, "first");
  const two = dequeueTask(one.queue);
  assert.equal(two.next.prompt, "second");
  const three = dequeueTask(two.queue);
  assert.equal(three.next.prompt, "third");
  assert.equal(dequeueTask(three.queue).next, null);
});

test("the operator is told how many are waiting", () => {
  assert.equal(describeQueue(0), "");
  assert.equal(describeQueue(1), "Queued — 1 waiting");
  assert.equal(describeQueue(3), "Queued — 3 waiting");
});

test("and why one was turned away", () => {
  assert.equal(describeRejection("duplicate"), "Already queued");
  assert.match(describeRejection("full"), new RegExp(String(QUEUE_LIMIT)));
  assert.equal(describeRejection("empty"), "", "there is nothing to say about an empty box");
});
