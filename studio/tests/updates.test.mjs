import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import {
  UPDATE_DIRECTORY,
  assetForPlatform,
  checkForUpdate,
  downloadAsset,
  isDownloadedInstaller,
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

test("each platform is offered its own installer, not a zip and not a manifest", () => {
  assert.equal(assetForPlatform(MAC_RELEASE, { platform: "darwin", arch: "arm64" }).name, "Teminali.Code-1.0.1-macOS-arm64.dmg");
  assert.equal(assetForPlatform(MAC_RELEASE, { platform: "darwin", arch: "x64" }).name, "Teminali.Code-1.0.1-macOS-x64.dmg");
  assert.equal(assetForPlatform(MAC_RELEASE, { platform: "win32", arch: "x64" }).name, "Teminali.Code-Setup-1.0.1-Windows-x64.exe");
  assert.equal(assetForPlatform(MAC_RELEASE, { platform: "linux", arch: "x64" }).name, "Teminali.Code-1.0.1-Linux-x64.AppImage");
});

test("the matcher survives the product being renamed", () => {
  // The release that exists right now was built as "Teminali Studio". An update
  // check from a build called "Teminali Code" must still find it, which is why
  // matching is on extension and architecture rather than on the product name.
  const older = [{ name: "Teminali.Studio-1.0.0-macOS-arm64.dmg", size: 1, browser_download_url: "https://github.com/a/b/c.dmg" }];
  assert.equal(assetForPlatform(older, { platform: "darwin", arch: "arm64" }).name, "Teminali.Studio-1.0.0-macOS-arm64.dmg");
});

test("an architecture with no build is offered nothing rather than the wrong one", () => {
  const armOnly = [{ name: "App-1.0.0-macOS-arm64.dmg", size: 1, browser_download_url: "https://github.com/a/b/c.dmg" }];
  // Handing an Intel Mac an arm64 build is worse than telling it there is none.
  assert.equal(assetForPlatform(armOnly, { platform: "darwin", arch: "x64" }), null);
});

test("a single unarchitected build is offered to everyone", () => {
  const universal = [{ name: "App-1.0.0-mac.dmg", size: 1, browser_download_url: "https://github.com/a/b/c.dmg" }];
  assert.equal(assetForPlatform(universal, { platform: "darwin", arch: "arm64" }).name, "App-1.0.0-mac.dmg");
  assert.equal(assetForPlatform(universal, { platform: "darwin", arch: "x64" }).name, "App-1.0.0-mac.dmg");
});

test("no assets at all is an answer, not a crash", () => {
  assert.equal(assetForPlatform([], { platform: "darwin", arch: "arm64" }), null);
  assert.equal(assetForPlatform(undefined, { platform: "darwin", arch: "arm64" }), null);
});

/* ── Checking ─────────────────────────────────────────────────────────────── */

function release(overrides = {}) {
  return {
    tag_name: "v1.2.0",
    name: "Teminali Code v1.2.0",
    body: "Notes",
    published_at: "2026-09-02T00:00:00Z",
    html_url: "https://github.com/teminali/teminalicode/releases/tag/v1.2.0",
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
  assert.equal(result.latest.tag, "v1.2.0");
  assert.equal(result.asset.name, "Teminali.Code-1.0.1-macOS-arm64.dmg");
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

/* ── The open boundary ────────────────────────────────────────────────────── */

test("only a file this module downloaded may be opened", () => {
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
