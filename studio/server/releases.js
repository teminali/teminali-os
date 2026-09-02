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
  try {
    const manifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
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
async function applyVersion(appRoot, version) {
  const manifestPath = join(appRoot, "package.json");
  const original = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  const previous = manifest.version;
  if (previous === version) return { previous, restore: async () => {} };

  manifest.version = version;
  // Re-serialised rather than string-replaced: a regex over JSON would also
  // match a dependency that happened to be pinned to the same version.
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    previous,
    restore: async () => {
      await writeFile(manifestPath, original, "utf8");
    },
  };
}

export function publishRelease({ appRoot, version, notes = "", dryRun = false, onEvent, signal }) {
  const steps = [
    { id: "typecheck", label: "Typecheck", command: "npm", args: ["run", "typecheck"] },
    { id: "test", label: "Tests", command: "npm", args: ["test"] },
    { id: "build", label: "Build web assets", command: "npm", args: ["run", "build"] },
    // electron-builder reads publish config from electron-builder.yml and needs
    // a token; gh's is reused so the studio never stores one of its own.
    {
      id: "publish",
      label: dryRun ? "Package (dry run)" : "Package and publish to GitHub",
      command: "npx",
      // macOS only, deliberately. Windows needs wine to package from a Mac and
      // Linux is unreliable from one; both are built by GitHub Actions on their
      // own runners (.github/workflows/release.yml). This path is what an
      // administrator uses to verify a build on the machine in front of them.
      args: dryRun
        ? ["electron-builder", "--mac", "--publish", "never"]
        : ["electron-builder", "--mac", "--publish", "always"],
      needsToken: !dryRun,
    },
  ];

  return new Promise(async (resolvePromise) => {
    const startedAt = Date.now();
    const completed = [];

    let versionChange = null;
    const finish = async (ok) => {
      // Only a successful publish keeps the bump. A dry run is a rehearsal and
      // must leave the tree exactly as it found it.
      if (versionChange && (!ok || dryRun)) await versionChange.restore();
      resolvePromise({ ok, completed, durationMs: Date.now() - startedAt });
    };

    let token = null;
    if (!dryRun) {
      try {
        const { stdout } = await gh(["auth", "token"]);
        token = stdout.trim() || null;
      } catch {
        token = null;
      }
      if (!token) {
        onEvent({ type: "error", code: "NO_GITHUB_TOKEN", message: "`gh auth token` returned nothing; run `gh auth login` first." });
        await finish(false);
        return;
      }
    }

    try {
      versionChange = await applyVersion(appRoot, version);
      if (versionChange.previous !== version) {
        onEvent({ type: "output", id: "version", kind: "stdout", text: `Version ${versionChange.previous} -> ${version}\n` });
      }
    } catch (error) {
      onEvent({ type: "error", code: "VERSION_WRITE_FAILED", message: `package.json could not be updated: ${error.message}` });
      await finish(false);
      return;
    }

    for (const step of steps) {
      if (signal?.aborted) {
        onEvent({ type: "error", code: "ABORTED", message: "The release was cancelled." });
        await finish(false);
        return;
      }

      onEvent({ type: "step", id: step.id, label: step.label, status: "running" });
      const stepStarted = Date.now();

      const outcome = await new Promise((done) => {
        const child = spawn(step.command, step.args, {
          cwd: appRoot,
          env: step.needsToken ? { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } : process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let bytes = 0;
        const forward = (stream, kind) => {
          stream.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > RELEASE_LIMITS.maxOutputBytes) return;
            onEvent({ type: "output", id: step.id, kind, text: chunk.toString("utf8") });
          });
        };
        forward(child.stdout, "stdout");
        forward(child.stderr, "stderr");

        const timer = setTimeout(() => child.kill("SIGKILL"), RELEASE_LIMITS.publishTimeoutMs);
        const onAbort = () => child.kill("SIGTERM");
        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("error", (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          done({ code: null, message: error?.message ?? "could not start" });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          done({ code, message: null });
        });
      });

      const ok = outcome.code === 0;
      completed.push({ id: step.id, ok, durationMs: Date.now() - stepStarted });
      onEvent({
        type: "step",
        id: step.id,
        label: step.label,
        status: ok ? "passed" : "failed",
        durationMs: Date.now() - stepStarted,
        detail: ok ? null : outcome.message ?? `exited with status ${outcome.code}`,
      });

      if (!ok) {
        onEvent({
          type: "error",
          code: "STEP_FAILED",
          message: `${step.label} failed, so nothing was published.`,
        });
        await finish(false);
        return;
      }
    }

    onEvent({ type: "done", ok: true, version, dryRun, notes: notes.slice(0, 2_000) });
    await finish(true);
  });
}
