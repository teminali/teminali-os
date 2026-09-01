import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const QUALITY_CONFIG_SCHEMA = "frontier-quality-config/v1";
export const QUALITY_REPORT_SCHEMA = "frontier-quality-report/v1";
const REQUIRED_SUITE_TYPES = ["typecheck", "unit", "integration", "browser"];
const DEFAULT_CAPTURE_LIMIT = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REPORT_LIMIT = 256 * 1024;
const PREVIEW_BYTES = 4096;

export class QualityRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "QualityRuntimeError";
  }
}

const isoNow = () => new Date().toISOString();
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function containedPath(root, target, label) {
  const rootPath = resolve(root);
  const targetPath = resolve(rootPath, target);
  const pathFromRoot = relative(rootPath, targetPath);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new QualityRuntimeError(`${label} resolves outside projectRoot.`);
  }
  return targetPath;
}

function validateConfig(config) {
  if (!isRecord(config)) throw new QualityRuntimeError("Quality configuration must be an object.");
  if (config.schemaVersion !== QUALITY_CONFIG_SCHEMA) throw new QualityRuntimeError(`schemaVersion must equal ${QUALITY_CONFIG_SCHEMA}.`);
  if (typeof config.projectRoot !== "string" || config.projectRoot.length === 0) throw new QualityRuntimeError("projectRoot is required.");
  if (typeof config.artifactDirectory !== "string" || config.artifactDirectory.length === 0) throw new QualityRuntimeError("artifactDirectory is required.");
  if (!Array.isArray(config.suites)) throw new QualityRuntimeError("suites must be an array.");
  const ids = new Set();
  const types = new Set();
  for (const [index, suite] of config.suites.entries()) {
    if (!isRecord(suite)) throw new QualityRuntimeError(`suites[${index}] must be an object.`);
    if (typeof suite.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(suite.id)) throw new QualityRuntimeError(`suites[${index}].id is invalid.`);
    if (ids.has(suite.id)) throw new QualityRuntimeError(`Duplicate suite id ${suite.id}.`);
    ids.add(suite.id);
    if (!REQUIRED_SUITE_TYPES.includes(suite.type)) throw new QualityRuntimeError(`suites[${index}].type is invalid.`);
    if (types.has(suite.type)) throw new QualityRuntimeError(`Only one ${suite.type} suite may be configured.`);
    types.add(suite.type);
    if (suite.command != null) {
      if (!isRecord(suite.command) || typeof suite.command.executable !== "string" || suite.command.executable.length === 0) {
        throw new QualityRuntimeError(`suites[${index}].command.executable is required.`);
      }
      if (!Array.isArray(suite.command.args) || suite.command.args.some((argument) => typeof argument !== "string")) {
        throw new QualityRuntimeError(`suites[${index}].command.args must be a string array.`);
      }
      if (suite.command.env != null && (!isRecord(suite.command.env) || Object.values(suite.command.env).some((value) => typeof value !== "string"))) {
        throw new QualityRuntimeError(`suites[${index}].command.env must contain string values.`);
      }
    }
    if (suite.evidenceFiles != null && (!Array.isArray(suite.evidenceFiles) || suite.evidenceFiles.some((item) => !isRecord(item) || typeof item.kind !== "string" || typeof item.path !== "string"))) {
      throw new QualityRuntimeError(`suites[${index}].evidenceFiles is invalid.`);
    }
    if ((suite.evidenceFiles?.length ?? 0) > 32) throw new QualityRuntimeError(`suites[${index}].evidenceFiles exceeds the limit of 32.`);
  }
  if (config.maxCapturedBytes != null && (!Number.isInteger(config.maxCapturedBytes) || config.maxCapturedBytes < 1024)) {
    throw new QualityRuntimeError("maxCapturedBytes must be an integer of at least 1024.");
  }
  if (config.defaultTimeoutMs != null && (!Number.isInteger(config.defaultTimeoutMs) || config.defaultTimeoutMs <= 0)) {
    throw new QualityRuntimeError("defaultTimeoutMs must be a positive integer.");
  }
  if (config.maxReportBytes != null && (!Number.isInteger(config.maxReportBytes) || config.maxReportBytes < 16_384 || config.maxReportBytes > 1_048_576)) {
    throw new QualityRuntimeError("maxReportBytes must be an integer from 16384 through 1048576.");
  }
}

const preview = (bytes) => ({
  encoding: "utf8",
  text: bytes.subarray(0, PREVIEW_BYTES).toString("utf8"),
  truncated: bytes.length > PREVIEW_BYTES,
});

async function writeStreamArtifact(artifactDirectory, suiteId, streamName, bytes, projectRoot) {
  const filename = `${suiteId}.${streamName}.log`;
  const absolutePath = resolve(artifactDirectory, filename);
  await writeFile(absolutePath, bytes, { flag: "wx" });
  return {
    path: relative(projectRoot, absolutePath),
    sha256: sha256(bytes),
    bytes: bytes.length,
    preview: preview(bytes),
  };
}

async function verifyEvidenceFiles(suite, projectRoot) {
  const evidence = [];
  const issues = [];
  for (const item of suite.evidenceFiles ?? []) {
    try {
      const absolutePath = containedPath(projectRoot, item.path, `Evidence path ${item.path}`);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        issues.push(`${item.kind}:${item.path} is not a regular file`);
        continue;
      }
      const bytes = await readFile(absolutePath);
      const digest = sha256(bytes);
      if (item.sha256 != null && item.sha256 !== digest) {
        issues.push(`${item.kind}:${item.path} SHA-256 mismatch`);
        continue;
      }
      evidence.push({ kind: item.kind, path: item.path, sha256: digest, bytes: bytes.length });
    } catch (error) {
      issues.push(`${item.kind}:${item.path} unavailable (${error && typeof error === "object" && "code" in error ? error.code : "READ_ERROR"})`);
    }
  }
  return { evidence, issues };
}

async function inspectBrowserEvidence(suite, projectRoot, verifiedEvidence, execution) {
  const requiredKinds = ["browser-report", "trace", "screenshot"];
  const kinds = new Set(verifiedEvidence.map((item) => item.kind));
  const missingKinds = requiredKinds.filter((kind) => !kinds.has(kind));
  if (missingKinds.length > 0) {
    return { status: "unmeasured", reason: `Browser evidence is missing: ${missingKinds.join(", ")}.` };
  }
  const reportRef = suite.evidenceFiles.find((item) => item.kind === "browser-report");
  try {
    const bytes = await readFile(containedPath(projectRoot, reportRef.path, "Browser report path"));
    const report = JSON.parse(bytes.toString("utf8"));
    const stringArrays = [report.consoleErrors, report.pageErrors, report.networkFailures];
    const executionStarted = Date.parse(execution.startedAt);
    const executionFinished = Date.parse(execution.finishedAt);
    const reportStarted = Date.parse(report.startedAt);
    const reportFinished = Date.parse(report.finishedAt);
    const verifiedByKind = new Map(verifiedEvidence.map((item) => [item.kind, item]));
    const artifactLinksValid = Array.isArray(report.artifacts) && ["trace", "screenshot"].every((kind) => {
      const link = report.artifacts.find((item) => isRecord(item) && item.kind === kind);
      const verifiedArtifact = verifiedByKind.get(kind);
      return link && verifiedArtifact && link.path === verifiedArtifact.path && link.sha256 === verifiedArtifact.sha256;
    });
    const valid =
      report.schemaVersion === "frontier-browser-evidence/v1" &&
      report.qualityRunId === execution.runId &&
      ["playwright", "webdriver", "other"].includes(report.runner) &&
      typeof report.targetUrl === "string" && report.targetUrl.length > 0 &&
      Number.isFinite(reportStarted) &&
      Number.isFinite(reportFinished) &&
      reportFinished >= reportStarted &&
      reportStarted >= executionStarted &&
      reportFinished <= executionFinished &&
      Array.isArray(report.assertions) && report.assertions.length > 0 &&
      report.assertions.every((assertion) => isRecord(assertion) && ["pass", "fail"].includes(assertion.status)) &&
      stringArrays.every((items) => Array.isArray(items) && items.every((item) => typeof item === "string")) &&
      artifactLinksValid;
    if (!valid) return { status: "unmeasured", reason: "Browser report structure or timestamps are invalid." };
    const failureCount = report.assertions.filter((assertion) => assertion.status === "fail").length + stringArrays.reduce((sum, items) => sum + items.length, 0);
    return failureCount === 0
      ? { status: "pass", reason: "Timestamped browser report, trace, and screenshot contain no recorded failures." }
      : { status: "fail", reason: `Browser evidence recorded ${failureCount} assertion or runtime failures.` };
  } catch (error) {
    return { status: "unmeasured", reason: `Browser report could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function runCommand(suite, config, artifactDirectory, projectRoot, runId) {
  const command = suite.command;
  const startedAt = isoNow();
  const startedNs = process.hrtime.bigint();
  const stdoutChunks = [];
  const stderrChunks = [];
  let capturedBytes = 0;
  let outputLimitExceeded = false;
  let timedOut = false;
  let spawnError = null;
  const captureLimit = config.maxCapturedBytes ?? DEFAULT_CAPTURE_LIMIT;
  const timeoutMs = command.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = containedPath(projectRoot, command.cwd ?? ".", `Working directory for ${suite.id}`);

  const child = spawn(command.executable, command.args, {
    cwd,
    env: {
      ...process.env,
      ...(command.env ?? {}),
      FRONTIER_QUALITY_RUN_ID: runId,
      FRONTIER_QUALITY_SUITE_ID: suite.id,
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let forceKillTimer = null;
  const terminate = () => {
    child.kill("SIGTERM");
    if (!forceKillTimer) {
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      forceKillTimer.unref();
    }
  };
  const capture = (chunks) => (chunk) => {
    const bytes = Buffer.from(chunk);
    chunks.push(bytes);
    capturedBytes += bytes.length;
    if (capturedBytes > captureLimit && !outputLimitExceeded) {
      outputLimitExceeded = true;
      terminate();
    }
  };
  child.stdout.on("data", capture(stdoutChunks));
  child.stderr.on("data", capture(stderrChunks));
  child.on("error", (error) => { spawnError = error; });

  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const outcome = await new Promise((resolveOutcome) => {
    child.on("close", (exitCode, signal) => resolveOutcome({ exitCode, signal }));
  });
  clearTimeout(timeout);
  if (forceKillTimer) clearTimeout(forceKillTimer);

  const finishedAt = isoNow();
  const durationMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks);
  const [stdoutArtifact, stderrArtifact] = await Promise.all([
    writeStreamArtifact(artifactDirectory, suite.id, "stdout", stdout, projectRoot),
    writeStreamArtifact(artifactDirectory, suite.id, "stderr", stderr, projectRoot),
  ]);
  const verified = await verifyEvidenceFiles(suite, projectRoot);

  let status = "pass";
  let reason = "Command exited successfully.";
  if (spawnError) {
    status = "fail";
    reason = `Command could not start: ${spawnError.message}`;
  } else if (timedOut) {
    status = "fail";
    reason = `Command exceeded ${timeoutMs} ms.`;
  } else if (outputLimitExceeded) {
    status = "fail";
    reason = `Command exceeded the ${captureLimit}-byte capture limit.`;
  } else if (outcome.exitCode !== 0) {
    status = "fail";
    reason = `Command exited with code ${String(outcome.exitCode)}${outcome.signal ? ` and signal ${outcome.signal}` : ""}.`;
  } else if (verified.issues.length > 0) {
    status = "unmeasured";
    reason = `Configured evidence failed verification: ${verified.issues.join(" ")}`;
  } else if (suite.type === "browser") {
    const browserEvidence = await inspectBrowserEvidence(suite, projectRoot, verified.evidence, {
      runId,
      startedAt,
      finishedAt,
    });
    status = browserEvidence.status;
    reason = browserEvidence.reason;
  }

  return {
    id: suite.id,
    type: suite.type,
    required: true,
    status,
    reason,
    command: { executable: command.executable, args: [...command.args], cwd: relative(projectRoot, cwd) || "." },
    startedAt,
    finishedAt,
    durationMs: Math.round(durationMs * 1000) / 1000,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    outputLimitExceeded,
    captureComplete: !outputLimitExceeded,
    stdout: stdoutArtifact,
    stderr: stderrArtifact,
    evidence: verified.evidence,
    evidenceIssues: verified.issues,
  };
}

const unmeasuredSuite = (type, reason) => ({
  id: type,
  type,
  required: true,
  status: "unmeasured",
  reason,
  command: null,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  exitCode: null,
  signal: null,
  timedOut: false,
  outputLimitExceeded: false,
  captureComplete: false,
  stdout: null,
  stderr: null,
  evidence: [],
  evidenceIssues: [],
});

export async function runQualityGates(config) {
  validateConfig(config);
  const projectRoot = resolve(config.projectRoot);
  const artifactDirectory = containedPath(projectRoot, config.artifactDirectory, "artifactDirectory");
  await mkdir(artifactDirectory, { recursive: true });
  const runId = `quality-${randomUUID()}`;
  const runArtifactDirectory = resolve(artifactDirectory, runId);
  await mkdir(runArtifactDirectory, { recursive: false });
  const startedAt = isoNow();
  const suiteResults = [];

  for (const type of REQUIRED_SUITE_TYPES) {
    const suite = config.suites.find((item) => item.type === type);
    if (!suite) {
      suiteResults.push(unmeasuredSuite(type, `No ${type} suite is configured.`));
    } else if (!suite.command) {
      suiteResults.push(unmeasuredSuite(type, `${type} runner is not configured.`));
    } else {
      suiteResults.push(await runCommand(suite, config, runArtifactDirectory, projectRoot, runId));
    }
  }

  const finishedAt = isoNow();
  const successful = suiteResults.every((suite) => suite.status === "pass");
  const report = {
    schemaVersion: QUALITY_REPORT_SCHEMA,
    runId,
    startedAt,
    finishedAt,
    status: successful ? "pass" : "fail",
    successful,
    summary: {
      passed: suiteResults.filter((suite) => suite.status === "pass").length,
      failed: suiteResults.filter((suite) => suite.status === "fail").length,
      unmeasured: suiteResults.filter((suite) => suite.status === "unmeasured").length,
      total: suiteResults.length,
    },
    suites: suiteResults,
  };
  const reportLimit = config.maxReportBytes ?? DEFAULT_REPORT_LIMIT;
  let finalReport = report;
  let reportBytes = Buffer.from(`${JSON.stringify(finalReport, null, 2)}\n`);
  if (reportBytes.length > reportLimit) {
    finalReport = {
      schemaVersion: QUALITY_REPORT_SCHEMA,
      runId,
      startedAt,
      finishedAt,
      status: "fail",
      successful: false,
      bounded: true,
      reason: `Full report exceeded the ${reportLimit}-byte report limit; exact command streams remain in hashed sidecars.`,
      summary: report.summary,
      suites: suiteResults.map((suite) => ({
        id: suite.id,
        type: suite.type,
        status: suite.status,
        reason: suite.reason.slice(0, 512),
        startedAt: suite.startedAt,
        finishedAt: suite.finishedAt,
        exitCode: suite.exitCode,
        signal: suite.signal,
        stdout: suite.stdout,
        stderr: suite.stderr,
        evidenceCount: suite.evidence.length,
        evidenceIssueCount: suite.evidenceIssues.length,
      })),
    };
    reportBytes = Buffer.from(`${JSON.stringify(finalReport, null, 2)}\n`);
  }
  if (reportBytes.length > reportLimit) throw new QualityRuntimeError("Unable to produce a report within maxReportBytes.");
  const reportPath = resolve(runArtifactDirectory, "report.json");
  await writeFile(reportPath, reportBytes, { flag: "wx" });
  return {
    report: finalReport,
    reportArtifact: {
      path: relative(projectRoot, reportPath),
      sha256: sha256(reportBytes),
      bytes: reportBytes.length,
    },
  };
}
