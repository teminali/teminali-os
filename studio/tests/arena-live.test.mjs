import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  applyMeasureEvent,
  formatElapsed,
  isLaneBusy,
  pendingChecks,
  statusLabel,
  tailOf,
} from "../src/services/arenaLive.ts";
import { measureSandbox } from "../server/arena.js";

const run = promisify(execFile);

/* ── The live check list ──────────────────────────────────────────────────── */

const CHECKS = [
  { name: "Typecheck", command: "npx tsc --noEmit" },
  { name: "Tests", command: "npm test" },
];

test("a check that has not run is shown as pending, not as passing", () => {
  // The distinction the whole panel rests on: "tests passed" and "tests have
  // not started" must never render the same.
  const checks = pendingChecks(CHECKS);
  assert.equal(checks.length, 2);
  assert.ok(checks.every((check) => check.state === "pending"));
  assert.ok(checks.every((check) => check.durationMs === 0));
});

test("only the named check starts running", () => {
  const state = { status: "measuring", checks: pendingChecks(CHECKS), measurement: null };
  const next = applyMeasureEvent(state, { type: "check-start", name: "Tests", command: "npm test" });
  assert.equal(next.checks.find((c) => c.name === "Tests").state, "running");
  assert.equal(next.checks.find((c) => c.name === "Typecheck").state, "pending");
  assert.equal(next.status, "checking");
});

test("a settled check carries its verdict, its duration and its output", () => {
  const started = applyMeasureEvent(
    { status: "checking", checks: pendingChecks(CHECKS), measurement: null },
    { type: "check-start", name: "Tests", command: "npm test" },
  );
  const settled = applyMeasureEvent(started, {
    type: "check",
    name: "Tests",
    command: "npm test",
    passed: false,
    durationMs: 4200,
    output: "1 failing",
  });
  const tests = settled.checks.find((c) => c.name === "Tests");
  assert.equal(tests.state, "failed");
  assert.equal(tests.durationMs, 4200);
  assert.match(tests.output, /1 failing/);
  assert.equal(settled.checks.length, 2, "settling one check does not drop the other");
});

test("the diff lands before the checks, and says so", () => {
  const state = { status: "measuring", checks: pendingChecks(CHECKS), measurement: null };
  const next = applyMeasureEvent(state, {
    type: "diff",
    filesChanged: 3,
    linesAdded: 40,
    linesRemoved: 12,
    files: [{ status: "M", path: "src/x.ts" }],
    diff: "--- a/x",
    diffTruncated: false,
  });
  assert.equal(next.measurement.filesChanged, 3);
  assert.equal(next.status, "checking", "the counts are known; the slow part is still to come");
  assert.ok(next.checks.every((check) => check.state === "pending"), "the diff settles no checks");
});

test("with no checks configured the diff does not invent a verification stage", () => {
  const next = applyMeasureEvent(
    { status: "measuring", checks: [], measurement: null },
    { type: "diff", filesChanged: 0, linesAdded: 0, linesRemoved: 0, files: [], diff: "", diffTruncated: false },
  );
  assert.equal(next.status, "measuring");
});

test("the server's final result is authoritative", () => {
  // A run stopped mid-verification leaves a check running on screen. The
  // result closes the stream, and what it does not contain did not happen.
  const midway = applyMeasureEvent(
    { status: "checking", checks: pendingChecks(CHECKS), measurement: null },
    { type: "check-start", name: "Typecheck", command: "npx tsc --noEmit" },
  );
  const closed = applyMeasureEvent(midway, {
    type: "result",
    measurement: {
      filesChanged: 1,
      linesAdded: 2,
      linesRemoved: 0,
      files: [],
      diff: "",
      diffTruncated: false,
      checks: [{ name: "Typecheck", command: "npx tsc --noEmit", passed: true, durationMs: 900, output: "" }],
    },
  });
  assert.equal(closed.status, "done");
  assert.equal(closed.checks.length, 1, "the check that never ran is gone, not left spinning");
  assert.equal(closed.checks[0].state, "passed");
});

test("a measurement error fails the lane rather than leaving it spinning", () => {
  const next = applyMeasureEvent(
    { status: "checking", checks: [], measurement: null },
    { type: "error", code: "ARENA_MEASURE_FAILED", message: "no" },
  );
  assert.equal(next.status, "failed");
});

/* ── Reading the live state ───────────────────────────────────────────────── */

test("every lane status has a label, and only the live ones count as busy", () => {
  for (const status of ["queued", "preparing", "working", "measuring", "checking"]) {
    assert.equal(isLaneBusy(status), true, status);
    assert.ok(statusLabel(status).length > 0, status);
  }
  for (const status of ["done", "failed", "stopped"]) {
    assert.equal(isLaneBusy(status), false, status);
    assert.ok(statusLabel(status).length > 0, status);
  }
});

test("the clock reads in seconds, then in minutes", () => {
  assert.equal(formatElapsed(0), "0.0s");
  assert.equal(formatElapsed(4_250), "4.3s");
  assert.equal(formatElapsed(65_000), "1:05");
  assert.equal(formatElapsed(600_000), "10:00");
  assert.equal(formatElapsed(-5), "0.0s", "a clock that has not started is not negative");
});

test("a long transcript is shown from the end, and says it was cut", () => {
  const text = `${"a".repeat(20_000)}THE-LAST-LINE`;
  const shown = tailOf(text, 100);
  assert.match(shown, /THE-LAST-LINE$/, "the interesting line is the last one");
  assert.ok(shown.startsWith("…"), "the elision is visible");
  assert.ok(shown.length < 200);
  assert.equal(tailOf("short", 100), "short", "a short transcript is untouched");
});

/* ── The server actually emits those events ───────────────────────────────── */

test("measureSandbox announces the diff, then each check as it starts and lands", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-live-"));
  const sandbox = join(root, ".frontier-arena", "run1", "frontier");
  await mkdir(sandbox, { recursive: true });
  await writeFile(join(sandbox, "x.txt"), "one\n", "utf8");
  await run("git", ["init", "--quiet"], { cwd: sandbox });
  await run("git", ["config", "user.email", "t@t"], { cwd: sandbox });
  await run("git", ["config", "user.name", "t"], { cwd: sandbox });
  await run("git", ["add", "-A"], { cwd: sandbox });
  await run("git", ["commit", "--quiet", "-m", "baseline"], { cwd: sandbox });
  // What the contestant "did".
  await writeFile(join(sandbox, "x.txt"), "one\ntwo\n", "utf8");

  const events = [];
  const measurement = await measureSandbox({
    root,
    runId: "run1",
    contestantId: "frontier",
    verify: [
      { name: "Passing", command: "exit 0" },
      { name: "Failing", command: "echo boom >&2; exit 3" },
    ],
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(
    events.map((event) => `${event.type}:${event.name ?? ""}`),
    ["diff:", "check-start:Passing", "check:Passing", "check-start:Failing", "check:Failing"],
    "the diff first, then each check announced before it runs",
  );

  const diff = events[0];
  assert.equal(diff.filesChanged, 1);
  assert.equal(diff.linesAdded, 1);
  assert.equal(events[2].passed, true);
  assert.equal(events[4].passed, false);
  assert.match(events[4].output, /boom/, "a failing check carries the output that explains it");

  // The blocking return value still describes the same run.
  assert.equal(measurement.filesChanged, 1);
  assert.deepEqual(measurement.checks.map((check) => check.passed), [true, false]);

  await rm(root, { recursive: true, force: true });
});

test("stopping a run kills the check and everything it spawned", async () => {
  // Regression: `execFile` with an AbortSignal kills only the shell, so a
  // stopped benchmark left `npm test` running in a directory it was about to
  // delete. The marker below is written by the *grandchild*; if it appears,
  // the process tree outlived the stop.
  const root = await mkdtemp(join(tmpdir(), "arena-live-"));
  const sandbox = join(root, ".frontier-arena", "run3", "frontier");
  await mkdir(sandbox, { recursive: true });
  await run("git", ["init", "--quiet"], { cwd: sandbox });
  await run("git", ["config", "user.email", "t@t"], { cwd: sandbox });
  await run("git", ["config", "user.name", "t"], { cwd: sandbox });
  await run("git", ["commit", "--quiet", "--allow-empty", "-m", "baseline"], { cwd: sandbox });

  const controller = new AbortController();
  const measuring = measureSandbox({
    root,
    runId: "run3",
    contestantId: "frontier",
    verify: [
      { name: "Long", command: "sleep 3 && touch survived.txt" },
      { name: "Never", command: "touch also-survived.txt" },
    ],
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  controller.abort();

  const measurement = await measuring;
  assert.equal(measurement.checks.length, 1, "the check after the stop never starts");
  assert.equal(measurement.checks[0].passed, false);
  assert.match(measurement.checks[0].output, /stopped/, "a killed check says why, so red is not read as a real failure");

  await new Promise((resolve) => setTimeout(resolve, 3_500));
  assert.equal(existsSync(join(sandbox, "survived.txt")), false, "the process tree was killed, not orphaned");
  assert.equal(existsSync(join(sandbox, "also-survived.txt")), false);

  await rm(root, { recursive: true, force: true });
});

test("measureSandbox without an onEvent still measures", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-live-"));
  const sandbox = join(root, ".frontier-arena", "run2", "codex");
  await mkdir(sandbox, { recursive: true });
  await run("git", ["init", "--quiet"], { cwd: sandbox });
  await run("git", ["config", "user.email", "t@t"], { cwd: sandbox });
  await run("git", ["config", "user.name", "t"], { cwd: sandbox });
  await run("git", ["commit", "--quiet", "--allow-empty", "-m", "baseline"], { cwd: sandbox });

  const measurement = await measureSandbox({ root, runId: "run2", contestantId: "codex" });
  assert.equal(measurement.filesChanged, 0);
  assert.deepEqual(measurement.checks, []);

  await rm(root, { recursive: true, force: true });
});
