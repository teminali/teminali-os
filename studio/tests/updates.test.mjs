import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  UPDATE_DIRECTORY,
  assetForPlatform,
  checkForUpdate,
  downloadAsset,
  isDownloadedInstaller,
  listReleases,
} from "../server/updates.js";

/* ── Picking the right file ───────────────────────────────────────────────── */

const MAC_RELEASE = [
  { name: "Teminali.Code-1.0.1-macOS-arm64.dmg", size: 1, browser_download_url: "https://github.com/a/b/arm.dmg" },
  { name: "Teminali.Code-1.0.1-macOS-arm64.zip", size: 1, browser_download_url: "https://github.com/a/b/arm.zip" },
  { name: "Teminali.Code-1.0.1-macOS-x64.dmg", size: 1, browser_download_url: "https://github.com/a/b/x64.dmg" },
  { name: "Teminali.Code-1.0.1-macOS-x64.zip", size: 1, browser_download_url: "https://github.com/a/b/x64.zip" },
  { name: "Teminali.Code-Setup-1.0.1-Windows-x64.exe", size: 1, browser_download_url: "https://github.com/a/b/w.exe" },
  { name: "Teminali.Code-1.0.1-Linux-x64.AppImage", size: 1, browser_download_url: "https://github.com/a/b/l.AppImage" },
  { name: "latest-mac.yml", size: 1, browser_download_url: "https://github.com/a/b/y.yml" },
];

test("each platform is offered the artifact it can actually install, not a manifest", () => {
  // macOS takes the .zip and not the .dmg on purpose: a .dmg can only be
  // installed by handing it to LaunchServices, which Gatekeeper refuses for an
  // ad-hoc build. The .zip is expanded and swapped in-process instead.
  assert.equal(assetForPlatform(MAC_RELEASE, { platform: "darwin", arch: "arm64" }).name, "Teminali.Code-1.0.1-macOS-arm64.zip");
  assert.equal(assetForPlatform(MAC_RELEASE, { platform: "darwin", arch: "x64" }).name, "Teminali.Code-1.0.1-macOS-x64.zip");
  assert.equal(assetForPlatform(MAC_RELEASE, { platform: "win32", arch: "x64" }).name, "Teminali.Code-Setup-1.0.1-Windows-x64.exe");
  assert.equal(assetForPlatform(MAC_RELEASE, { platform: "linux", arch: "x64" }).name, "Teminali.Code-1.0.1-Linux-x64.AppImage");
});

test("the matcher survives the product being renamed", () => {
  // The release that exists right now was built as "Teminali Studio". An update
  // check from a build called "Teminali OS" must still find it, which is why
  // matching is on extension and architecture rather than on the product name.
  const older = [{ name: "Teminali.Studio-1.0.0-macOS-arm64.zip", size: 1, browser_download_url: "https://github.com/a/b/c.zip" }];
  assert.equal(assetForPlatform(older, { platform: "darwin", arch: "arm64" }).name, "Teminali.Studio-1.0.0-macOS-arm64.zip");
});

test("an architecture with no build is offered nothing rather than the wrong one", () => {
  const armOnly = [{ name: "App-1.0.0-macOS-arm64.zip", size: 1, browser_download_url: "https://github.com/a/b/c.zip" }];
  // Handing an Intel Mac an arm64 build is worse than telling it there is none.
  assert.equal(assetForPlatform(armOnly, { platform: "darwin", arch: "x64" }), null);
});

test("a single unarchitected build is offered to everyone", () => {
  const universal = [{ name: "App-1.0.0-mac.zip", size: 1, browser_download_url: "https://github.com/a/b/c.zip" }];
  assert.equal(assetForPlatform(universal, { platform: "darwin", arch: "arm64" }).name, "App-1.0.0-mac.zip");
  assert.equal(assetForPlatform(universal, { platform: "darwin", arch: "x64" }).name, "App-1.0.0-mac.zip");
});

test("the packagers' own spellings of an architecture all resolve", () => {
  // Observed in CI, not imagined: electron-builder writes `x64` into the .dmg
  // and `x86_64` into the .AppImage from the same template.
  const mixed = [
    { name: "Teminali OS-1.1.0-Linux-x86_64.AppImage", size: 1, browser_download_url: "https://github.com/a/b/l.AppImage" },
    { name: "Teminali OS-1.1.0-Linux-arm64.AppImage", size: 1, browser_download_url: "https://github.com/a/b/la.AppImage" },
  ];
  assert.equal(assetForPlatform(mixed, { platform: "linux", arch: "x64" }).name, "Teminali OS-1.1.0-Linux-x86_64.AppImage");
  assert.equal(assetForPlatform(mixed, { platform: "linux", arch: "arm64" }).name, "Teminali OS-1.1.0-Linux-arm64.AppImage");

  const amd = [{ name: "App-1.0.0-amd64.AppImage", size: 1, browser_download_url: "https://github.com/a/b/c.AppImage" }];
  assert.equal(assetForPlatform(amd, { platform: "linux", arch: "x64" }).name, "App-1.0.0-amd64.AppImage");
});

test("an aliased architecture is not mistaken for an unarchitected build", () => {
  // The bug this guards: `x86_64` did not match `x64`, so it fell through to
  // the "names no architecture" branch and was handed to every machine.
  const armOnly = [{ name: "App-1.0.0-aarch64.AppImage", size: 1, browser_download_url: "https://github.com/a/b/c.AppImage" }];
  assert.equal(assetForPlatform(armOnly, { platform: "linux", arch: "x64" }), null);
});

test("the real release shape resolves to the zip, never the labelled dmg", () => {
  // Exactly what v1.1.7 published. build/afterAllArtifactBuild.cjs renames the
  // DMGs to say which Mac they are for and leaves the zips as arm64 / x64, so
  // both spellings are present at once and the .dmg must lose.
  const labelled = [
    { name: "Teminali-OS-1.1.1-macOS-Apple-Silicon.dmg", size: 1, browser_download_url: "https://github.com/a/b/as.dmg" },
    { name: "Teminali-OS-1.1.1-macOS-Intel.dmg", size: 1, browser_download_url: "https://github.com/a/b/i.dmg" },
    { name: "Teminali-OS-1.1.1-macOS-arm64.zip", size: 1, browser_download_url: "https://github.com/a/b/as.zip" },
    { name: "Teminali-OS-1.1.1-macOS-x64.zip", size: 1, browser_download_url: "https://github.com/a/b/i.zip" },
  ];
  assert.equal(assetForPlatform(labelled, { platform: "darwin", arch: "arm64" }).name, "Teminali-OS-1.1.1-macOS-arm64.zip");
  assert.equal(assetForPlatform(labelled, { platform: "darwin", arch: "x64" }).name, "Teminali-OS-1.1.1-macOS-x64.zip");
});

test("a blockmap sitting beside the zip is never mistaken for it", () => {
  // The release carries `…-macOS-arm64.zip.blockmap` next to the zip. It ends
  // in the architecture and in the word zip, and it is not an application.
  const withBlockmaps = [
    { name: "Teminali.Code-1.1.7-macOS-arm64.zip.blockmap", size: 1, browser_download_url: "https://github.com/a/b/a.blockmap" },
    { name: "Teminali-OS-1.1.7-macOS-arm64.zip", size: 1, browser_download_url: "https://github.com/a/b/a.zip" },
  ];
  assert.equal(assetForPlatform(withBlockmaps, { platform: "darwin", arch: "arm64" }).name, "Teminali-OS-1.1.7-macOS-arm64.zip");
});

test("a macOS release with no zip offers nothing rather than a dmg", () => {
  // Deliberate. The dmg cannot be installed without the dialog this whole
  // change exists to remove, so "no update yet" is the honest answer.
  const dmgOnly = [
    { name: "Teminali-OS-1.1.1-macOS-Apple-Silicon.dmg", size: 1, browser_download_url: "https://github.com/a/b/as.dmg" },
    { name: "Teminali-OS-1.1.1-macOS-Intel.dmg", size: 1, browser_download_url: "https://github.com/a/b/i.dmg" },
  ];
  assert.equal(assetForPlatform(dmgOnly, { platform: "darwin", arch: "arm64" }), null);
});

test("the label is matched however it is capitalised or spaced", () => {
  // The tokens are lower case and the names are not; nothing about the release
  // page guarantees the hyphen either.
  const squashed = [
    { name: "App-1.0.0-macOS-AppleSilicon.zip", size: 1, browser_download_url: "https://github.com/a/b/as.zip" },
    { name: "App-1.0.0-macOS-INTEL.zip", size: 1, browser_download_url: "https://github.com/a/b/i.zip" },
  ];
  assert.equal(assetForPlatform(squashed, { platform: "darwin", arch: "arm64" }).name, "App-1.0.0-macOS-AppleSilicon.zip");
  assert.equal(assetForPlatform(squashed, { platform: "darwin", arch: "x64" }).name, "App-1.0.0-macOS-INTEL.zip");
});

test("a labelled build is not mistaken for an unarchitected build", () => {
  // The `x86_64` bug again, in its new clothes: if ANY_ARCH does not know the
  // word "Apple Silicon" then an arm64-only release stops looking architected,
  // and the branch below hands the one file it finds to an Intel Mac.
  const armOnly = [{ name: "App-1.0.0-macOS-Apple-Silicon.zip", size: 1, browser_download_url: "https://github.com/a/b/c.zip" }];
  assert.equal(assetForPlatform(armOnly, { platform: "darwin", arch: "x64" }), null);

  const intelOnly = [{ name: "App-1.0.0-macOS-Intel.zip", size: 1, browser_download_url: "https://github.com/a/b/c.zip" }];
  assert.equal(assetForPlatform(intelOnly, { platform: "darwin", arch: "arm64" }), null);
});

test("v1.1.0's own names still resolve, because v1.1.0 is what is installed", () => {
  // Every copy in the world looks for its successor through this function, and
  // the release it was downloaded from spells the architectures the old way.
  // Renaming the assets must not strand the machines already running them.
  const shipped = [
    { name: "Teminali-Code-1.1.0-macOS-arm64.zip", size: 1, browser_download_url: "https://github.com/a/b/arm.zip" },
    { name: "Teminali-Code-1.1.0-macOS-x64.zip", size: 1, browser_download_url: "https://github.com/a/b/x64.zip" },
    { name: "Teminali-Code-Setup-1.1.0-Windows-x64.exe", size: 1, browser_download_url: "https://github.com/a/b/w.exe" },
    { name: "Teminali-Code-1.1.0-Linux-x86_64.AppImage", size: 1, browser_download_url: "https://github.com/a/b/l.AppImage" },
  ];
  assert.equal(assetForPlatform(shipped, { platform: "darwin", arch: "arm64" }).name, "Teminali-Code-1.1.0-macOS-arm64.zip");
  assert.equal(assetForPlatform(shipped, { platform: "darwin", arch: "x64" }).name, "Teminali-Code-1.1.0-macOS-x64.zip");
  assert.equal(assetForPlatform(shipped, { platform: "win32", arch: "x64" }).name, "Teminali-Code-Setup-1.1.0-Windows-x64.exe");
  assert.equal(assetForPlatform(shipped, { platform: "linux", arch: "x64" }).name, "Teminali-Code-1.1.0-Linux-x86_64.AppImage");
});

test("no assets at all is an answer, not a crash", () => {
  assert.equal(assetForPlatform([], { platform: "darwin", arch: "arm64" }), null);
  assert.equal(assetForPlatform(undefined, { platform: "darwin", arch: "arm64" }), null);
});

/* ── Checking ─────────────────────────────────────────────────────────────── */

/**
 * The running build, read from package.json, is what every fixture here is
 * measured against.
 *
 * Derived rather than written down. A tag hardcoded as "the newer release"
 * stops being newer the first time the app is versioned past it, and the
 * suite then fails on the release commit — the one change that did nothing
 * wrong — instead of on whatever actually broke the update check.
 */
const RUNNING = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const [RUNNING_MAJOR, RUNNING_MINOR, RUNNING_PATCH] = RUNNING.split(".").map(Number);

/** One minor above whatever is running: an update this machine should be offered. */
const NEWER = `v${RUNNING_MAJOR}.${RUNNING_MINOR + 1}.0`;

/**
 * The nearest version below the running one, whatever shape it has.
 *
 * Stepping the patch down is only correct while the patch is non-zero — on a
 * `.0` it lands back on the running version and the rollback test starts
 * asserting that the current build is older than itself.
 */
const OLDER = RUNNING_PATCH > 0
  ? `v${RUNNING_MAJOR}.${RUNNING_MINOR}.${RUNNING_PATCH - 1}`
  : RUNNING_MINOR > 0
    ? `v${RUNNING_MAJOR}.${RUNNING_MINOR - 1}.0`
    : `v${Math.max(0, RUNNING_MAJOR - 1)}.0.0`;

function release(overrides = {}) {
  return {
    tag_name: NEWER,
    name: `Teminali OS ${NEWER}`,
    body: "Notes",
    published_at: "2026-09-02T00:00:00Z",
    html_url: `https://github.com/teminali/teminali-os/releases/tag/${NEWER}`,
    draft: false,
    prerelease: false,
    assets: MAC_RELEASE,
    ...overrides,
  };
}

const appRoot = new URL("..", import.meta.url).pathname;

function stubFetch(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

test("a newer release is reported with the file this machine should take", async () => {
  const result = await checkForUpdate({
    appRoot, repo: "x/y", platform: "darwin", arch: "arm64", fetchImpl: stubFetch(200, release()),
  });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latest.tag, NEWER);
  assert.equal(result.asset.name, "Teminali.Code-1.0.1-macOS-arm64.zip");
});

test("a draft release is not offered to anybody", async () => {
  const result = await checkForUpdate({
    appRoot, repo: "x/y", platform: "darwin", arch: "arm64", fetchImpl: stubFetch(200, release({ draft: true })),
  });
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latest, null);
});

test("a repository with no releases says so, and is not an error state", async () => {
  const result = await checkForUpdate({ appRoot, repo: "x/y", fetchImpl: stubFetch(404, {}) });
  assert.match(result.error, /no releases yet/);
  assert.equal(result.updateAvailable, false);
});

test("rate limiting is named rather than reported as being offline", async () => {
  // 60 unauthenticated requests an hour per address; saying "offline" when the
  // machine is plainly online is the kind of message nobody trusts twice.
  const result = await checkForUpdate({ appRoot, repo: "x/y", fetchImpl: stubFetch(403, {}) });
  assert.match(result.error, /rate-limit/i);
});

test("an unreachable GitHub is an answer, not a thrown error", async () => {
  const result = await checkForUpdate({
    appRoot, repo: "x/y",
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.match(result.error, /could not be reached/);
  assert.equal(result.updateAvailable, false);
});

test("an update with no build for this platform says which platform", async () => {
  const result = await checkForUpdate({
    appRoot, repo: "x/y", platform: "linux", arch: "arm64",
    fetchImpl: stubFetch(200, release({ assets: [MAC_RELEASE[0]] })),
  });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.asset, null);
  assert.match(result.error, /no build for linux\/arm64/);
});

/* ── What the version control can offer ───────────────────────────────────── */

function listing(tags) {
  return tags.map((tag) => release({ tag_name: tag, name: `Teminali OS ${tag}`, html_url: `https://github.com/x/y/releases/tag/${tag}` }));
}

test("every release is placed relative to the build that is running", async () => {
  const newer = NEWER;
  const older = OLDER;

  const result = await listReleases({
    appRoot, repo: "x/y", platform: "darwin", arch: "arm64",
    fetchImpl: stubFetch(200, listing([newer, `v${RUNNING}`, older])),
  });

  assert.equal(result.version, RUNNING);
  const byVersion = Object.fromEntries(result.releases.map((entry) => [entry.version, entry]));
  assert.equal(byVersion[RUNNING].current, true);
  assert.equal(byVersion[RUNNING].older, false);
  assert.equal(byVersion[newer.slice(1)].older, false);
  assert.equal(byVersion[older.slice(1)].older, true);
  // A rollback is only offered if there is something to install for it.
  assert.equal(byVersion[older.slice(1)].asset.name, "Teminali.Code-1.0.1-macOS-arm64.zip");
});

test("releases are ordered by version, not by the date they were published", async () => {
  // A patch to an old line can be cut after a newer minor, and GitHub returns
  // them in publication order. Rolling back to "the one before this" has to
  // mean the version below it, not whatever was published most recently.
  const result = await listReleases({
    appRoot, repo: "x/y", platform: "darwin", arch: "arm64",
    fetchImpl: stubFetch(200, listing(["v1.0.9", "v1.2.0", "v1.1.0"])),
  });
  assert.deepEqual(result.releases.map((entry) => entry.version), ["1.2.0", "1.1.0", "1.0.9"]);
});

test("a draft is not somewhere anybody can go back to", async () => {
  const result = await listReleases({
    appRoot, repo: "x/y", platform: "darwin", arch: "arm64",
    fetchImpl: stubFetch(200, [release({ tag_name: "v1.0.0", draft: true }), release({ tag_name: "v1.0.1" })]),
  });
  assert.deepEqual(result.releases.map((entry) => entry.version), ["1.0.1"]);
});

test("an unreadable running version offers no rollback rather than a blind one", async () => {
  // Nothing is marked `older`, so the menu offers nothing. Installing an
  // arbitrary build over a version you cannot name is the worse failure.
  const result = await listReleases({
    appRoot: "/nonexistent", repo: "x/y", platform: "darwin", arch: "arm64",
    fetchImpl: stubFetch(200, listing(["v1.0.0", "v0.9.0"])),
  });
  assert.equal(result.version, null);
  assert.equal(result.releases.every((entry) => entry.older === false), true);
});

test("a release with no build for this machine is listed without an asset", async () => {
  const result = await listReleases({
    appRoot, repo: "x/y", platform: "linux", arch: "arm64",
    fetchImpl: stubFetch(200, listing(["v1.0.0"])),
  });
  assert.equal(result.releases[0].asset, null);
});

test("an unreachable GitHub is an empty list with a reason, not a thrown error", async () => {
  const result = await listReleases({
    appRoot, repo: "x/y",
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.deepEqual(result.releases, []);
  assert.match(result.error, /could not be reached/);
});

test("rate limiting is named on the release list too", async () => {
  const result = await listReleases({ appRoot, repo: "x/y", fetchImpl: stubFetch(403, {}) });
  assert.match(result.error, /rate-limit/i);
});

/* ── The open boundary ────────────────────────────────────────────────────── */

test("only a file this module downloaded may be opened", () => {
  assert.equal(isDownloadedInstaller(join(UPDATE_DIRECTORY, "App-1.0.0.zip")), true);
  assert.equal(isDownloadedInstaller(join(UPDATE_DIRECTORY, "App-1.0.0.dmg")), true);
  assert.equal(isDownloadedInstaller("/Applications/Calculator.app"), false);
  assert.equal(isDownloadedInstaller("/etc/passwd"), false);
  assert.equal(isDownloadedInstaller(""), false);
  assert.equal(isDownloadedInstaller(null), false);
});

test("a traversal out of the update directory is refused", () => {
  assert.equal(isDownloadedInstaller(join(UPDATE_DIRECTORY, "..", "..", "evil.dmg")), false);
  assert.equal(isDownloadedInstaller(join(UPDATE_DIRECTORY, "nested", "evil.dmg")), false);
});

test("a file that is not an installer is refused even inside the directory", () => {
  assert.equal(isDownloadedInstaller(join(UPDATE_DIRECTORY, "notes.txt")), false);
  assert.equal(isDownloadedInstaller(join(UPDATE_DIRECTORY, "script.sh")), false);
  assert.equal(isDownloadedInstaller(join(UPDATE_DIRECTORY, "App-1.0.0.zip.blockmap")), false);
});

/* ── The download boundary ────────────────────────────────────────────────── */

test("an asset URL that is not GitHub's is refused", async () => {
  await assert.rejects(
    () => downloadAsset({ url: "https://evil.example.com/x.dmg", name: "x.dmg" }),
    (error) => error.message === "UPDATE_ASSET_URL_INVALID",
  );
  await assert.rejects(
    () => downloadAsset({ url: "http://github.com/a/b.dmg", name: "b.dmg" }),
    (error) => error.message === "UPDATE_ASSET_URL_INVALID",
  );
});

test("an asset name that could escape the directory is refused", async () => {
  for (const name of ["../evil.dmg", "a/b.dmg", "evil.sh", ""]) {
    await assert.rejects(
      () => downloadAsset({ url: "https://github.com/a/b/c.dmg", name }),
      (error) => error.message === "UPDATE_ASSET_NAME_INVALID",
      `expected "${name}" to be refused`,
    );
  }
});
