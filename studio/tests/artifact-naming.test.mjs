import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import hook from "../build/afterAllArtifactBuild.cjs";

const afterAllArtifactBuild = hook.default;

/**
 * The release page is the thing under test here: someone standing on it with an
 * Intel MacBook has to be able to tell which of two disk images is theirs.
 * Everything below asserts on file names for that reason.
 */

/** Lays out one build's worth of artifacts and runs the hook over them. */
async function build(names) {
  const outDir = await mkdtemp(join(tmpdir(), "teminali-artifacts-"));
  const artifactPaths = names.map((name) => join(outDir, name));
  for (const path of artifactPaths) await writeFile(path, "");

  const result = { outDir, artifactPaths };
  const published = await afterAllArtifactBuild(result);

  return {
    published: published.map((path) => basename(path)),
    onDisk: (await readdir(outDir)).sort(),
    reported: result.artifactPaths.map((path) => basename(path)).sort(),
  };
}

// Exactly what a `--mac --arm64 --x64` run leaves in release/, spaces and all:
// electron-builder writes the product name unaltered and computes a GitHub-safe
// name separately, at upload time.
const MAC_BUILD = [
  "Teminali OS-1.1.1-macOS-arm64.dmg",
  "Teminali OS-1.1.1-macOS-arm64.dmg.blockmap",
  "Teminali OS-1.1.1-macOS-arm64.zip",
  "Teminali OS-1.1.1-macOS-x64.dmg",
  "Teminali OS-1.1.1-macOS-x64.dmg.blockmap",
  "Teminali OS-1.1.1-macOS-x64.zip",
  "latest-mac.yml",
];

test("the disk images are named after the Mac they run on", async () => {
  const { onDisk } = await build(MAC_BUILD);
  assert.ok(onDisk.includes("Teminali-OS-1.1.1-macOS-Apple-Silicon.dmg"));
  assert.ok(onDisk.includes("Teminali-OS-1.1.1-macOS-Intel.dmg"));
  assert.ok(!onDisk.includes("Teminali OS-1.1.1-macOS-arm64.dmg"));
  assert.ok(!onDisk.includes("Teminali OS-1.1.1-macOS-x64.dmg"));
});

test("a blockmap follows the disk image it describes", async () => {
  // It is named after its subject and useless without it, so leaving it behind
  // under the old name would put a file on the release page describing nothing.
  const { onDisk } = await build(MAC_BUILD);
  assert.ok(onDisk.includes("Teminali-OS-1.1.1-macOS-Apple-Silicon.dmg.blockmap"));
  assert.ok(onDisk.includes("Teminali-OS-1.1.1-macOS-Intel.dmg.blockmap"));
});

test("nothing but the disk images is touched", async () => {
  // The .zip names are what latest-mac.yml lists by hand, and renaming one
  // would mean rewriting that manifest to match. The DMGs need no manifest.
  const { onDisk } = await build(MAC_BUILD);
  assert.ok(onDisk.includes("Teminali OS-1.1.1-macOS-arm64.zip"));
  assert.ok(onDisk.includes("Teminali OS-1.1.1-macOS-x64.zip"));
  assert.ok(onDisk.includes("latest-mac.yml"));
});

test("the renamed files are the ones handed back for publishing", async () => {
  // electron-builder uploads exactly what this returns — `dmg.publish` is null
  // precisely so that it does not upload them itself under the old names.
  const { published } = await build(MAC_BUILD);
  assert.deepEqual(published.sort(), [
    "Teminali-OS-1.1.1-macOS-Apple-Silicon.dmg",
    "Teminali-OS-1.1.1-macOS-Apple-Silicon.dmg.blockmap",
    "Teminali-OS-1.1.1-macOS-Intel.dmg",
    "Teminali-OS-1.1.1-macOS-Intel.dmg.blockmap",
  ]);
});

test("a renamed file is not left in the build result under its old name", async () => {
  // Two reasons, and the second is silent: the summary electron-builder prints
  // would name files that no longer exist, and it skips any returned path that
  // is already in this list as "already published" — which would publish
  // nothing at all.
  const { reported } = await build(MAC_BUILD);
  assert.deepEqual(reported, [
    "Teminali OS-1.1.1-macOS-arm64.zip",
    "Teminali OS-1.1.1-macOS-x64.zip",
    "latest-mac.yml",
  ]);
});

test("the name that lands on the release page has no space in it", async () => {
  // GitHub substitutes a dot for a space, so an unfixed name would arrive as
  // `Teminali.OS-...dmg` beside siblings called `Teminali-OS-...`. The
  // publisher uses the name on disk for anything this hook hands back, so the
  // substitution has to happen here.
  const { published } = await build(["Teminali OS-1.1.1-macOS-arm64.dmg"]);
  assert.deepEqual(published, ["Teminali-OS-1.1.1-macOS-Apple-Silicon.dmg"]);
});

test("a Windows or Linux build passes through untouched", async () => {
  // The hook runs on all three runners. On two of them there is nothing to do,
  // and it must not invent something.
  const { published, onDisk } = await build([
    "Teminali-OS-Setup-1.1.1-Windows-x64.exe",
    "Teminali-OS-Setup-1.1.1-Windows-x64.exe.blockmap",
    "Teminali-OS-1.1.1-Linux-x86_64.AppImage",
    "latest.yml",
  ]);
  assert.deepEqual(published, []);
  assert.deepEqual(onDisk, [
    "Teminali-OS-1.1.1-Linux-x86_64.AppImage",
    "Teminali-OS-Setup-1.1.1-Windows-x64.exe",
    "Teminali-OS-Setup-1.1.1-Windows-x64.exe.blockmap",
    "latest.yml",
  ]);
});

test("only the architecture the packager appended is rewritten", async () => {
  // The match is anchored at the extension. A product or version that happens
  // to contain the word is not a suffix and is not the packager talking.
  const { onDisk } = await build(["Retro x64 Emulator-1.0.0-macOS-arm64.dmg"]);
  assert.deepEqual(onDisk, ["Retro-x64-Emulator-1.0.0-macOS-Apple-Silicon.dmg"]);
});
