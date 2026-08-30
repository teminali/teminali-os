import assert from "node:assert/strict";
import test from "node:test";

import { AsyncMemoCache } from "../src/async-memo-cache.js";

test("returns a fresh cached value", async () => {
  let now = 100;
  let loads = 0;
  const cache = new AsyncMemoCache({ maxEntries: 2, ttlMs: 50, clock: () => now });
  assert.equal(await cache.getOrLoad("a", async () => ++loads), 1);
  now = 149;
  assert.equal(await cache.getOrLoad("a", async () => ++loads), 1);
  assert.equal(loads, 1);
});

test("reloads an expired value", async () => {
  let now = 100;
  let loads = 0;
  const cache = new AsyncMemoCache({ maxEntries: 2, ttlMs: 50, clock: () => now });
  assert.equal(await cache.getOrLoad("a", async () => ++loads), 1);
  now = 150;
  assert.equal(await cache.getOrLoad("a", async () => ++loads), 2);
});

test("validates constructor and loader inputs", async () => {
  assert.throws(() => new AsyncMemoCache({ maxEntries: 0, ttlMs: 10 }), /maxEntries/);
  assert.throws(() => new AsyncMemoCache({ maxEntries: 1, ttlMs: 0 }), /ttlMs/);
  const cache = new AsyncMemoCache({ maxEntries: 1, ttlMs: 10 });
  await assert.rejects(cache.getOrLoad("a", null), /loader/);
});

test("evicts the least recently used resolved value", async () => {
  const cache = new AsyncMemoCache({ maxEntries: 2, ttlMs: 1000, clock: () => 0 });
  await cache.getOrLoad("a", async () => "a1");
  await cache.getOrLoad("b", async () => "b1");
  assert.equal(await cache.getOrLoad("a", async () => "a2"), "a1");
  await cache.getOrLoad("c", async () => "c1");
  assert.equal(await cache.getOrLoad("b", async () => "b2"), "b2");
});
