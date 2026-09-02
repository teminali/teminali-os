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
import { publishRelease } from "../server/releases.js";

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

test("the version is written before anything is built", async () => {
  // electron-builder reads the version from package.json and nowhere else, so
  // a release that only validated the number built the previous one.
  const root = await scratchApp("1.0.0");
  const seen = [];
  await publishRelease({
    appRoot: root,
    version: "1.2.3",
    dryRun: true,
    onEvent: (event) => {
      if (event.type === "output" && event.id === "version") seen.push(event.text.trim());
      // Capture what the manifest says at the moment the first step starts.
      if (event.type === "step" && event.status === "running" && seen.length === 1) {
        seen.push(`manifest-at-first-step:${JSON.parse(readFileSync(joinManifest(root, "package.json"), "utf8")).version}`);
      }
    },
  });
  assert.ok(seen.some((line) => line.includes("1.0.0 -> 1.2.3")), `expected a bump line, saw ${JSON.stringify(seen)}`);
  assert.ok(seen.some((line) => line === "manifest-at-first-step:1.2.3"), `expected 1.2.3 during the build, saw ${JSON.stringify(seen)}`);
});
