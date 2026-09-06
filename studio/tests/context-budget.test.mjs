import assert from "node:assert/strict";
import test from "node:test";

import {
  DENSE_CHARS_PER_TOKEN,
  PROSE_CHARS_PER_TOKEN,
  SHARES,
  assemblePrompt,
  budgetFor,
  fitHistory,
} from "../src/services/contextBudget.ts";

/* ── The budget is a share of the real window ─────────────────────────────── */

test("every limit scales with the window it was derived from", () => {
  const small = budgetFor("frontier", 8_192);
  const large = budgetFor("frontier", 32_768);
  assert.equal(small.windowTokens, 8_192);
  assert.equal(large.windowTokens, 32_768);
  for (const key of ["systemPromptChars", "historyChars", "messageChars", "toolResultChars"]) {
    // Each limit is floored on its own, so allow the rounding.
    assert.ok(Math.abs(large[key] - small[key] * 4) <= 4, `${key} must be four times larger in a window four times larger`);
  }
});

test("the shares leave the model room to answer in", () => {
  const spent = SHARES.systemPrompt + SHARES.history + SHARES.toolResult;
  assert.ok(spent < 0.75, `prompt shares spend ${spent} of the window; the answer needs the rest`);
});

test("a tool result is budgeted at the dense rate, prose at the measured one", () => {
  const budget = budgetFor("frontier", 8_192);
  assert.equal(budget.systemPromptChars, Math.floor(8_192 * SHARES.systemPrompt * PROSE_CHARS_PER_TOKEN));
  assert.equal(budget.toolResultChars, Math.floor(8_192 * SHARES.toolResult * DENSE_CHARS_PER_TOKEN));
  assert.ok(DENSE_CHARS_PER_TOKEN < PROSE_CHARS_PER_TOKEN);
});

test("an unknown local window is budgeted as the tightest shipped one, never the roomiest", () => {
  assert.equal(budgetFor("frontier").windowTokens, 8_192);
  assert.equal(budgetFor("frontier", null).windowTokens, 8_192);
  assert.equal(budgetFor("frontier", Number.NaN).windowTokens, 8_192);
  assert.equal(budgetFor("frontier", -1).windowTokens, 8_192);
});

/* ── The CLI lanes share the mechanism and are never truncated by it ──────── */

test("the CLI lanes are not governed: their ceilings never bind", () => {
  const local = budgetFor("frontier", 32_768);
  for (const engine of ["claude", "codex"]) {
    const cli = budgetFor(engine);
    assert.equal(cli.governed, false, `${engine} compacts its own context`);
    // Higher than the largest local window's limits by a wide margin, so a
    // tool result or history the local lane would keep whole is never cut here.
    assert.ok(cli.toolResultChars > local.toolResultChars * 4, `${engine} tool-result ceiling`);
    assert.ok(cli.historyChars > local.historyChars * 4, `${engine} history ceiling`);
    assert.ok(cli.systemPromptChars > local.systemPromptChars * 4, `${engine} prompt ceiling`);
  }
  assert.equal(local.governed, true);
});

/* ── Prompt assembly under a budget ───────────────────────────────────────── */

const sections = [
  { name: "base", required: true, text: "A".repeat(100) },
  { name: "tools", text: "B".repeat(100) },
  { name: "style", text: "C".repeat(100) },
];

test("sections are kept in priority order until the budget is spent", () => {
  const result = assemblePrompt(sections, 210, "\n\n");
  assert.deepEqual(result.dropped, ["style"]);
  assert.equal(result.text, `${"A".repeat(100)}\n\n${"B".repeat(100)}`);
  assert.equal(result.chars, 202);
  assert.equal(result.overBudget, false);
});

test("a section that does not fit is dropped whole, never cut mid-sentence", () => {
  const result = assemblePrompt(sections, 150, "\n\n");
  assert.deepEqual(result.dropped, ["tools", "style"]);
  assert.equal(result.text, "A".repeat(100));
});

test("a later, smaller section can still fit after a larger one was dropped", () => {
  const mixed = [
    { name: "base", required: true, text: "A".repeat(100) },
    { name: "big", text: "B".repeat(500) },
    { name: "small", text: "C".repeat(50) },
  ];
  const result = assemblePrompt(mixed, 200, "\n\n");
  assert.deepEqual(result.dropped, ["big"]);
  assert.match(result.text, /C{50}$/);
});

test("a required section is kept past the budget, and the result says so", () => {
  const result = assemblePrompt(sections, 50, "\n\n");
  assert.equal(result.overBudget, true);
  assert.equal(result.text, "A".repeat(100));
  assert.deepEqual(result.dropped, ["tools", "style"]);
});

test("empty sections cost nothing and are not reported as dropped", () => {
  const result = assemblePrompt([{ name: "base", required: true, text: "x" }, { name: "player", text: "" }], 10);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.text, "x");
});

/* ── History fitting ──────────────────────────────────────────────────────── */

const clamp = (message, limit) => ({ ...message, content: message.content.slice(0, limit) });

test("history is kept newest-first within its share", () => {
  const history = [
    { role: "user", content: "1".repeat(100) },
    { role: "assistant", content: "2".repeat(100) },
    { role: "user", content: "3".repeat(100) },
  ];
  const kept = fitHistory(history, { historyChars: 250, messageChars: 1_000 }, clamp);
  assert.deepEqual(kept.map((m) => m.content[0]), ["2", "3"]);
});

test("one long message is capped on its own so it cannot evict the turns around it", () => {
  const history = [
    { role: "user", content: "old".padEnd(50, "o") },
    { role: "assistant", content: "P".repeat(5_000) },
    { role: "user", content: "new".padEnd(50, "n") },
  ];
  const kept = fitHistory(history, { historyChars: 400, messageChars: 200 }, clamp);
  assert.equal(kept.length, 3, "every turn survives because the paste was clamped first");
  assert.equal(kept[1].content.length, 200);
});

test("order is preserved after fitting", () => {
  const history = Array.from({ length: 6 }, (_, i) => ({ role: "user", content: String(i) }));
  const kept = fitHistory(history, { historyChars: 4, messageChars: 10 }, clamp);
  assert.deepEqual(kept.map((m) => m.content), ["2", "3", "4", "5"]);
});
