import test from "node:test";
import assert from "node:assert/strict";
import {
  activityCopy,
  createActivityIndicator,
  fitAnsi,
  friendlyError,
  renderActivityFrame,
  renderHeroBanner,
  renderInputCard,
  renderFooter,
  stripAnsi,
  supportsMotion,
  visibleLength,
} from "./frontier-tui.js";

test("renderHeroBanner produces centered Frontier Code pixel logo", () => {
  const banner = renderHeroBanner();
  assert.ok(typeof banner === "string");
  assert.ok(banner.includes("█▀▀"));
});

test("renderInputCard formats model, skill, and budget pills", () => {
  const card = renderInputCard({
    targetDir: "/Users/test/my-project",
    profile: "local",
    skill: "website-builder",
    budget: "0.50",
  });
  assert.ok(typeof card === "string");
  assert.ok(card.includes("Build"));
  assert.ok(card.includes("Qwen Coder 14B"));
  assert.ok(card.includes("Flash"));
  assert.ok(card.includes("Auto"));
  assert.ok(card.includes("Max"));
  assert.ok(card.includes("website-builder"));
});

test("renderInputCard labels the explicit high-memory local profile", () => {
  const card = renderInputCard({
    targetDir: "/Users/test/my-project",
    profile: "local-24b",
    skill: null,
    budget: "0.20",
  });
  assert.ok(card.includes("Devstral 24B"));
  assert.ok(card.includes("32GB+"));
});

test("renderInputCard labels the on-demand Qwen3.8 expert profile", () => {
  const output = renderInputCard({
    profile: "local-expert",
    skill: null,
    budget: "0.20",
  });
  assert.match(output, /Qwen3\.8 27B IQ3_M/);
  assert.match(output, /Heavyweight/);
  assert.match(output, /\$0\.00 \/ tok/);
});

test("renderInputCard presents Auto as the hybrid default mode", () => {
  const output = renderInputCard({
    profile: "local",
    modelMode: "auto",
    expertQualified: true,
    skill: null,
    budget: "0.20",
  });
  assert.match(output, /Qwen 14B ↔ Qwen3\.8/);
  assert.match(output, /Hybrid/);
});

test("renderInputCard marks Max as locked until qualification completes", () => {
  const output = renderInputCard({
    profile: "local",
    modelMode: "max",
    expertQualified: false,
    skill: null,
    budget: "0.20",
  });
  assert.match(output, /Max · locked/);
});

test("renderInputCard tells the truth when Auto has no qualified expert", () => {
  const output = renderInputCard({
    profile: "local",
    modelMode: "auto",
    expertQualified: false,
    skill: null,
    budget: "0.20",
  });
  assert.match(output, /Qwen 14B Auto · Max locked/);
  assert.doesNotMatch(output, /Qwen 14B ↔ Qwen3\.8/);
});

test("renderInputCard advertises only implemented commands", () => {
  const output = renderInputCard({
    profile: "local",
    modelMode: "auto",
    expertQualified: false,
    skill: null,
    budget: "0.20",
  });
  assert.match(output, /\/skills/);
  assert.match(output, /\/help/);
  assert.doesNotMatch(output, /ctrl\+p|tab skills/i);
});

test("responsive surfaces fit 24, 40, 80, and 120 columns", () => {
  for (const terminalWidth of [24, 40, 80, 120]) {
    const card = renderInputCard({
      profile: "local",
      modelMode: "auto",
      expertQualified: false,
      skill: "website-builder",
      budget: "0.20",
      terminalWidth,
    });
    for (const line of card.split("\n")) {
      assert.ok(visibleLength(line) <= terminalWidth, `${terminalWidth}: ${stripAnsi(line)}`);
    }
    assert.ok(visibleLength(renderFooter({ targetDir: "/a/very/long/project/path", terminalWidth })) <= terminalWidth);
    for (const line of renderHeroBanner(terminalWidth).split("\n")) {
      assert.ok(visibleLength(line) <= terminalWidth);
    }
  }
});

test("ANSI-safe fitting never splits formatting and honors visible width", () => {
  const output = fitAnsi("\x1b[31mabcdefgh\x1b[0m", 5);
  assert.equal(stripAnsi(output), "abcd…");
  assert.equal(visibleLength(output), 5);
});

test("motion disables for reduced-motion, CI, dumb terminals, and non-TTY", () => {
  assert.equal(supportsMotion({ isTTY: false }), false);
  assert.equal(supportsMotion({ isTTY: true, reducedMotion: true }), false);
  assert.equal(supportsMotion({ isTTY: true, ci: true }), false);
  assert.equal(supportsMotion({ isTTY: true, term: "dumb" }), false);
  assert.equal(supportsMotion({ isTTY: true, reducedMotion: false, ci: false, term: "xterm-256color" }), true);
});

test("activity frames stay width-bounded and expose lifecycle copy", () => {
  const frame = renderActivityFrame({ label: "Preparing a very long model name", width: 18, animate: false });
  assert.ok(visibleLength(frame) <= 18);
  assert.deepEqual(activityCopy("verifying", "running tests"), {
    label: "Verifying",
    detail: "running tests",
  });
});

test("non-interactive activity emits stable lines with no idle timer", () => {
  const writes = [];
  const output = { isTTY: false, columns: 40, write: (value) => writes.push(value) };
  const activity = createActivityIndicator({ output, animate: false, now: () => 1000 });
  activity.start("Preparing", "model");
  activity.update("Verifying", "tests");
  assert.equal(activity.isActive(), true);
  activity.stop("Finished");
  assert.equal(activity.isActive(), false);
  assert.ok(writes.every((value) => !value.includes("\x1b[?25")));
  assert.match(stripAnsi(writes.join("")), /Preparing · model\n.*Verifying · tests\n.*Finished\n/s);
});

test("friendly errors give actionable memory, cancellation, timeout, and service guidance", () => {
  assert.equal(friendlyError("requires 10 GB free memory").title, "Not enough free memory");
  assert.equal(friendlyError("agent_cancelled").title, "Run cancelled");
  assert.equal(friendlyError("agent_timeout").title, "Run timed out");
  assert.equal(friendlyError("Local Ollama is unavailable").title, "Local model service is offline");
});

test("renderFooter displays current working directory", () => {
  const footer = renderFooter({ targetDir: "/Users/test/my-project" });
  assert.ok(typeof footer === "string");
  assert.ok(footer.includes("my-project"));
  assert.ok(footer.includes("0.1.0"));
});
