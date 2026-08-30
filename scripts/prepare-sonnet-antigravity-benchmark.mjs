import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const lab = path.resolve(new URL("..", import.meta.url).pathname);
const benchmark = path.join(lab, "benchmarks/sonnet5-vs-antigravity-gemini37");
const root = await mkdtemp(path.join(tmpdir(), "frontier-benchmark-001-"));
const baseline = path.join(root, "baseline");
await cp(path.join(benchmark, "seed"), baseline, { recursive: true });
await cp(path.join(benchmark, "TASK.md"), path.join(baseline, "TASK.md"));

function git(args, cwd, env = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

git(["init", "--quiet"], baseline);
git(["config", "user.name", "Frontier Benchmark"], baseline);
git(["config", "user.email", "benchmark@local.invalid"], baseline);
git(["add", "."], baseline);
const fixedDate = "2026-08-30T00:00:00Z";
git(["commit", "--quiet", "-m", "Frozen benchmark 001 seed"], baseline, {
  GIT_AUTHOR_DATE: fixedDate,
  GIT_COMMITTER_DATE: fixedDate,
});
const commit = git(["rev-parse", "HEAD"], baseline);

const opencodeRun = path.join(root, "opencode-sonnet5");
const antigravityRun = path.join(root, "antigravity-gemini37");
await cp(baseline, opencodeRun, { recursive: true });
await cp(baseline, antigravityRun, { recursive: true });

const manifest = {
  benchmark: "sonnet5-vs-antigravity-gemini37-001",
  baseline_commit: commit,
  opencode_run: opencodeRun,
  antigravity_run: antigravityRun,
  prompt: path.join(benchmark, "TASK.md"),
  time_limit_minutes: 20,
};
await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
