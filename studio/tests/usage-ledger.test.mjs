import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendUsage, readUsage, summariseUsage, usageRecord } from "../server/usage-ledger.js";

const ledger = () => join(mkdtempSync(join(tmpdir(), "usage-")), "u.jsonl");
const daysAgo = (n, now = new Date()) => {
  const date = new Date(now);
  date.setDate(date.getDate() - n);
  return date;
};

const claudeTurn = (at, cost = 0.02) =>
  usageRecord({
    engine: "claude",
    model: "haiku",
    models: [
      { id: "claude-haiku-4-5", inputTokens: 900, outputTokens: 100, cacheReadTokens: 5000, cacheCreationTokens: 1000, costUsd: cost },
    ],
    usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 5000, cacheCreationTokens: 1000 },
    costUsd: cost,
    at,
  });

test("a turn's total counts every token it was billed for", () => {
  const record = claudeTurn(new Date());
  // 900 fresh + 100 out + 5,000 read from cache + 1,000 written to it.
  assert.equal(record.total, 7000);
});

test("per-model tokens sum back to the turn total", async () => {
  const path = ledger();
  await appendUsage(path, claudeTurn(new Date()));
  const summary = await summariseUsage(path, { days: 7 });
  const perModel = summary.models.reduce((total, model) => total + model.tokens, 0);
  // If these drift apart the dashboard shows a whole that its parts do not add
  // up to, which is the fastest way to lose trust in a usage panel.
  assert.equal(perModel, summary.totals.tokens);
});

test("the window excludes anything older than it", async () => {
  const path = ledger();
  const now = new Date();
  await appendUsage(path, claudeTurn(daysAgo(0, now)));
  await appendUsage(path, claudeTurn(daysAgo(9, now)));
  const summary = await summariseUsage(path, { days: 7, now });
  assert.equal(summary.totals.turns, 1, "a 9-day-old turn is not in a 7-day window");
});

test("every day in the window is present, including the empty ones", async () => {
  const path = ledger();
  const now = new Date();
  await appendUsage(path, claudeTurn(daysAgo(2, now)));
  const summary = await summariseUsage(path, { days: 7, now });
  assert.equal(summary.daily.length, 7);
  assert.equal(summary.daily.filter((day) => day.turns > 0).length, 1);
  // Chronological, oldest first, so the chart's axis reads left to right.
  const sorted = [...summary.daily].map((d) => d.day).sort();
  assert.deepEqual(summary.daily.map((d) => d.day), sorted);
});

test("an unreported cost is never averaged in as zero", async () => {
  const path = ledger();
  const now = new Date();
  await appendUsage(
    path,
    usageRecord({
      engine: "codex",
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, cacheCreationTokens: 0 },
      costUsd: null,
      at: now,
    }),
  );
  const summary = await summariseUsage(path, { days: 7, now });
  assert.equal(summary.totals.tokens, 190, "tokens are known even when cost is not");
  assert.equal(summary.totals.costUsd, 0);
  assert.equal(summary.totals.costReported, false, "the panel must be able to say the cost is unknown");
  assert.equal(summary.models[0].costReported, false);
});

test("the two averages answer different questions", async () => {
  const path = ledger();
  const now = new Date();
  // One busy day inside an otherwise idle week.
  await appendUsage(path, claudeTurn(daysAgo(1, now)));
  const summary = await summariseUsage(path, { days: 7, now });

  assert.equal(summary.average.activeDays, 1);
  assert.equal(summary.average.perDay.tokens, 7000 / 7);
  assert.equal(summary.average.perActiveDay.tokens, 7000);
  assert.ok(
    summary.average.perActiveDay.tokens > summary.average.perDay.tokens,
    "spreading one busy day across seven understates the day you actually worked",
  );
});

test("a turn with no per-model breakdown still lands in the per-model view", async () => {
  const path = ledger();
  const now = new Date();
  await appendUsage(
    path,
    usageRecord({
      engine: "frontier",
      model: "llama3.2:3b",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0,
      at: now,
    }),
  );
  const summary = await summariseUsage(path, { days: 7, now });
  assert.equal(summary.models.length, 1);
  assert.equal(summary.models[0].id, "llama3.2:3b");
  assert.equal(summary.models[0].tokens, 15);
});

test("models are ranked by usage so the biggest spender is first", async () => {
  const path = ledger();
  const now = new Date();
  await appendUsage(path, claudeTurn(now));
  await appendUsage(
    path,
    usageRecord({
      engine: "frontier",
      model: "small",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0,
      at: now,
    }),
  );
  const summary = await summariseUsage(path, { days: 7, now });
  assert.equal(summary.models[0].id, "claude-haiku-4-5");
  assert.ok(summary.models[0].tokens > summary.models[1].tokens);
});

test("one corrupt line does not discard the rest of the ledger", async () => {
  const path = ledger();
  await appendUsage(path, claudeTurn(new Date()));
  writeFileSync(path, `${JSON.stringify(claudeTurn(new Date()))}\nnot json at all\n`, { flag: "a" });
  const records = await readUsage(path);
  assert.equal(records.length, 2);
});

test("an empty or missing ledger reads as no usage rather than an error", async () => {
  const summary = await summariseUsage(join(tmpdir(), "definitely-absent-ledger.jsonl"), { days: 7 });
  assert.equal(summary.totals.turns, 0);
  assert.equal(summary.daily.length, 7);
  assert.equal(summary.models.length, 0);
  assert.equal(summary.average.perDay.tokens, 0);
});
