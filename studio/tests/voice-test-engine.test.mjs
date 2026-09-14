import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { parseArgs, BENCHMARK_SUITE } from "../scripts/voice-test-engine/config.mjs";
import { getPlatformInfo } from "../scripts/voice-test-engine/platform.mjs";
import { findTemiPage } from "../scripts/voice-test-engine/cdp.mjs";
import { calculateTurnScores, createBenchmarkReport } from "../scripts/voice-test-engine/benchmarks.mjs";

test("voice-test-engine: parseArgs defaults and CLI overrides", () => {
  // Defaults
  const defaults = parseArgs([]);
  const expectedMode = (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") ? "direct" : "acoustic";
  assert.equal(defaults.mode, expectedMode);
  assert.equal(defaults.port, 9222);
  assert.equal(defaults.timeoutMs, 50000);
  assert.equal(defaults.suite, false);
  assert.equal(typeof defaults.outputDir, "string");
  assert.equal(fs.existsSync(defaults.outputDir), true);

  // Overrides
  const custom = parseArgs([
    "-m", "direct",
    "--port", "9234",
    "--timeout", "40000",
    "--suite",
    "--ci",
    "--no-play",
    "--no-focus",
  ]);
  assert.equal(custom.mode, "direct");
  assert.equal(custom.port, 9234);
  assert.equal(custom.timeoutMs, 40000);
  assert.equal(custom.suite, true);
  assert.equal(custom.isCi, true);
  assert.equal(custom.skipPlay, true);
  assert.equal(custom.skipFocus, true);
});

test("voice-test-engine: BENCHMARK_SUITE contains essential scenarios", () => {
  assert.ok(BENCHMARK_SUITE.length >= 3);
  for (const scenario of BENCHMARK_SUITE) {
    assert.ok(scenario.id, "scenario must have an id");
    assert.ok(scenario.query, "scenario must have a query string");
    assert.ok(Array.isArray(scenario.expectedKeywords), "scenario must have expectedKeywords array");
    assert.ok(scenario.timeoutMs > 5000, "scenario timeout must be reasonable");
  }
});

test("voice-test-engine: getPlatformInfo returns current OS metadata", () => {
  const info = getPlatformInfo();
  assert.equal(info.platform, process.platform);
  assert.equal(typeof info.arch, "string");
  assert.equal(typeof info.nodeVersion, "string");
  assert.equal(typeof info.isMac, "boolean");
  assert.equal(typeof info.isLinux, "boolean");
  assert.equal(typeof info.isWindows, "boolean");
});

test("voice-test-engine: findTemiPage locates matching target", () => {
  const mockPages = [
    { type: "background_page", title: "Extension", url: "chrome-extension://123" },
    { type: "page", title: "Other Tab", url: "https://example.com" },
    { type: "page", title: "Teminali OS — Autonomous AI Studio", url: "http://localhost:3000/" },
  ];

  const match = findTemiPage(mockPages);
  assert.equal(match.url, "http://localhost:3000/");
  assert.ok(match.title.includes("Teminali"));
});

test("voice-test-engine: calculateTurnScores handles healthy and flawed turns", () => {
  // Healthy spoken turn
  const healthy = calculateTurnScores({
    audioPayload: {
      totalSamples: 240000,
      durationSeconds: 5.0,
      isVoiced: true,
      rmsDbfs: -20.5,
      transcript: "You have 28 gigabytes of available storage left.",
    },
    timings: {
      narrationLatencyMs: 1200,
      totalTurnDurationMs: 4200,
    },
    evalState: {
      isDoubleMessage: false,
      answerLines: ["You have 28 gigabytes of available storage left."],
    },
    expectedKeywords: ["gigabyte", "storage", "available"],
  });

  assert.ok(healthy.overallScore >= 80, `Healthy score should be >= 80, got ${healthy.overallScore}`);
  assert.equal(healthy.integrityScore, 100);
  assert.equal(healthy.passed, true);

  // Turn with double message regression
  const doubleTurn = calculateTurnScores({
    audioPayload: {
      totalSamples: 240000,
      durationSeconds: 5.0,
      isVoiced: true,
      rmsDbfs: -20.5,
      transcript: "You have 28 gigabytes.",
    },
    timings: {
      totalTurnDurationMs: 4000,
    },
    evalState: {
      isDoubleMessage: true, // REGRESSION
      answerLines: ["You have 28 gigabytes.", "You have 28 gigabytes."],
    },
    expectedKeywords: ["gigabyte"],
  });

  assert.equal(doubleTurn.integrityScore, 0, "Integrity score must be 0 for double messages");
  assert.equal(doubleTurn.passed, false, "Turn must fail when double message is detected");
});

test("voice-test-engine: createBenchmarkReport produces valid JSON structure", () => {
  const tmpDir = path.join(process.cwd(), "test-output", "unit-test-tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const { report, reportPath } = createBenchmarkReport({
    query: "test query",
    mode: "direct",
    audioPayload: {
      sampleRate: 48000,
      totalSamples: 48000,
      durationSeconds: 1.0,
      chunkCount: 10,
      peakAmplitude: 15000,
      avgRms: 3200,
      rmsDbfs: -20.0,
      isVoiced: true,
      transcript: "Unit test response",
    },
    timings: {
      narrationLatencyMs: 800,
      totalTurnDurationMs: 2500,
    },
    evalState: {
      isDoubleMessage: false,
      answerLines: ["Unit test response"],
    },
    scores: {
      overallScore: 92,
      acousticScore: 90,
      latencyScore: 95,
      integrityScore: 100,
      passed: true,
    },
    wavPath: null,
    outputDir: tmpDir,
  });

  assert.equal(report.query, "test query");
  assert.equal(report.overallScore, 92);
  assert.equal(fs.existsSync(reportPath), true);

  // Clean up tmp test file
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
