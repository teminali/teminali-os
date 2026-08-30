import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const target = process.argv[2];
if (!target) throw new Error("target directory is required");
const moduleUrl = `${pathToFileURL(path.join(target, "src/async-memo-cache.js"))}?score=${Date.now()}`;
const { AsyncMemoCache } = await import(moduleUrl);

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, passed: true, points: 10 });
  } catch (error) {
    checks.push({ name, passed: false, points: 0, error: error.message });
  }
}

await check("concurrent request coalescing", async () => {
  let resolve;
  let loads = 0;
  const pending = new Promise((done) => { resolve = done; });
  const cache = new AsyncMemoCache({ maxEntries: 2, ttlMs: 100, clock: () => 0 });
  const loader = async () => { loads += 1; return pending; };
  const first = cache.getOrLoad("same", loader);
  const second = cache.getOrLoad("same", loader);
  await Promise.resolve();
  assert.equal(loads, 1);
  resolve("shared");
  assert.deepEqual(await Promise.all([first, second]), ["shared", "shared"]);
});

await check("failed-load recovery", async () => {
  let loads = 0;
  const cache = new AsyncMemoCache({ maxEntries: 2, ttlMs: 100, clock: () => 0 });
  await assert.rejects(cache.getOrLoad("x", async () => { loads += 1; throw new Error("boom"); }));
  assert.equal(await cache.getOrLoad("x", async () => { loads += 1; return "ok"; }), "ok");
  assert.equal(loads, 2);
});

await check("TTL begins on resolution", async () => {
  let now = 0;
  let resolve;
  const cache = new AsyncMemoCache({ maxEntries: 2, ttlMs: 50, clock: () => now });
  const first = cache.getOrLoad("x", () => new Promise((done) => { resolve = done; }));
  now = 100;
  resolve("first");
  assert.equal(await first, "first");
  now = 149;
  assert.equal(await cache.getOrLoad("x", async () => "second"), "first");
});

await check("LRU refresh and eviction", async () => {
  const cache = new AsyncMemoCache({ maxEntries: 2, ttlMs: 1000, clock: () => 0 });
  await cache.getOrLoad("a", async () => "a1");
  await cache.getOrLoad("b", async () => "b1");
  await cache.getOrLoad("a", async () => "a2");
  await cache.getOrLoad("c", async () => "c1");
  assert.equal(await cache.getOrLoad("a", async () => "a2"), "a1");
  assert.equal(await cache.getOrLoad("b", async () => "b2"), "b2");
});

await check("in-flight capacity behavior", async () => {
  let resolveA;
  let resolveB;
  const cache = new AsyncMemoCache({ maxEntries: 1, ttlMs: 1000, clock: () => 0 });
  const a = cache.getOrLoad("a", () => new Promise((done) => { resolveA = done; }));
  const b = cache.getOrLoad("b", () => new Promise((done) => { resolveB = done; }));
  const aAgain = cache.getOrLoad("a", async () => "wrong");
  resolveA("a1");
  assert.deepEqual(await Promise.all([a, aAgain]), ["a1", "a1"]);
  resolveB("b1");
  assert.equal(await b, "b1");
  assert.equal(await cache.getOrLoad("b", async () => "b2"), "b1");
});

await check("expiration behavior", async () => {
  let now = 0;
  const cache = new AsyncMemoCache({ maxEntries: 2, ttlMs: 10, clock: () => now });
  await cache.getOrLoad("old", async () => "old1");
  now = 11;
  await cache.getOrLoad("fresh", async () => "fresh1");
  await cache.getOrLoad("new", async () => "new1");
  assert.equal(await cache.getOrLoad("fresh", async () => "fresh2"), "fresh1");
  assert.equal(await cache.getOrLoad("old", async () => "old2"), "old2");
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
const benchmarkRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const integrityFiles = ["package.json", "test/async-memo-cache.test.js"];
let integrity = true;
for (const file of integrityFiles) {
  const expected = await readFile(path.join(benchmarkRoot, "seed", file));
  const actual = await readFile(path.join(target, file));
  if (digest(expected) !== digest(actual)) integrity = false;
}

process.stdout.write(JSON.stringify({ checks, integrity }, null, 2));
