/**
 * Releases: checking for one, and cutting one.
 *
 * The studio is developed in itself and shipped from itself, so both halves of
 * that loop live here. Checking is available to anyone running the app;
 * publishing is an administrator action, because it spends the operator's
 * GitHub credentials and puts a binary in front of every other install.
 *
 * GitHub is reached through the `gh` CLI rather than a raw token: the operator
 * has already authenticated it, the credential lives in the OS keychain, and
 * the studio never has to hold one. Every call passes an argument array, never
 * a shell string.
 */

import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const RELEASE_LIMITS = Object.freeze({
  ghTimeoutMs: 20_000,
  publishTimeoutMs: 45 * 60_000,
  maxOutputBytes: 4 * 1024 * 1024,
});

/** `v1.2.3` / `1.2.3-beta.1` → comparable parts. Null when unparseable. */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * -1 / 0 / 1, by semver rules.
 *
 * The prerelease rule is the one worth stating: 1.0.0 is *newer* than
 * 1.0.0-beta.1, so an operator on a release build is never offered a
 * downgrade to a prerelease of the version they already run.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1; // a release beats its own prerelease
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export async function currentVersion(appRoot) {
  if (appRoot) {
    try {
      const manifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
      if (typeof manifest.version === "string") return manifest.version;
    } catch {
      // If appRoot is an asar archive, pure node:fs/promises fails with ENOTDIR.
      // Fall back to reading via @electron/asar if the path involves an asar.
      try {
        if (String(appRoot).includes(".asar")) {
          const asarPath = appRoot.endsWith(".asar")
            ? appRoot
            : join(appRoot, "package.json").split(".asar")[0] + ".asar";
          const { createRequire } = await import("node:module");
          const require = createRequire(import.meta.url);
          const asar = require("@electron/asar");
          const manifest = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
          if (typeof manifest.version === "string") return manifest.version;
        }
      } catch {
        /* asar fallback failed */
      }
      return null;
    }
    return null;
  }

  if (typeof process.env.TEMINALI_APP_VERSION === "string" && process.env.TEMINALI_APP_VERSION.trim()) {
    return process.env.TEMINALI_APP_VERSION.trim().replace(/^v/, "");
  }

  try {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

async function gh(args, timeout = RELEASE_LIMITS.ghTimeoutMs) {
  return run("gh", args, { timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

/**
 * Is there a newer release than the one running?
 *
 * Never throws. "We could not reach GitHub" and "you are up to date" are
 * different answers and the interface renders both, so the failure is returned
 * rather than raised.
 */
export async function checkForUpdate({ appRoot, repo }) {
  const version = await currentVersion(appRoot);

  try {
    const { stdout } = await gh([
      "release", "view",
      "--repo", repo,
      "--json", "tagName,name,publishedAt,url,isDraft,isPrerelease,body",
    ]);
    const release = JSON.parse(stdout);

    // A draft is not released to anybody yet.
    if (release.isDraft) {
      return { version, latest: null, updateAvailable: false, checkedAt: new Date().toISOString(), error: null };
    }

    const comparison = compareVersions(release.tagName, version);
    return {
      version,
      latest: {
        tag: release.tagName,
        name: release.name ?? release.tagName,
        publishedAt: release.publishedAt ?? null,
        url: release.url ?? null,
        prerelease: Boolean(release.isPrerelease),
        notes: typeof release.body === "string" ? release.body.slice(0, 8_000) : "",
      },
      updateAvailable: comparison > 0,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? "");
    return {
      version,
      latest: null,
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
      error: /release not found|no releases/i.test(message)
        ? "This repository has no releases yet."
        : /gh: command not found|ENOENT/i.test(message)
          ? "The GitHub CLI is not installed, so updates cannot be checked."
          : "GitHub could not be reached.",
    };
  }
}

/** Refuses a version that is not strictly ahead of what is running. */
export async function validateNextVersion(appRoot, next) {
  if (!parseVersion(next)) throw new Error("INVALID_VERSION");
  const version = await currentVersion(appRoot);
  if (version && compareVersions(next, version) <= 0) throw new Error("VERSION_NOT_AHEAD");
  return next.replace(/^v/, "");
}

/**
 * Cuts a release: verify, build, publish.
 *
 * Ordered so nothing reaches GitHub that has not passed the same gate the
 * operator would run by hand. A failing step ends the run — publishing a build
 * whose tests did not pass is precisely the thing a release process exists to
 * prevent.
 *
 * Streams each step so the operator watches a real build rather than a spinner.
 */
/**
 * Writes the version into package.json, and hands back an undo.
 *
 * electron-builder reads the version from package.json and from nowhere else,
 * so a release that only *validated* the new version built the old one — which
 * then either collided with an existing tag or silently republished what was
 * already out. The undo matters as much as the write: a failed build must not
 * leave the working tree claiming a version that was never released.
 */
export async function applyVersion(appRoot, version) {
  const files = ["package.json", "package-lock.json"];
  const originals = [];

  for (const name of files) {
    const path = join(appRoot, name);
    try {
      originals.push({ path, text: await readFile(path, "utf8") });
    } catch {
      // The lockfile may legitimately be absent; the manifest may not, and its
      // absence will surface as a parse failure below.
    }
  }
  const manifestEntry = originals.find((entry) => entry.path.endsWith("package.json"));
  if (!manifestEntry) throw new Error("package.json could not be read.");

  const previous = JSON.parse(manifestEntry.text).version;
  const restore = async () => {
    for (const entry of originals) await writeFile(entry.path, entry.text, "utf8");
  };
  if (previous === version) return { previous, restore: async () => {} };

  for (const entry of originals) {
    // Re-serialised rather than string-replaced: a regex over JSON would also
    // match a dependency that happened to be pinned to the same version. The
    // lockfile carries the version twice — at the root and under packages[""] —
    // and `npm ci` fails if either disagrees with the manifest.
    const parsed = JSON.parse(entry.text);
    parsed.version = version;
    if (parsed.packages && parsed.packages[""]) parsed.packages[""].version = version;
    await writeFile(entry.path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
  return { previous, restore };
}

/* ── Git and GitHub, as argument arrays ──────────────────────────────────── */

async function git(appRoot, args, { trim = true } = {}) {
  const { stdout } = await run("git", ["-C", appRoot, ...args], {
    timeout: RELEASE_LIMITS.ghTimeoutMs,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  // Trimmed by default because almost every caller wants one value and not the
  // newline after it. `--porcelain` is the exception, and it is a sharp one:
  // see the status call in preflight.
  return trim ? stdout.trim() : stdout;
}

/**
 * Everything that must be true before a tag is pushed.
 *
 * A release ships what is *committed*. Anything sitting uncommitted in the
 * working tree is not in it, and the two ways to get that wrong are both bad:
 * sweeping the operator's half-finished work into a release, or cutting one
 * that silently omits the fix they just wrote. So a dirty tree stops the run
 * and says which files.
 */
export async function preflight(appRoot, version, repo) {
  const tag = `v${version}`;

  const root = await git(appRoot, ["rev-parse", "--show-toplevel"]);
  const branch = await git(appRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") throw new Error("The repository is in a detached HEAD state; check out a branch first.");

  // The version files are about to be rewritten by this very run, so a
  // pending edit to them is expected rather than a reason to stop.
  // Deliberately untrimmed. `--porcelain` writes two status columns and a space
  // before each path, and the first column is a space for the ordinary case of
  // an unstaged edit. Trimming the output eats that leading space, so the first
  // line — and only the first — loses a character off its path: package.json
  // arrives as "ackage.json", which the exemption below then fails to
  // recognise, and the release is refused over its own pending version bump.
  const dirty = (await git(appRoot, ["status", "--porcelain"], { trim: false }))
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .filter((path) => !/(^|\/)package(-lock)?\.json$/.test(path));
  if (dirty.length > 0) {
    throw new Error(
      `The working tree has ${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"} `
      + `(${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? ", …" : ""}). `
      + "A release ships what is committed — commit or stash first.",
    );
  }

  const localTag = await git(appRoot, ["tag", "--list", tag]);
  if (localTag) throw new Error(`Tag ${tag} already exists locally.`);
  const remoteTag = await git(appRoot, ["ls-remote", "--tags", "origin", tag]);
  if (remoteTag) throw new Error(`Tag ${tag} already exists on the remote.`);

  try {
    await gh(["release", "view", tag, "--repo", repo]);
    throw new Error(`Release ${tag} already exists on GitHub.`);
  } catch (error) {
    // "release not found" is the answer we want; anything else is real.
    if (!/release not found|Not Found|no releases/i.test(String(error?.stderr ?? error?.message ?? ""))) {
      if (String(error?.message ?? "").startsWith("Release ")) throw error;
    }
  }

  return { root, branch, tag };
}

/**
 * Finds the workflow run this tag started, then waits for it.
 *
 * Pushing a tag is not releasing. Reporting success the moment the push
 * returns would claim a release that CI may still be about to fail, which is
 * exactly the kind of thing an operator finds out about from a user.
 */
async function watchWorkflow({ repo, tag, onEvent, signal }) {
  const deadline = Date.now() + RELEASE_LIMITS.publishTimeoutMs;
  let runId = null;

  while (!runId && Date.now() < deadline) {
    if (signal?.aborted) throw new Error("The release was cancelled.");
    try {
      const { stdout } = await gh([
        "run", "list", "--repo", repo, "--workflow", "release.yml",
        "--limit", "15", "--json", "databaseId,headBranch,event",
      ]);
      const found = JSON.parse(stdout).find((entry) => entry.headBranch === tag && entry.event === "push");
      if (found) runId = found.databaseId;
    } catch {
      /* The run has not been registered yet. */
    }
    if (!runId) await new Promise((done) => setTimeout(done, 5_000));
  }
  if (!runId) throw new Error("No workflow run appeared for this tag. Check Actions on GitHub.");

  onEvent({ type: "output", id: "ci", kind: "stdout", text: `Watching https://github.com/${repo}/actions/runs/${runId}\n` });

  const seen = new Map();
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("The release was cancelled.");
    const { stdout } = await gh(["run", "view", String(runId), "--repo", repo, "--json", "status,conclusion,jobs"]);
    const view = JSON.parse(stdout);

    // Each job is reported once, as it settles, so the log reads as progress
    // rather than as the same four lines repeated.
    for (const job of view.jobs ?? []) {
      if (job.conclusion && seen.get(job.name) !== job.conclusion) {
        seen.set(job.name, job.conclusion);
        onEvent({ type: "output", id: "ci", kind: job.conclusion === "success" ? "stdout" : "stderr", text: `${job.name}: ${job.conclusion}\n` });
      }
    }

    if (view.status === "completed") {
      if (view.conclusion !== "success") throw new Error(`The release build finished ${view.conclusion}.`);
      return runId;
    }
    await new Promise((done) => setTimeout(done, 10_000));
  }
  throw new Error("The release build did not finish in time.");
}

/**
 * Cuts a release.
 *
 * Two very different things behind one function, and the split is the point.
 *
 * A **dry run** is a rehearsal on the machine in front of you: the same checks
 * an operator would run by hand, then a real macOS package that is never
 * published. Nothing leaves the machine and the working tree is left exactly as
 * it was found.
 *
 * A **publish** does not build anything locally at all. It verifies, then bumps
 * the version, commits, tags and pushes — and GitHub Actions builds macOS,
 * Windows and Linux on their own runners and publishes one release from them
 * (.github/workflows/release.yml). Building here and publishing from here as
 * well would mean two things writing to the same release, and the local machine
 * can only honestly produce one of the three platforms anyway: packaging an
 * NSIS installer from macOS needs wine.
 *
 * The run does not finish when the tag is pushed. Pushing a tag is not
 * releasing, and reporting success there would claim a release that CI may
 * still be about to fail — so it waits for the build and reports what each
 * platform actually did.
 */
export function publishRelease({ appRoot, version, notes = "", repo, dryRun = false, onEvent, signal }) {
  return new Promise(async (resolvePromise) => {
    const startedAt = Date.now();
    const completed = [];

    let versionChange = null;
    let committed = false;
    const finish = async (ok) => {
      // Restore the version only while it is still just a file edit. Once it is
      // committed, rewriting the file would leave the commit and the tree
      // disagreeing, which is worse than a bumped version sitting in a branch.
      if (versionChange && !committed && (!ok || dryRun)) await versionChange.restore();
      resolvePromise({ ok, completed, durationMs: Date.now() - startedAt });
    };

    /** Runs one step, whatever it is, and records how it went. */
    const step = async (id, label, body) => {
      if (signal?.aborted) throw new Error("The release was cancelled.");
      onEvent({ type: "step", id, label, status: "running" });
      const stepStarted = Date.now();
      try {
        await body();
      } catch (error) {
        completed.push({ id, ok: false, durationMs: Date.now() - stepStarted });
        onEvent({
          type: "step", id, label, status: "failed",
          durationMs: Date.now() - stepStarted,
          detail: error?.message ?? String(error),
        });
        throw error;
      }
      completed.push({ id, ok: true, durationMs: Date.now() - stepStarted });
      onEvent({ type: "step", id, label, status: "passed", durationMs: Date.now() - stepStarted });
    };

    /** A child process, streamed. Arguments as an array, never a shell string. */
    const command = (id, cmd, args, env = process.env) =>
      new Promise((done, fail) => {
        const child = spawn(cmd, args, { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"] });
        let bytes = 0;
        const forward = (stream, kind) => {
          stream.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > RELEASE_LIMITS.maxOutputBytes) return;
            onEvent({ type: "output", id, kind, text: chunk.toString("utf8") });
          });
        };
        forward(child.stdout, "stdout");
        forward(child.stderr, "stderr");

        const timer = setTimeout(() => child.kill("SIGKILL"), RELEASE_LIMITS.publishTimeoutMs);
        const onAbort = () => child.kill("SIGTERM");
        signal?.addEventListener("abort", onAbort, { once: true });
        const settle = (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          error ? fail(error) : done();
        };
        child.on("error", (error) => settle(new Error(error?.message ?? "could not start")));
        child.on("close", (code) => settle(code === 0 ? null : new Error(`exited with status ${code}`)));
      });

    try {
      /* The same three checks an operator would run by hand, first and locally,
         because a failure here should cost seconds rather than a CI round trip. */
      await step("typecheck", "Typecheck", () => command("typecheck", "npm", ["run", "typecheck"]));
      await step("test", "Tests", () => command("test", "npm", ["test"]));
      await step("build", "Build web assets", () => command("build", "npm", ["run", "build"]));

      if (dryRun) {
        // After the checks, not before them: a failing test should not leave a
        // rewritten manifest behind, and the package that follows must carry
        // the new version because electron-builder reads it from nowhere else.
        versionChange = await applyVersion(appRoot, version);
        onEvent({ type: "output", id: "version", kind: "stdout", text: `Version ${versionChange.previous} -> ${version}\n` });
        await step("publish", "Package (dry run)", () =>
          command("publish", "npx", ["electron-builder", "--mac", "--publish", "never"]));
        onEvent({ type: "done", ok: true, version, dryRun, notes: notes.slice(0, 2_000) });
        await finish(true);
        return;
      }

      let plan;
      await step("preflight", "Check the repository", async () => {
        const token = await gh(["auth", "token"]).then((r) => r.stdout.trim()).catch(() => "");
        if (!token) throw new Error("`gh auth token` returned nothing; run `gh auth login` first.");
        plan = await preflight(appRoot, version, repo);
      });

      await step("tag", `Tag and push v${version}`, async () => {
        versionChange = await applyVersion(appRoot, version);
        onEvent({ type: "output", id: "tag", kind: "stdout", text: `Version ${versionChange.previous} -> ${version}\n` });
        await git(appRoot, ["add", "package.json", "package-lock.json"]);
        await git(appRoot, ["commit", "-m", `release: v${version}`]);
        committed = true;
        await git(appRoot, ["tag", "-a", `v${version}`, "-m", `Teminali Code ${version}`]);
        await git(appRoot, ["push", "origin", plan.branch]);
        await git(appRoot, ["push", "origin", `v${version}`]);
        onEvent({ type: "output", id: "tag", kind: "stdout", text: `Pushed ${plan.branch} and v${version}\n` });
      });

      await step("ci", "Build every platform on GitHub", () =>
        watchWorkflow({ repo, tag: `v${version}`, onEvent, signal }));

      /* The notes field used to collect text that went nowhere. This is where
         it lands — after CI has created the release to attach it to. */
      if (notes.trim()) {
        await step("notes", "Write the release notes", () =>
          command("notes", "gh", [
            "release", "edit", `v${version}`, "--repo", repo,
            "--title", `Teminali Code ${version}`,
            "--notes", notes.slice(0, 20_000),
          ]));
      }

      onEvent({ type: "done", ok: true, version, dryRun, notes: notes.slice(0, 2_000) });
      await finish(true);
    } catch (error) {
      const message = error?.message ?? String(error);
      onEvent({
        type: "error",
        code: /cancelled/i.test(message) ? "ABORTED" : "STEP_FAILED",
        message: committed
          ? `${message} The version bump is committed on ${"the current branch"}; the tag may need removing before retrying.`
          : message,
      });
      await finish(false);
    }
  });
}
