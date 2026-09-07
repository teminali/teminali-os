import assert from "node:assert/strict";
import test from "node:test";
import { telemetry, loadWorthNaming, droppedWorthNaming } from "../src/utils/messageTelemetry.ts";

/**
 * The row under a reply, on hover. It was five flex children with a gap
 * between every value *and* every separator, so in a narrow column each field
 * wrapped inside its own box — "Claude / Code", "44,409 / tok" — a two-line
 * row inside a one-line-high container. It is one string now, so what is
 * pinned here is that the string is always well formed: no empty fields, no
 * doubled or trailing separators.
 */

test("only the fields that were measured appear", () => {
  assert.deepEqual(
    telemetry({ timestamp: "12:56", engineUsed: "Claude Code", tokensCount: 44409, durationSec: 3.94, costLabel: "$0.0404" }),
    ["12:56", "Claude Code", "44,409 tok", "3.9s", "$0.0404"],
  );
});

test("a field that was never measured is dropped, not rendered empty", () => {
  // Zero tokens and zero seconds are "not measured", not "measured as zero":
  // a reply that reports 0 tok is reporting a number nobody counted.
  assert.deepEqual(telemetry({ timestamp: "12:56", tokensCount: 0, durationSec: 0 }), ["12:56"]);
  assert.deepEqual(telemetry({}), []);
  assert.deepEqual(telemetry({ engineUsed: "Codex" }), ["Codex"]);
});

test("joining can never produce a doubled or trailing separator", () => {
  for (const message of [
    {},
    { timestamp: "12:56" },
    { timestamp: "12:56", costLabel: "$0.01" },
    { engineUsed: "Claude Code", tokensCount: 12 },
  ]) {
    const line = telemetry(message).join("  ·  ");
    assert.equal(line.includes("·  ·"), false, line);
    assert.equal(line.trim().endsWith("·"), false, line);
    assert.equal(line.trim().startsWith("·"), false, line);
  }
});

test("a duration is one decimal and a token count is grouped", () => {
  const [, tokens, duration] = telemetry({ timestamp: "x", tokensCount: 1234567, durationSec: 12.349 });
  assert.equal(tokens, "1,234,567 tok");
  assert.equal(duration, "12.3s");
});

test("a cold start is named, so a slow turn is not mistaken for a slow model", () => {
  const fields = telemetry({ durationSec: 12.4, loadSec: 8.1 });
  assert.ok(fields.includes("12.4s (8.1s load)"));
});

test("a warm model's millisecond load is not printed", () => {
  const fields = telemetry({ durationSec: 12.4, loadSec: 0.04 });
  assert.ok(fields.includes("12.4s"));
});

test("a load that is a small share of a long turn is not worth naming", () => {
  assert.equal(loadWorthNaming(60, 2), false);
  assert.equal(loadWorthNaming(6, 2), true);
});

test("a load nobody measured is not named", () => {
  assert.equal(loadWorthNaming(12.4, undefined), false);
  assert.equal(loadWorthNaming(undefined, 8.1), false);
  assert.equal(loadWorthNaming(0, 8.1), false);
});

/* ── What the window could not afford ──────────────────────────────────── */

test("a turn that fitted says nothing about dropped sections", () => {
  assert.deepEqual(droppedWorthNaming(undefined), []);
  assert.deepEqual(droppedWorthNaming([]), []);
});

test("the sections ranked last on purpose are not a warning", () => {
  // `systemPrompt.ts` puts these at the bottom precisely so they are the first
  // to go; naming them would put a notice under most short replies.
  assert.deepEqual(droppedWorthNaming(["house-style", "multi-agent", "completeness"]), []);
});

test("losing a capability is named", () => {
  assert.deepEqual(droppedWorthNaming(["tool-execution-mandate"]), ["tool-execution-mandate"]);
  assert.deepEqual(droppedWorthNaming(["screen", "ask"]), ["screen", "ask"]);
});

test("the affordable losses are filtered out of a mixed drop", () => {
  assert.deepEqual(
    droppedWorthNaming(["screen", "house-style", "doctrine", "completeness"]),
    ["screen", "doctrine"],
  );
});

test("priority order is preserved, because that is how the budget reported it", () => {
  assert.deepEqual(droppedWorthNaming(["doctrine", "ask", "screen"]), ["doctrine", "ask", "screen"]);
});

test("the row names the loss after the cost, and only when there is one", () => {
  const base = { timestamp: "12:56", engineUsed: "Frontier Flash", costLabel: "$0.0000 local" };
  assert.equal(telemetry({ ...base, droppedSections: ["house-style"] }).length, 3);
  assert.deepEqual(telemetry({ ...base, droppedSections: ["screen", "ask"] }).at(-1), "screen, ask dropped");
});
