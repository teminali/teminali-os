import { createHash } from "node:crypto";

export const MANIFEST_SCHEMA = "frontier-benchmark-manifest/v1";
export const RESULTS_SCHEMA = "frontier-benchmark-results/v1";
export const SCORE_SCHEMA = "frontier-benchmark-score/v1";
export const SCORER_VERSION = "1.0.0";

export class BenchmarkValidationError extends Error {
  constructor(issues) {
    super(`Benchmark input is invalid:\n- ${issues.join("\n- ")}`);
    this.name = "BenchmarkValidationError";
    this.issues = issues;
  }
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const isNonNegativeNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isSha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isIsoDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const round = (value, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function validateArtifactRef(value, path, issues) {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  if (!isNonEmptyString(value.path)) issues.push(`${path}.path must be a non-empty string`);
  if (!isSha256(value.sha256)) issues.push(`${path}.sha256 must be a lowercase SHA-256 digest`);
}

function validateManifest(manifest) {
  const issues = [];
  if (!isRecord(manifest)) return ["manifest must be an object"];
  if (manifest.schemaVersion !== MANIFEST_SCHEMA) issues.push(`manifest.schemaVersion must equal ${MANIFEST_SCHEMA}`);
  if (!isNonEmptyString(manifest.benchmarkId)) issues.push("manifest.benchmarkId must be a non-empty string");
  if (!isNonEmptyString(manifest.title)) issues.push("manifest.title must be a non-empty string");
  if (typeof manifest.exampleOnly !== "boolean") issues.push("manifest.exampleOnly must be boolean");
  if (!["draft", "sealed"].includes(manifest.status)) issues.push("manifest.status must be draft or sealed");
  if (!isIsoDate(manifest.createdAt)) issues.push("manifest.createdAt must be an ISO date");
  if (manifest.status === "sealed" && !isIsoDate(manifest.sealedAt)) issues.push("a sealed manifest requires sealedAt");
  if (!isRecord(manifest.environment)) issues.push("manifest.environment must be an object");

  if (!Array.isArray(manifest.contestants) || manifest.contestants.length !== 2) {
    issues.push("manifest.contestants must contain exactly two contestants");
  } else {
    const ids = new Set();
    manifest.contestants.forEach((contestant, index) => {
      const path = `manifest.contestants[${index}]`;
      if (!isRecord(contestant)) {
        issues.push(`${path} must be an object`);
        return;
      }
      if (!isNonEmptyString(contestant.id)) issues.push(`${path}.id must be a non-empty string`);
      if (!isNonEmptyString(contestant.displayName)) issues.push(`${path}.displayName must be a non-empty string`);
      if (!isNonEmptyString(contestant.model)) issues.push(`${path}.model must be a non-empty string`);
      if (!isNonEmptyString(contestant.configuration)) issues.push(`${path}.configuration must be a non-empty string`);
      validateArtifactRef(contestant.configurationArtifact, `${path}.configurationArtifact`, issues);
      if (ids.has(contestant.id)) issues.push(`${path}.id is duplicated`);
      ids.add(contestant.id);
    });
  }

  const controls = manifest.controls;
  if (!isRecord(controls)) {
    issues.push("manifest.controls must be an object");
  } else {
    if (!isPositiveInteger(controls.requiredTaskCount)) issues.push("manifest.controls.requiredTaskCount must be a positive integer");
    if (!isPositiveInteger(controls.runsPerTask) || controls.runsPerTask < 3) issues.push("manifest.controls.runsPerTask must be an integer of at least 3");
    if (!isPositiveInteger(controls.timeLimitMs)) issues.push("manifest.controls.timeLimitMs must be a positive integer");
    if (!Number.isInteger(controls.retryLimit) || controls.retryLimit < 0) issues.push("manifest.controls.retryLimit must be a non-negative integer");
    if (!Number.isInteger(controls.maxHumanInterventions) || controls.maxHumanInterventions < 0) issues.push("manifest.controls.maxHumanInterventions must be a non-negative integer");
    if (!isNonNegativeNumber(controls.minimumWinnerMarginPoints)) issues.push("manifest.controls.minimumWinnerMarginPoints must be non-negative");
  }

  if (isRecord(manifest.environment)) {
    if (!isNonEmptyString(manifest.environment.hardware)) issues.push("manifest.environment.hardware must be a non-empty string");
    if (!isNonEmptyString(manifest.environment.operatingSystem)) issues.push("manifest.environment.operatingSystem must be a non-empty string");
    if (!isSha256(manifest.environment.repositorySnapshotSha256)) issues.push("manifest.environment.repositorySnapshotSha256 must be a SHA-256 digest");
    if (!isNonEmptyString(manifest.environment.networkPolicy)) issues.push("manifest.environment.networkPolicy must be a non-empty string");
  }

  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
    issues.push("manifest.tasks must be a non-empty array");
  } else {
    const ids = new Set();
    manifest.tasks.forEach((task, index) => {
      const path = `manifest.tasks[${index}]`;
      if (!isRecord(task)) {
        issues.push(`${path} must be an object`);
        return;
      }
      if (!isNonEmptyString(task.id)) issues.push(`${path}.id must be a non-empty string`);
      if (ids.has(task.id)) issues.push(`${path}.id is duplicated`);
      ids.add(task.id);
      if (!isNonEmptyString(task.category)) issues.push(`${path}.category must be a non-empty string`);
      if (!isNonNegativeNumber(task.weight) || task.weight === 0) issues.push(`${path}.weight must be positive`);
      validateArtifactRef(task.promptArtifact, `${path}.promptArtifact`, issues);
      validateArtifactRef(task.fixtureArtifact, `${path}.fixtureArtifact`, issues);
      validateArtifactRef(task.evaluatorArtifact, `${path}.evaluatorArtifact`, issues);
      if (!Array.isArray(task.requiredArtifacts) || task.requiredArtifacts.length === 0 || task.requiredArtifacts.some((item) => !isNonEmptyString(item))) {
        issues.push(`${path}.requiredArtifacts must contain non-empty artifact kinds`);
      } else if (new Set(task.requiredArtifacts).size !== task.requiredArtifacts.length) {
        issues.push(`${path}.requiredArtifacts must not contain duplicates`);
      }
    });
  }
  return issues;
}

function validateResults(results, manifest) {
  const issues = [];
  if (!isRecord(results)) return ["results must be an object"];
  if (results.schemaVersion !== RESULTS_SCHEMA) issues.push(`results.schemaVersion must equal ${RESULTS_SCHEMA}`);
  if (results.benchmarkId !== manifest.benchmarkId) issues.push("results.benchmarkId must match manifest.benchmarkId");
  if (!["partial", "complete"].includes(results.status)) issues.push("results.status must be partial or complete");
  if (!isIsoDate(results.completedAt)) issues.push("results.completedAt must be an ISO date");
  if (!Array.isArray(results.runs)) {
    issues.push("results.runs must be an array");
    return issues;
  }

  const contestantIds = new Set((manifest.contestants ?? []).map((item) => item.id));
  const taskIds = new Set((manifest.tasks ?? []).map((item) => item.id));
  const runIds = new Set();
  const runKeys = new Set();
  results.runs.forEach((run, index) => {
    const path = `results.runs[${index}]`;
    if (!isRecord(run)) {
      issues.push(`${path} must be an object`);
      return;
    }
    if (!isNonEmptyString(run.runId)) issues.push(`${path}.runId must be a non-empty string`);
    if (runIds.has(run.runId)) issues.push(`${path}.runId is duplicated`);
    runIds.add(run.runId);
    if (!contestantIds.has(run.contestantId)) issues.push(`${path}.contestantId is not in the manifest`);
    if (!taskIds.has(run.taskId)) issues.push(`${path}.taskId is not in the manifest`);
    if (!isSha256(run.repositorySnapshotSha256)) issues.push(`${path}.repositorySnapshotSha256 must be a SHA-256 digest`);
    if (run.repositorySnapshotSha256 !== manifest.environment.repositorySnapshotSha256) issues.push(`${path}.repositorySnapshotSha256 does not match the frozen manifest snapshot`);
    if (!isPositiveInteger(run.repetition)) issues.push(`${path}.repetition must be a positive integer`);
    const key = `${run.contestantId}:${run.taskId}:${run.repetition}`;
    if (runKeys.has(key)) issues.push(`${path} duplicates contestant/task/repetition ${key}`);
    runKeys.add(key);
    if (!isIsoDate(run.startedAt) || !isIsoDate(run.finishedAt)) {
      issues.push(`${path} requires ISO startedAt and finishedAt`);
    } else if (Date.parse(run.finishedAt) < Date.parse(run.startedAt)) {
      issues.push(`${path}.finishedAt must not precede startedAt`);
    }

    for (const name of ["acceptance", "regression"]) {
      const check = run[name];
      if (!isRecord(check) || !Number.isInteger(check.passed) || !isPositiveInteger(check.total) || check.passed < 0 || check.passed > check.total) {
        issues.push(`${path}.${name} requires integer 0 <= passed <= total, with total > 0`);
      }
    }
    for (const name of ["criticalRegressions", "safetyViolations", "humanInterventions", "toolErrors"]) {
      if (!Number.isInteger(run[name]) || run[name] < 0) issues.push(`${path}.${name} must be a non-negative integer`);
    }
    if (!Number.isInteger(run.retryAttempts) || run.retryAttempts < 0) issues.push(`${path}.retryAttempts must be a non-negative integer`);
    if (typeof run.firstAttemptPass !== "boolean") issues.push(`${path}.firstAttemptPass must be boolean`);
    if (!isRecord(run.timing) || !isNonNegativeNumber(run.timing.totalDurationMs)) issues.push(`${path}.timing.totalDurationMs must be non-negative`);
    if (!isRecord(run.usage)) {
      issues.push(`${path}.usage must be an object`);
    } else {
      for (const name of ["inputTokens", "outputTokens"]) {
        if (run.usage[name] !== null && (!Number.isInteger(run.usage[name]) || run.usage[name] < 0)) issues.push(`${path}.usage.${name} must be null or a non-negative integer`);
      }
      if (run.usage.costUsd !== null && !isNonNegativeNumber(run.usage.costUsd)) issues.push(`${path}.usage.costUsd must be null or non-negative`);
    }
    if (!Array.isArray(run.artifacts)) {
      issues.push(`${path}.artifacts must be an array`);
    } else {
      run.artifacts.forEach((artifact, artifactIndex) => {
        if (!isRecord(artifact) || !isNonEmptyString(artifact.kind)) issues.push(`${path}.artifacts[${artifactIndex}].kind must be a non-empty string`);
        validateArtifactRef(artifact, `${path}.artifacts[${artifactIndex}]`, issues);
      });
    }
  });
  return issues;
}

const percentile = (values, fraction) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
};

function summarizeParticipant(contestant, manifest, runs) {
  let weightedAcceptance = 0;
  let totalWeight = 0;
  for (const task of manifest.tasks) {
    const taskRuns = runs.filter((run) => run.taskId === task.id);
    const passed = taskRuns.reduce((sum, run) => sum + run.acceptance.passed, 0);
    const total = taskRuns.reduce((sum, run) => sum + run.acceptance.total, 0);
    if (total > 0) {
      weightedAcceptance += (passed / total) * task.weight;
      totalWeight += task.weight;
    }
  }
  const regressionPassed = runs.reduce((sum, run) => sum + run.regression.passed, 0);
  const regressionTotal = runs.reduce((sum, run) => sum + run.regression.total, 0);
  const costs = runs.map((run) => run.usage.costUsd);
  const allCostsMeasured = costs.every((value) => value !== null);
  return {
    participantId: contestant.id,
    displayName: contestant.displayName,
    summary: {
      runs: runs.length,
      taskCoverage: new Set(runs.map((run) => run.taskId)).size,
      acceptanceRate: totalWeight === 0 ? null : round((weightedAcceptance / totalWeight) * 100),
      regressionRate: regressionTotal === 0 ? null : round((regressionPassed / regressionTotal) * 100),
      criticalRegressions: runs.reduce((sum, run) => sum + run.criticalRegressions, 0),
      safetyViolations: runs.reduce((sum, run) => sum + run.safetyViolations, 0),
      humanInterventions: runs.reduce((sum, run) => sum + run.humanInterventions, 0),
      toolErrors: runs.reduce((sum, run) => sum + run.toolErrors, 0),
      firstAttemptPassRate: runs.length === 0 ? null : round((runs.filter((run) => run.firstAttemptPass).length / runs.length) * 100),
      medianDurationMs: percentile(runs.map((run) => run.timing.totalDurationMs), 0.5),
      p95DurationMs: percentile(runs.map((run) => run.timing.totalDurationMs), 0.95),
      totalCostUsd: allCostsMeasured ? round(costs.reduce((sum, value) => sum + value, 0), 8) : null,
    },
  };
}

function eligibilityReasons(manifest, results, source) {
  const reasons = [];
  if (manifest.exampleOnly) reasons.push("Manifest is explicitly marked exampleOnly.");
  if (manifest.status !== "sealed") reasons.push("Manifest is not sealed.");
  if (results.status !== "complete") reasons.push("Result collection is not complete.");
  if (manifest.tasks.length !== manifest.controls.requiredTaskCount) {
    reasons.push(`Manifest has ${manifest.tasks.length} tasks; exactly ${manifest.controls.requiredTaskCount} are required.`);
  }
  if (source.artifactsVerified !== true) {
    reasons.push("Referenced artifact contents were not verified against their SHA-256 digests.");
  }
  for (const issue of source.artifactVerificationIssues ?? []) reasons.push(`Artifact verification: ${issue}`);

  for (const contestant of manifest.contestants) {
    for (const task of manifest.tasks) {
      const runs = results.runs.filter((run) => run.contestantId === contestant.id && run.taskId === task.id);
      if (runs.length !== manifest.controls.runsPerTask) {
        reasons.push(`${contestant.id}/${task.id} has ${runs.length} runs; exactly ${manifest.controls.runsPerTask} are required.`);
      }
      for (const run of runs) {
        if (run.humanInterventions > manifest.controls.maxHumanInterventions) {
          reasons.push(`${run.runId} exceeds the human-intervention budget.`);
        }
        if (run.timing.totalDurationMs > manifest.controls.timeLimitMs) {
          reasons.push(`${run.runId} exceeds the time budget.`);
        }
        if (run.retryAttempts > manifest.controls.retryLimit) {
          reasons.push(`${run.runId} exceeds the retry budget.`);
        }
        const kinds = new Set(run.artifacts.map((artifact) => artifact.kind));
        const missing = task.requiredArtifacts.filter((kind) => !kinds.has(kind));
        if (missing.length > 0) reasons.push(`${run.runId} is missing required artifacts: ${missing.join(", ")}.`);
      }
    }
  }
  return [...new Set(reasons)].sort();
}

function compareParticipants(participants, eligible, minimumMargin) {
  if (!eligible) {
    return {
      status: "inconclusive",
      winnerParticipantId: null,
      rationale: "The comparison is ineligible because one or more controlled-benchmark requirements are unmet.",
    };
  }
  const [left, right] = participants;
  const a = left.summary;
  const b = right.summary;
  if (a.acceptanceRate === null || b.acceptanceRate === null || a.regressionRate === null || b.regressionRate === null) {
    return { status: "inconclusive", winnerParticipantId: null, rationale: "Quality measurements are incomplete." };
  }

  const acceptanceDelta = a.acceptanceRate - b.acceptanceRate;
  const regressionDelta = a.regressionRate - b.regressionRate;
  const safetyEquivalent = a.safetyViolations === b.safetyViolations && a.criticalRegressions === b.criticalRegressions;
  if (Math.abs(acceptanceDelta) < minimumMargin && Math.abs(regressionDelta) < minimumMargin && safetyEquivalent) {
    return {
      status: "tie",
      winnerParticipantId: null,
      rationale: `Acceptance and regression pass rates differ by less than the ${minimumMargin}-point win margin, with equal critical and safety outcomes.`,
    };
  }

  const candidate = acceptanceDelta > 0 ? left : right;
  const opponent = candidate === left ? right : left;
  const candidateSummary = candidate.summary;
  const opponentSummary = opponent.summary;
  const acceptanceAdvantage = candidateSummary.acceptanceRate - opponentSummary.acceptanceRate;
  const noAdditionalCritical = candidateSummary.criticalRegressions <= opponentSummary.criticalRegressions;
  const noAdditionalSafety = candidateSummary.safetyViolations <= opponentSummary.safetyViolations;
  const noRegressionDisadvantage = candidateSummary.regressionRate >= opponentSummary.regressionRate;

  if (acceptanceAdvantage >= minimumMargin && noAdditionalCritical && noAdditionalSafety && noRegressionDisadvantage) {
    return {
      status: "winner",
      winnerParticipantId: candidate.participantId,
      rationale: `${candidate.displayName} leads acceptance by ${round(acceptanceAdvantage)} points without worse regression, critical-regression, or safety outcomes.`,
    };
  }
  return {
    status: "inconclusive",
    winnerParticipantId: null,
    rationale: "Quality metrics conflict or the leading acceptance result does not clear every safety and regression guardrail.",
  };
}

export function scoreBenchmark(manifest, results, source = {}) {
  const issues = [...validateManifest(manifest)];
  if (issues.length === 0) issues.push(...validateResults(results, manifest));
  if (issues.length > 0) throw new BenchmarkValidationError(issues);

  const manifestSha256 = source.manifestSha256;
  const resultSha256 = source.resultSha256;
  if (!isSha256(manifestSha256) || !isSha256(resultSha256)) {
    throw new BenchmarkValidationError(["source manifestSha256 and resultSha256 are required"]);
  }

  const reasons = eligibilityReasons(manifest, results, source);
  const participants = manifest.contestants.map((contestant) =>
    summarizeParticipant(contestant, manifest, results.runs.filter((run) => run.contestantId === contestant.id))
  );
  const comparisonEligible = reasons.length === 0;
  const comparison = compareParticipants(participants, comparisonEligible, manifest.controls.minimumWinnerMarginPoints);
  const artifactId = `score-${sha256(`${manifestSha256}:${resultSha256}:${SCORER_VERSION}`).slice(0, 20)}`;

  return {
    schemaVersion: SCORE_SCHEMA,
    scorerVersion: SCORER_VERSION,
    benchmarkId: manifest.benchmarkId,
    artifactId,
    generatedAt: results.completedAt,
    source: { manifestSha256, resultSha256 },
    artifactVerification: {
      verified: source.artifactsVerified === true,
      issues: [...(source.artifactVerificationIssues ?? [])],
    },
    status: comparisonEligible ? "complete" : "partial",
    eligibility: { comparisonEligible, reasons },
    participants,
    comparison,
    artifactRefs: results.runs.flatMap((run) => run.artifacts.map((artifact) => artifact.path)).sort(),
  };
}
