import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions, parseVersion } from "../server/releases.js";

/**
 * Version comparison decides whether every install in the field is told to
 * update. Getting it wrong either strands people on an old build or offers them
 * a downgrade, and neither is visible until it has already happened.
 */

test("a version parses with or without its v", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: null });
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: null });
  assert.equal(parseVersion("1.2.3-beta.1").prerelease, "beta.1");
});

test("nonsense is null rather than a guess", () => {
  for (const bad of ["", "banana", "1.2", "1.2.3.4", "v", "1.2.x", null, undefined]) {
    assert.equal(parseVersion(bad), null, String(bad));
  }
});

test("ordering is numeric, not lexicographic", () => {
  // The classic failure: "1.10.0" sorts before "1.9.0" as a string.
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
});

test("equal versions compare equal, with or without the v", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
});

test("a release beats its own prerelease, so nobody is offered a downgrade", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.1"), 1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.1"), 1);
});

test("an unparseable side never claims an update is available", () => {
  // checkForUpdate reports `updateAvailable: comparison > 0`, so 0 is the safe
  // answer when either version cannot be read — it offers nothing.
  assert.equal(compareVersions("banana", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "banana"), 0);
  assert.equal(compareVersions(null, undefined), 0);
});

test("the update decision matches what the route reports", () => {
  const wouldOffer = (latest, running) => compareVersions(latest, running) > 0;

  assert.equal(wouldOffer("v1.0.1", "1.0.0"), true);
  assert.equal(wouldOffer("v1.0.0", "1.0.0"), false, "the release you are running is not an update");
  assert.equal(wouldOffer("v0.9.0", "1.0.0"), false, "never offer a downgrade");
  assert.equal(wouldOffer("v1.0.0-rc.1", "1.0.0"), false, "a prerelease of your version is not newer");
  assert.equal(wouldOffer("v1.1.0-rc.1", "1.0.0"), true, "a prerelease of a later version is");
});

/* ── The version actually reaching the build ──────────────────────────────── */

import { readFileSync } from "node:fs";
import { mkdtemp, readFile as readManifest, writeFile as writeManifest } from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join as joinManifest } from "node:path";
import { applyVersion, preflight, publishRelease } from "../server/releases.js";

async function scratchApp(version = "1.0.0") {
  const root = await mkdtemp(joinManifest(osTmpdir(), "release-"));
  await writeManifest(
    joinManifest(root, "package.json"),
    `${JSON.stringify({ name: "x", version, scripts: {} }, null, 2)}\n`,
  );
  return root;
}

const versionIn = async (root) => JSON.parse(await readManifest(joinManifest(root, "package.json"), "utf8")).version;

test("a dry run leaves the manifest exactly as it found it", async () => {
  // A rehearsal that renames the application is not a rehearsal.
  const root = await scratchApp("1.0.0");
  await publishRelease({
    appRoot: root, version: "1.1.0", dryRun: true, onEvent: () => {},
    // Nothing needs to actually build; the first step failing is enough to
    // reach the restore path, which is what is under test.
    signal: AbortSignal.abort(),
  });
  assert.equal(await versionIn(root), "1.0.0");
});

test("a failed release does not leave the tree claiming a version that never shipped", async () => {
  const root = await scratchApp("1.0.0");
  const result = await publishRelease({
    appRoot: root, version: "1.1.0", dryRun: true, onEvent: () => {}, signal: AbortSignal.abort(),
  });
  assert.equal(result.ok, false);
  assert.equal(await versionIn(root), "1.0.0");
});

/* ── The bump itself ─────────────────────────────────────────────────────── */

/**
 * electron-builder reads the version from package.json and nowhere else, so a
 * release that only validated the number would package the previous one. These
 * exercise `applyVersion` directly; the question of *when* it runs is a separate
 * and much cheaper assertion, below.
 */

/**
 * A scratch app whose checks pass. The three npm scripts are no-ops: what the
 * ordering tests need is for typecheck, test and build to *succeed* so the run
 * reaches the step after them, not for them to check anything.
 */
async function scratchAppWithLock(version = "1.0.0", extra = {}) {
  const root = await scratchApp(version);
  await writeManifest(
    joinManifest(root, "package.json"),
    `${JSON.stringify({
      name: "x", version,
      scripts: { typecheck: "exit 0", test: "exit 0", build: "exit 0" },
    }, null, 2)}\n`,
  );
  await writeManifest(
    joinManifest(root, "package-lock.json"),
    `${JSON.stringify({
      name: "x", version, lockfileVersion: 3,
      packages: { "": { name: "x", version }, "node_modules/dep": { version: "1.0.0" } },
      ...extra,
    }, null, 2)}\n`,
  );
  return root;
}

const lockIn = async (root) => JSON.parse(await readManifest(joinManifest(root, "package-lock.json"), "utf8"));

test("the version lands in the lockfile twice, because npm ci checks both", async () => {
  // `npm ci` fails outright if package.json and package-lock.json disagree, and
  // the lockfile carries the version at its root *and* under packages[""].
  // Writing one and not the other breaks every CI job rather than this one.
  const root = await scratchAppWithLock("1.0.0");
  await applyVersion(root, "1.2.3");

  assert.equal(await versionIn(root), "1.2.3");
  const lock = await lockIn(root);
  assert.equal(lock.version, "1.2.3");
  assert.equal(lock.packages[""].version, "1.2.3");
});

test("a dependency pinned to the old version is left alone", async () => {
  // Why the files are re-serialised rather than string-replaced: a regex for
  // "1.0.0" over the lockfile would also rewrite every dependency that happened
  // to be pinned to it.
  const root = await scratchAppWithLock("1.0.0");
  await applyVersion(root, "1.2.3");

  const lock = await lockIn(root);
  assert.equal(lock.packages["node_modules/dep"].version, "1.0.0");
});

test("restoring puts both files back exactly as they were", async () => {
  const root = await scratchAppWithLock("1.0.0");
  const before = {
    manifest: await readManifest(joinManifest(root, "package.json"), "utf8"),
    lock: await readManifest(joinManifest(root, "package-lock.json"), "utf8"),
  };

  const change = await applyVersion(root, "1.2.3");
  assert.equal(change.previous, "1.0.0");
  await change.restore();

  assert.equal(await readManifest(joinManifest(root, "package.json"), "utf8"), before.manifest);
  assert.equal(await readManifest(joinManifest(root, "package-lock.json"), "utf8"), before.lock);
});

test("re-releasing the version already in the manifest changes nothing", async () => {
  const root = await scratchAppWithLock("1.0.0");
  const before = await readManifest(joinManifest(root, "package.json"), "utf8");

  const change = await applyVersion(root, "1.0.0");
  assert.equal(change.previous, "1.0.0");
  await change.restore();

  assert.equal(await readManifest(joinManifest(root, "package.json"), "utf8"), before);
});

test("a missing lockfile is tolerated and a missing manifest is not", async () => {
  // Not every checkout has a lockfile; none of them can release without a
  // manifest, and a silent success there would package an unknown version.
  const root = await scratchApp("1.0.0");
  const change = await applyVersion(root, "1.2.3");
  assert.equal(await versionIn(root), "1.2.3");
  await change.restore();

  const empty = await mkdtemp(joinManifest(osTmpdir(), "release-empty-"));
  await assert.rejects(() => applyVersion(empty, "1.2.3"), /package\.json could not be read/);
});

/* ── When the bump happens ───────────────────────────────────────────────── */

test("the version reaches the manifest after the checks and before the packager", async () => {
  // Both halves matter and they pull in opposite directions. Bumping before the
  // checks means a failing test leaves a rewritten manifest behind; bumping
  // after the packager means shipping a build stamped with the old version.
  //
  // The run is cut short the instant the last check passes, so this observes
  // the ordering without ever starting electron-builder.
  const root = await scratchAppWithLock("1.0.0");
  const controller = new AbortController();
  const steps = [];
  let manifestAtBump = null;

  await publishRelease({
    appRoot: root,
    version: "1.2.3",
    dryRun: true,
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "step" && event.status === "running") steps.push(event.id);
      if (event.type === "step" && event.id === "build" && event.status === "passed") controller.abort();
      // Emitted between the bump and the packaging step — the only moment at
      // which "the manifest as the packager would find it" is observable.
      if (event.type === "output" && event.id === "version") {
        manifestAtBump = JSON.parse(readFileSync(joinManifest(root, "package.json"), "utf8")).version;
      }
    },
  });

  assert.deepEqual(steps, ["typecheck", "test", "build"], "the checks run first, in order");
  assert.equal(manifestAtBump, "1.2.3", "the packager would have read the new version");
  assert.ok(!steps.includes("publish"), "and it never got as far as packaging");
  assert.equal(await versionIn(root), "1.0.0", "an abandoned run restores the manifest");
});

test("a real publish checks the repository before it touches the manifest", async () => {
  // The dry run bumps after the three checks; a real one waits longer still,
  // until preflight has agreed the tree is releasable. Nothing is written to
  // package.json until the `tag` step, so a refused release leaves no trace.
  const root = await scratchAppWithLock("1.0.0");
  const steps = [];

  const result = await publishRelease({
    appRoot: root,
    version: "1.2.3",
    repo: "teminali/teminalicode",
    dryRun: false,
    onEvent: (event) => {
      if (event.type === "step" && event.status === "running") steps.push(event.id);
    },
  });

  // preflight fails here for a mundane reason — a scratch directory is not a
  // git repository — but *that it is reached fourth, and that tag is not
  // reached at all* is the whole assertion.
  assert.equal(result.ok, false);
  assert.deepEqual(steps, ["typecheck", "test", "build", "preflight"]);
  assert.equal(await versionIn(root), "1.0.0");
});


/* ── What must be true before a tag is pushed ────────────────────────────── */

import { execFileSync } from "node:child_process";

/**
 * A release ships what is committed. These run against a real throwaway
 * repository rather than a mocked one, because every rule preflight enforces is
 * a fact about git that a mock would only restate.
 *
 * None of them needs a remote: each stops at a check that runs before the first
 * one that would reach out, which is also what keeps them fast and offline.
 */
async function scratchRepo() {
  const root = await scratchAppWithLock("1.0.0");
  const run = (...args) =>
    execFileSync("git", ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  run("init", "-b", "main");
  run("add", ".");
  run("commit", "-m", "initial");
  return { root, run };
}

test("a detached HEAD is refused before anything else is considered", async () => {
  const { root, run } = await scratchRepo();
  run("checkout", "--detach");
  await assert.rejects(() => preflight(root, "1.1.0", "teminali/teminalicode"), /detached HEAD/);
});

test("an uncommitted change stops the release and says which file", async () => {
  // The two ways to get this wrong are both bad: sweeping half-finished work
  // into a release, or cutting one that silently omits the fix just written.
  const { root } = await scratchRepo();
  await writeManifest(joinManifest(root, "README.md"), "unfinished\n");

  await assert.rejects(
    () => preflight(root, "1.1.0", "teminali/teminalicode"),
    (error) => {
      assert.match(error.message, /1 uncommitted change\b/);
      assert.match(error.message, /README\.md/);
      return true;
    },
  );
});

test("the version files this run is about to rewrite are not counted as dirty", async () => {
  // A pending edit to package.json is this release, not somebody else's work.
  // The tag below already exists, so getting past the dirty check is observable
  // as a *different* refusal rather than as silence.
  const { root, run } = await scratchRepo();
  run("tag", "v1.1.0");
  await writeManifest(joinManifest(root, "package.json"), `${JSON.stringify({ name: "x", version: "1.1.0" }, null, 2)}\n`);

  await assert.rejects(() => preflight(root, "1.1.0", "teminali/teminalicode"), /Tag v1\.1\.0 already exists locally/);
});

test("a tag that already exists is refused rather than moved", async () => {
  // Retagging a released version silently changes what a published release
  // points at, for everyone who has not downloaded it yet.
  const { root, run } = await scratchRepo();
  run("tag", "v1.1.0");
  await assert.rejects(() => preflight(root, "1.1.0", "teminali/teminalicode"), /already exists locally/);
});
