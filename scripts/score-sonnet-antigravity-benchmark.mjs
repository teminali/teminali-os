import { spawnSync } from "node:child_process";
import path from "node:path";

const [targetArg, runner = "unknown", elapsedArg = "0"] = process.argv.slice(2);
if (!targetArg) throw new Error("usage: benchmark:score -- TARGET RUNNER ELAPSED_SECONDS");
const target = path.resolve(targetArg);
const elapsedSeconds = Number(elapsedArg);
if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
  throw new Error("elapsed seconds must be non-negative");
}
const lab = path.resolve(new URL("..", import.meta.url).pathname);
const oracle = path.join(
  lab,
  "benchmarks/sonnet5-vs-antigravity-gemini37/oracle/score.mjs",
);

const visible = spawnSync("npm", ["test", "--silent"], {
  cwd: target,
  encoding: "utf8",
});
const oracleRun = spawnSync(process.execPath, [oracle, target], { encoding: "utf8" });
if (oracleRun.status !== 0) throw new Error(oracleRun.stderr || "oracle failed");
const oracleResult = JSON.parse(oracleRun.stdout);
const automated =
  (visible.status === 0 ? 20 : 0) +
  oracleResult.checks.reduce((sum, item) => sum + item.points, 0) +
  (oracleResult.integrity ? 10 : 0);
const diff = spawnSync("git", ["diff", "--numstat"], {
  cwd: target,
  encoding: "utf8",
});

process.stdout.write(
  `${JSON.stringify(
    {
      benchmark: "sonnet5-vs-antigravity-gemini37-001",
      runner,
      elapsed_seconds: elapsedSeconds,
      automated_score: automated,
      manual_score_pending: 10,
      total_possible: 100,
      visible_tests_passed: visible.status === 0,
      hidden_checks: oracleResult.checks,
      fixture_integrity: oracleResult.integrity,
      production_diff_numstat: diff.stdout.trim().split("\n").filter(Boolean),
    },
    null,
    2,
  )}\n`,
);
