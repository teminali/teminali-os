import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [manifestArg, runner] = process.argv.slice(2);
if (!manifestArg || !runner) {
  throw new Error("usage: benchmark:002:score -- MANIFEST RUNNER");
}

const lab = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(manifestArg);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const run = manifest.runs.find((item) => item.id === runner);
if (!run) throw new Error(`unknown runner: ${runner}`);
const target = path.resolve(run.path);
const allowed = new Set(manifest.allowed_changes);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function command(commandName, args, options = {}) {
  return spawnSync(commandName, args, {
    cwd: target,
    encoding: "utf8",
    timeout: 30_000,
    ...options,
  });
}

function nullSeparated(result) {
  if (result.status !== 0) throw new Error(result.stderr || "Git inspection failed");
  return result.stdout.split("\0").filter(Boolean);
}

const ineligibleReasons = [];
const head = command("git", ["rev-parse", "HEAD"]);
if (head.status !== 0 || head.stdout.trim() !== manifest.baseline_commit) {
  ineligibleReasons.push("Git HEAD differs from the frozen baseline");
}

let changedFiles = [];
let status = "";
try {
  const tracked = nullSeparated(command("git", ["diff", "--name-only", "-z", "HEAD", "--"]));
  const untracked = nullSeparated(command("git", ["ls-files", "--others", "--exclude-standard", "-z"]));
  changedFiles = [...new Set([...tracked, ...untracked])].sort();
  const forbidden = changedFiles.filter((file) => !allowed.has(file));
  if (forbidden.length) {
    ineligibleReasons.push(`out-of-scope changes: ${forbidden.join(", ")}`);
  }
  const statusRun = command("git", ["status", "--short", "--untracked-files=all"]);
  status = statusRun.stdout.trim();
} catch (error) {
  ineligibleReasons.push(error.message);
}

for (const [file, expected] of Object.entries(manifest.baseline_files_sha256)) {
  if (allowed.has(file)) continue;
  try {
    const actual = digest(await readFile(path.join(target, file)));
    if (actual !== expected) ineligibleReasons.push(`frozen fixture changed: ${file}`);
  } catch {
    ineligibleReasons.push(`frozen fixture missing: ${file}`);
  }
}

let timingRecord = null;
try {
  const timing = JSON.parse(await readFile(manifest.timing_path, "utf8"));
  timingRecord = timing.runs[runner] ?? null;
} catch {
  timingRecord = null;
}
if (!timingRecord?.stopped_monotonic_ns || !Number.isFinite(timingRecord.elapsed_ms)) {
  ineligibleReasons.push("complete monotonic timing record is missing");
} else if (timingRecord.elapsed_ms > manifest.time_limit_seconds * 1000) {
  ineligibleReasons.push("15-minute run limit exceeded");
}

const eligible = ineligibleReasons.length === 0;
let visible = {
  passed: false,
  points: 0,
  exit_code: null,
  stdout: "",
  stderr: "",
};
let hidden = { checks: [], error: null };

if (eligible) {
  const visibleRun = command("npm", ["test", "--silent"]);
  visible = {
    passed: visibleRun.status === 0,
    points: visibleRun.status === 0 ? 20 : 0,
    exit_code: visibleRun.status,
    stdout: visibleRun.stdout.trim(),
    stderr: visibleRun.stderr.trim(),
  };

  const oracle = path.join(
    lab,
    "benchmarks/codex-sol-ultra-vs-antigravity-gemini37-002/oracle/score.mjs",
  );
  const oracleRun = spawnSync(process.execPath, [oracle, target], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (oracleRun.status === 0) {
    try {
      hidden = JSON.parse(oracleRun.stdout);
      hidden.error = null;
    } catch (error) {
      hidden = { checks: [], error: `oracle JSON parse failed: ${error.message}` };
    }
  } else {
    hidden = {
      checks: [],
      error: oracleRun.stderr.trim() || oracleRun.stdout.trim() || "oracle failed",
    };
  }
}

const hiddenPoints = hidden.checks.reduce(
  (sum, item) => sum + (item.passed ? item.points : 0),
  0,
);
const diff = command("git", [
  "diff",
  "--numstat",
  "HEAD",
  "--",
  ...manifest.allowed_changes,
]);

const result = {
  benchmark: manifest.benchmark,
  runner,
  configuration: {
    product: run.product,
    model: run.model,
    reasoning: run.reasoning,
  },
  preregistration_commit: manifest.preregistration_commit,
  baseline_commit: manifest.baseline_commit,
  eligible,
  ineligible_reasons: ineligibleReasons,
  automated_score: eligible ? visible.points + hiddenPoints : 0,
  total_possible: 100,
  visible,
  hidden,
  changed_files: changedFiles,
  git_status: status,
  production_diff_numstat: diff.stdout.trim().split("\n").filter(Boolean),
  timing: timingRecord,
  telemetry: {
    tokens: null,
    incremental_cost_usd: null,
    provenance: "not exposed by the benchmark harness",
  },
  environment: manifest.environment,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
