/**
 * Isolated sandboxes for a head-to-head benchmark run.
 *
 * Two coding agents cannot be compared on the same working tree: they would
 * read each other's half-finished edits, collide on the same files, and the
 * loser would be whichever happened to run second. Each contestant therefore
 * gets a private copy of the project to work in, and the comparison is what
 * each of them did to their own copy.
 *
 * The copy is of the *current working tree*, not of HEAD. A benchmark against a
 * checkout that is 165 files behind what you are actually editing measures the
 * wrong codebase. Only the files git considers part of the project are copied —
 * tracked plus untracked-but-not-ignored — which on this repository is about
 * 3 MB, so a sandbox costs well under a second.
 *
 * `node_modules` is symlinked rather than copied. Without it a contestant
 * cannot run the test suite or the typechecker, and those are the strongest
 * signals in the whole benchmark. The trade is that the two contestants share
 * one dependency tree: if one installs a package the other sees it. That is
 * recorded in the run's metadata rather than pretended away.
 *
 * Each sandbox is its own git repository with a baseline commit, so `git diff`
 * inside it is exactly and only what that contestant changed. Deliberately not
 * a `git worktree` of the real repo: a worktree writes bookkeeping into the
 * operator's `.git`, and an agent running loose inside one can damage the real
 * repository. A fresh `git init` cannot reach it.
 */

import { execFile, spawn } from "node:child_process";
import { appendFile, cp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Sandboxes live here, under the workspace, so existing cwd bounds apply. */
export const ARENA_DIRECTORY = ".frontier-arena";

export const ARENA_LIMITS = Object.freeze({
  maxFiles: 20_000,
  copyTimeoutMs: 120_000,
  gitTimeoutMs: 60_000,
  verifyTimeoutMs: 10 * 60_000,
  maxDiffBytes: 512 * 1024,
});

/** A run id we are willing to turn into a directory name. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function assertId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`INVALID_${label}`);
  return value;
}

/**
 * The absolute path of a sandbox, proven to be inside the arena directory.
 *
 * Every destructive operation goes through this. A benchmark deletes
 * directories, and the one thing it must never do is delete something outside
 * the space it created.
 */
export function sandboxPath(root, runId, contestantId) {
  assertId(runId, "RUN_ID");
  assertId(contestantId, "CONTESTANT_ID");
  const workspaceRoot = resolve(root);
  const arena = join(workspaceRoot, ARENA_DIRECTORY);
  const path = join(arena, runId, contestantId);
  if (!path.startsWith(`${arena}${sep}`)) throw new Error("ARENA_PATH_ESCAPE");
  return { path, arena, relative: relative(workspaceRoot, path).split(sep).join("/") };
}

async function git(args, cwd, timeout = ARENA_LIMITS.gitTimeoutMs) {
  return run("git", args, { cwd, timeout, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/** The tail of a stream, bounded, because a test suite can print megabytes. */
function appendTail(current, chunk, max = 8_000) {
  const next = current + chunk;
  return next.length <= max ? next : next.slice(-max);
}

/**
 * Runs one verification command in a sandbox, and can genuinely stop it.
 *
 * Deliberately `spawn` with `detached` rather than `execFile` with a signal.
 * A check is `npm test`, which is a shell, which is npm, which is node: killing
 * only the process we started leaves that whole tree running — verified, not
 * assumed — in a directory the benchmark is about to delete. `detached` makes
 * the shell a process-group leader so the negative pid kills everything it
 * spawned, which is what "Stop" has to mean when the thing being stopped is a
 * test suite.
 */
function runCheck(command, cwd, { timeoutMs, signal }) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let halted = null;

    const stop = (reason) => {
      halted = halted ?? reason;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => stop("timed out"), timeoutMs);
    const onAbort = () => stop("stopped");
    signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (passed, extra = "") => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ passed, output: `${stdout}${stderr}${extra}`.slice(-4_000), halted });
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk.toString());
    });
    child.on("error", (error) => settle(false, `\n${error.message}`));
    child.on("close", (code) => {
      // A check that was killed did not fail on its merits, and the reason has
      // to travel with it or the operator reads a red cross as a real result.
      settle(code === 0 && !halted, halted ? `\n(the check was ${halted})` : "");
    });
  });
}

/** Tracked plus untracked-not-ignored: what git considers the project. */
async function projectFiles(root) {
  const [tracked, untracked] = await Promise.all([
    git(["ls-files", "-z"], root),
    git(["ls-files", "--others", "--exclude-standard", "-z"], root),
  ]);
  const names = [...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean);
  if (names.length > ARENA_LIMITS.maxFiles) throw new Error("ARENA_WORKSPACE_TOO_LARGE");
  return names;
}

/**
 * Builds one contestant's sandbox and returns where it is.
 *
 * Idempotent per (runId, contestantId): an existing sandbox is removed first,
 * so a re-run never inherits the previous contestant's edits.
 */
export async function createSandbox({ root, runId, contestantId, linkModules = true }) {
  const workspaceRoot = resolve(root);
  const { path, relative: relativePath } = sandboxPath(workspaceRoot, runId, contestantId);

  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });

  const files = await projectFiles(workspaceRoot);
  let copied = 0;
  for (const name of files) {
    // A sandbox never contains the arena itself; nesting one run inside another
    // is how a benchmark ends up copying its own output.
    if (name === ARENA_DIRECTORY || name.startsWith(`${ARENA_DIRECTORY}/`)) continue;
    const source = join(workspaceRoot, name);
    if (!existsSync(source)) continue; // deleted-but-still-tracked
    const target = join(path, name);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { dereference: false });
    copied += 1;
  }

  // Dependencies are shared, not duplicated — see the note at the top.
  const linked = [];
  if (linkModules) {
    for (const name of files) {
      const parts = name.split("/");
      parts.pop();
      const directory = parts.join("/");
      const candidate = directory ? join(workspaceRoot, directory, "node_modules") : join(workspaceRoot, "node_modules");
      const key = directory || ".";
      if (linked.includes(key) || !existsSync(candidate)) continue;
      linked.push(key);
      const destination = directory ? join(path, directory, "node_modules") : join(path, "node_modules");
      await mkdir(dirname(destination), { recursive: true });
      await symlink(candidate, destination, "dir").catch(() => {});
    }
  }

  // A private repository, so `git diff` here is this contestant's work alone.
  await git(["init", "--quiet"], path);
  await git(["config", "user.email", "arena@teminali.local"], path);
  await git(["config", "user.name", "Teminali Arena"], path);
  await writeFile(join(path, ".git", "info", "exclude"), "node_modules/\n", "utf8").catch(() => {});
  await git(["add", "-A"], path);
  await git(["commit", "--quiet", "--allow-empty", "-m", "arena baseline"], path);

  return { path, relativePath, filesCopied: copied, moduleLinks: linked, sharedModules: linkModules && linked.length > 0 };
}

/**
 * What the contestant did, measured rather than described.
 *
 * The diff comes from the sandbox's own git, so it is the ground truth for
 * "what changed" no matter what the agent claimed in its transcript — an agent
 * that says it edited a file and did not is exactly what this catches.
 *
 * `onEvent` is what makes this watchable. The diff is known in milliseconds but
 * the checks after it are a typecheck and a test suite — tens of seconds each,
 * during which a caller with no events has nothing to show but a spinner. Each
 * stage is announced as it starts and again as it lands, so the panel can say
 * *which* check is running rather than that something is. The return value is
 * unchanged, so a caller that wants one blob at the end still gets one.
 */
export async function measureSandbox({ root, runId, contestantId, verify = [], onEvent, signal }) {
  const { path } = sandboxPath(root, runId, contestantId);
  const emit = typeof onEvent === "function" ? onEvent : () => {};

  await git(["add", "-A"], path);
  const [numstat, patch, names] = await Promise.all([
    git(["diff", "--cached", "--numstat"], path),
    git(["diff", "--cached"], path),
    git(["diff", "--cached", "--name-status"], path),
  ]);

  let added = 0;
  let removed = 0;
  for (const line of numstat.stdout.split("\n").filter(Boolean)) {
    const [a, r] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }

  const files = names.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, path: rest.join("\t") };
    });

  const truncated = patch.stdout.length > ARENA_LIMITS.maxDiffBytes;

  const diff = {
    filesChanged: files.length,
    linesAdded: added,
    linesRemoved: removed,
    files,
    diff: truncated ? `${patch.stdout.slice(0, ARENA_LIMITS.maxDiffBytes)}\n… diff truncated …` : patch.stdout,
    diffTruncated: truncated,
  };
  // The counts are known now; the checks below are the slow part. Announcing
  // the diff here is what lets a watcher see "3 files, +40/-12" while the test
  // suite is still running.
  emit({ type: "diff", ...diff });

  // Verification runs in the sandbox, so a contestant that broke the build is
  // caught by the build rather than by an opinion about the build.
  const checks = [];
  for (const check of verify) {
    if (typeof check?.command !== "string" || !check.command.trim()) continue;
    if (signal?.aborted) break;
    const name = check.name ?? check.command;
    const startedAt = Date.now();
    emit({ type: "check-start", name, command: check.command });

    // The tail is where a test runner puts its summary.
    const outcome = await runCheck(check.command, path, {
      timeoutMs: ARENA_LIMITS.verifyTimeoutMs,
      signal,
    });
    const settled = {
      name,
      command: check.command,
      passed: outcome.passed,
      durationMs: Date.now() - startedAt,
      output: outcome.output,
    };
    checks.push(settled);
    emit({ type: "check", ...settled });
  }

  return { ...diff, checks };
}

/** Removes a whole run. Only ever inside the arena directory. */
export async function removeRun(root, runId) {
  assertId(runId, "RUN_ID");
  const workspaceRoot = resolve(root);
  const arena = join(workspaceRoot, ARENA_DIRECTORY);
  const target = join(arena, runId);
  if (!target.startsWith(`${arena}${sep}`)) throw new Error("ARENA_PATH_ESCAPE");
  await rm(target, { recursive: true, force: true });
  return { removed: true };
}

/* ── Run history ──────────────────────────────────────────────────────────── */

/**
 * Every benchmark that has been run, appended one line at a time.
 *
 * Append-only for the same reason the usage ledger is: two runs finishing
 * together cannot lose one another, and every question the panel asks is
 * answerable by reading the lines back.
 *
 * Diffs are deliberately *not* stored. A run's diffs are megabytes and the
 * sandboxes they came from are deleted when the run ends, so keeping them would
 * bloat the file with something that can never be re-applied. What is kept is
 * what a comparison over time needs: the task, who ran, what was measured, and
 * what the watcher concluded.
 */
const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_KEEP = 500;

export async function appendRun(path, run) {
  try {
    await mkdir(dirname(path), { recursive: true });
    const record = {
      at: new Date().toISOString(),
      runId: typeof run?.runId === "string" ? run.runId.slice(0, 64) : null,
      task: typeof run?.task === "string" ? run.task.slice(0, 2_000) : "",
      watcher: typeof run?.watcher === "string" ? run.watcher : null,
      selfGraded: Boolean(run?.selfGraded),
      winner: typeof run?.winner === "string" ? run.winner : null,
      summary: typeof run?.summary === "string" ? run.summary.slice(0, 2_000) : "",
      improvements: Array.isArray(run?.improvements)
        ? run.improvements.filter((entry) => typeof entry === "string").slice(0, 10)
        : [],
      contestants: Array.isArray(run?.contestants)
        ? run.contestants.slice(0, 4).map((entry) => ({
            id: String(entry?.id ?? "").slice(0, 64),
            label: String(entry?.label ?? "").slice(0, 120),
            kind: String(entry?.kind ?? "").slice(0, 32),
            model: entry?.model == null ? null : String(entry.model).slice(0, 120),
            completed: Boolean(entry?.completed),
            filesChanged: Number(entry?.filesChanged) || 0,
            linesAdded: Number(entry?.linesAdded) || 0,
            linesRemoved: Number(entry?.linesRemoved) || 0,
            toolCalls: Number(entry?.toolCalls) || 0,
            durationMs: Number(entry?.durationMs) || 0,
            tokens: Number(entry?.tokens) || 0,
            // Null and zero mean different things; preserve the distinction.
            costUsd: typeof entry?.costUsd === "number" ? entry.costUsd : null,
            checks: Array.isArray(entry?.checks)
              ? entry.checks.slice(0, 6).map((c) => ({ name: String(c?.name ?? "").slice(0, 60), passed: Boolean(c?.passed) }))
              : [],
          }))
        : [],
    };
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");

    const info = await stat(path);
    if (info.size > HISTORY_MAX_BYTES) {
      const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
      await writeFile(path, `${lines.slice(-HISTORY_KEEP).join("\n")}\n`, "utf8");
    }
    return record;
  } catch {
    // Losing a history entry must never fail the run that produced it.
    return null;
  }
}

export async function readRuns(path, limit = 50) {
  try {
    const text = await readFile(path, "utf8");
    const runs = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        runs.push(JSON.parse(line));
      } catch {
        // One corrupt line must not discard the rest of the history.
      }
    }
    return runs.slice(-limit).reverse(); // newest first
  } catch {
    return [];
  }
}
