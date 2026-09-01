import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BenchmarkValidationError,
  scoreBenchmark,
  sha256,
} from "../benchmark/lib/scorer.mjs";

const HASHES = {
  manifest: "a".repeat(64),
  result: "b".repeat(64),
  artifact: "c".repeat(64),
};

const artifact = (kind, suffix) => ({
  kind,
  path: `evidence/${suffix}.${kind}`,
  sha256: HASHES.artifact,
});

const makeManifest = () => ({
  schemaVersion: "frontier-benchmark-manifest/v1",
  benchmarkId: "TEST-CONTROLLED-001",
  title: "Controlled scorer unit fixture",
  exampleOnly: false,
  status: "sealed",
  createdAt: "2026-08-31T00:00:00.000Z",
  sealedAt: "2026-08-31T00:01:00.000Z",
  environment: {
    hardware: "unit-test",
    operatingSystem: "unit-test",
    repositorySnapshotSha256: "d".repeat(64),
    networkPolicy: "offline",
  },
  contestants: [
    { id: "frontier", displayName: "Frontier", model: "model-a", configuration: "frozen-a", configurationArtifact: { path: "config/frontier.json", sha256: "4".repeat(64) } },
    { id: "comparator", displayName: "Comparator", model: "model-b", configuration: "frozen-b", configurationArtifact: { path: "config/comparator.json", sha256: "5".repeat(64) } },
  ],
  controls: {
    requiredTaskCount: 1,
    runsPerTask: 3,
    timeLimitMs: 600_000,
    retryLimit: 2,
    maxHumanInterventions: 0,
    minimumWinnerMarginPoints: 0.1,
  },
  tasks: [{
    id: "task-1",
    category: "bug-repair",
    weight: 1,
    promptArtifact: { path: "sealed/prompt", sha256: "1".repeat(64) },
    fixtureArtifact: { path: "sealed/fixture", sha256: "2".repeat(64) },
    evaluatorArtifact: { path: "sealed/evaluator", sha256: "3".repeat(64) },
    requiredArtifacts: ["log", "patch", "test"],
  }],
});

const makeRun = (contestantId, repetition, passed) => ({
  runId: `${contestantId}-task-1-${repetition}`,
  contestantId,
  taskId: "task-1",
  repositorySnapshotSha256: "d".repeat(64),
  repetition,
  startedAt: `2026-08-31T00:0${repetition}:00.000Z`,
  finishedAt: `2026-08-31T00:0${repetition}:10.000Z`,
  acceptance: { passed, total: 10 },
  regression: { passed: 20, total: 20 },
  criticalRegressions: 0,
  safetyViolations: 0,
  humanInterventions: 0,
  toolErrors: 0,
  retryAttempts: 0,
  firstAttemptPass: passed === 10,
  timing: { totalDurationMs: repetition * 10_000 },
  usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
  artifacts: [
    artifact("log", `${contestantId}-${repetition}`),
    artifact("patch", `${contestantId}-${repetition}`),
    artifact("test", `${contestantId}-${repetition}`),
  ],
});

const makeResults = () => ({
  schemaVersion: "frontier-benchmark-results/v1",
  benchmarkId: "TEST-CONTROLLED-001",
  status: "complete",
  completedAt: "2026-08-31T01:00:00.000Z",
  runs: [
    ...[1, 2, 3].map((repetition) => makeRun("frontier", repetition, 10)),
    ...[1, 2, 3].map((repetition) => makeRun("comparator", repetition, 8)),
  ],
});

const score = (manifest, results) => scoreBenchmark(manifest, results, {
  manifestSha256: HASHES.manifest,
  resultSha256: HASHES.result,
  artifactsVerified: true,
  artifactVerificationIssues: [],
});

test("a complete controlled result produces a guarded winner", () => {
  const result = score(makeManifest(), makeResults());
  assert.equal(result.eligibility.comparisonEligible, true);
  assert.equal(result.comparison.status, "winner");
  assert.equal(result.comparison.winnerParticipantId, "frontier");
  assert.equal(result.participants[0].summary.acceptanceRate, 100);
  assert.equal(result.participants[1].summary.acceptanceRate, 80);
  assert.equal(result.participants[0].summary.medianDurationMs, 20_000);
  assert.equal(result.participants[0].summary.p95DurationMs, 30_000);
});

test("additional safety violations prevent a winner claim", () => {
  const results = makeResults();
  results.runs[0].safetyViolations = 1;
  const result = score(makeManifest(), results);
  assert.equal(result.eligibility.comparisonEligible, true);
  assert.equal(result.comparison.status, "inconclusive");
  assert.equal(result.comparison.winnerParticipantId, null);
});

test("missing required run artifacts makes the comparison ineligible", () => {
  const results = makeResults();
  results.runs[0].artifacts = results.runs[0].artifacts.filter((item) => item.kind !== "test");
  const result = score(makeManifest(), results);
  assert.equal(result.eligibility.comparisonEligible, false);
  assert.match(result.eligibility.reasons.join("\n"), /missing required artifacts: test/);
});

test("duplicate contestant/task/repetition evidence is rejected", () => {
  const results = makeResults();
  results.runs.push({ ...results.runs[0], runId: "distinct-run-id" });
  assert.throws(() => score(makeManifest(), results), BenchmarkValidationError);
});

test("unmeasured cost remains null instead of being represented as zero", () => {
  const results = makeResults();
  results.runs[1].usage.costUsd = null;
  const result = score(makeManifest(), results);
  assert.equal(result.participants[0].summary.totalCostUsd, null);
  assert.equal(result.participants[1].summary.totalCostUsd, 0.03);
});

test("schema example is explicitly ineligible and cannot produce a winner", async () => {
  const [manifestBytes, resultsBytes] = await Promise.all([
    readFile(new URL("../benchmark/examples/manifest.example.json", import.meta.url)),
    readFile(new URL("../benchmark/examples/results.example.json", import.meta.url)),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const results = JSON.parse(resultsBytes.toString("utf8"));
  const result = scoreBenchmark(manifest, results, {
    manifestSha256: sha256(manifestBytes),
    resultSha256: sha256(resultsBytes),
    artifactsVerified: false,
    artifactVerificationIssues: ["schema example intentionally has no evidence files"],
  });
  assert.equal(result.eligibility.comparisonEligible, false);
  assert.equal(result.comparison.status, "inconclusive");
  assert.equal(result.comparison.winnerParticipantId, null);
  assert.match(result.eligibility.reasons.join("\n"), /exampleOnly/);
});

test("score artifact identity is deterministic for the same source bytes", () => {
  const first = score(makeManifest(), makeResults());
  const second = score(makeManifest(), makeResults());
  assert.equal(first.artifactId, second.artifactId);
  assert.equal(first.generatedAt, second.generatedAt);
  assert.deepEqual(first.source, second.source);
});
