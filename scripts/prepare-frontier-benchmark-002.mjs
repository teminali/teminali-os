import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const lab = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const benchmarkRelative = "benchmarks/codex-sol-ultra-vs-antigravity-gemini37-002";
const benchmark = path.join(lab, benchmarkRelative);

function git(args, cwd, env = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function collectFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".git" || entry.name === "results") continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

async function hashFiles(root, files, prefix = "") {
  const hashes = {};
  for (const file of files) {
    hashes[path.posix.join(prefix, file.split(path.sep).join(path.posix.sep))] =
      digest(await readFile(path.join(root, file)));
  }
  return hashes;
}

const labStatus = git(["status", "--porcelain"], lab);
if (labStatus) {
  throw new Error("opencode-agent-lab must be clean before preparing frozen runs");
}
const preregistrationCommit = git(["rev-parse", "HEAD"], lab);

const root = await mkdtemp(path.join(tmpdir(), "frontier-benchmark-002-"));
const baseline = path.join(root, "baseline");
await cp(path.join(benchmark, "seed"), baseline, { recursive: true });
await cp(path.join(benchmark, "TASK.md"), path.join(baseline, "TASK.md"));

git(["init", "--quiet"], baseline);
git(["config", "user.name", "Frontier Benchmark"], baseline);
git(["config", "user.email", "benchmark@local.invalid"], baseline);
git(["add", "."], baseline);
const fixedDate = "2026-08-30T00:00:00Z";
git(["commit", "--quiet", "-m", "Frozen benchmark 002 seed"], baseline, {
  GIT_AUTHOR_DATE: fixedDate,
  GIT_COMMITTER_DATE: fixedDate,
});
const baselineCommit = git(["rev-parse", "HEAD"], baseline);

const runDefinitions = [
  {
    id: "codex-1",
    directory: "codex-gpt56-sol-ultra",
    product: "Codex",
    model: "GPT-5.6 Sol",
    reasoning: "Ultra",
  },
  {
    id: "antigravity-1",
    directory: "antigravity-gemini37-flash-medium",
    product: "Antigravity",
    model: "Gemini 3.7 Flash",
    reasoning: "Medium",
  },
];

const runs = [];
for (const definition of runDefinitions) {
  const target = path.join(root, definition.directory);
  await cp(baseline, target, { recursive: true });
  runs.push({
    ...definition,
    path: target,
    prompt: path.join(target, "TASK.md"),
  });
}

const benchmarkFiles = await collectFiles(benchmark);
const frozenInputs = await hashFiles(
  benchmark,
  benchmarkFiles,
  benchmarkRelative,
);
const scriptNames = [
  "benchmark-002-clock.mjs",
  "prepare-frontier-benchmark-002.mjs",
  "score-frontier-benchmark-002.mjs",
];
Object.assign(
  frozenInputs,
  await hashFiles(path.join(lab, "scripts"), scriptNames, "scripts"),
);

const baselineFiles = await collectFiles(baseline);
const baselineHashes = await hashFiles(baseline, baselineFiles);
const manifestPath = path.join(root, "manifest.json");
const timingPath = path.join(root, "timing.json");
const manifest = {
  benchmark: "frontier-code-agents-002-keyed-delivery-dispatcher",
  preregistration_commit: preregistrationCommit,
  baseline_commit: baselineCommit,
  created_at: new Date().toISOString(),
  time_limit_seconds: 900,
  run_order: runs.map((run) => run.id),
  runs,
  allowed_changes: [
    "src/idempotency-registry.js",
    "src/keyed-queue.js",
    "src/reliable-dispatcher.js",
  ],
  baseline_files_sha256: baselineHashes,
  frozen_inputs_sha256: frozenInputs,
  timing_path: timingPath,
  environment: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
  },
  manifest_path: manifestPath,
};

await writeFile(timingPath, `${JSON.stringify({
  benchmark: manifest.benchmark,
  runs: {},
}, null, 2)}\n`);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
