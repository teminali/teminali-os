/*
  What the packaged app can still reach.

  Three modules under `server/` import across the package boundary with
  `../../<dir>/…`. Inside the asar that resolves to `<Resources>/<dir>/…`, so
  each of those directories has to be copied there by an `extraResources`
  entry — and the entry has to say `to:`, because that is the half that
  decides where it lands.

  This exists because it went wrong in exactly one way and nothing caught it.
  A second entry was written into the list *above* the `to:` and `filter:`
  that belonged to the first, and YAML read them as the second entry's own:
  the gateway lost its destination and its filter, and the licence was copied
  on top of the path the gateway is imported from. Both cross-package imports
  were broken in the v1.2.0 artifacts that built — silently, because a missing
  resource is only found when the packaged app tries to import it.

  It did not break packaging; that was the signing variables, asserted at the
  bottom of this file. The two failures arrived together and the first was
  mistaken for the cause of the second.

  Nothing here runs electron-builder. It reads the config the way the build
  will and asserts the two properties a broken entry violates: every entry
  names its own destination, and every cross-package import has one.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const config = readFileSync(join(root, "electron-builder.yml"), "utf8");

/**
 * The `extraResources:` entries, read as text rather than as YAML.
 *
 * js-yaml is not a dependency of this package — it arrives under
 * electron-builder — and a test that reaches for a transitive module breaks
 * on a day that has nothing to do with what it is checking. The block is a
 * flat list of `- from:` entries, which is little enough shape to read
 * directly.
 */
function extraResources() {
  const lines = config.split("\n");
  const start = lines.findIndex((line) => line.startsWith("extraResources:"));
  assert.notEqual(start, -1, "electron-builder.yml has no extraResources block");

  const entries = [];
  for (const line of lines.slice(start + 1)) {
    // A non-indented, non-comment line is the next top-level key.
    if (/^[A-Za-z]/.test(line)) break;
    if (/^\s*#/.test(line)) continue;

    const from = line.match(/^\s*-\s+from:\s*(\S+)/);
    if (from) { entries.push({ from: from[1], to: null }); continue; }

    const to = line.match(/^\s*to:\s*(\S+)/);
    if (to && entries.length > 0) entries[entries.length - 1].to = to[1];
  }
  return entries;
}

test("every extra resource names its own destination", () => {
  const entries = extraResources();
  assert.ok(entries.length > 0, "the block parsed to nothing");

  for (const entry of entries) {
    assert.notEqual(
      entry.to, null,
      `extraResources entry "${entry.from}" has no to: — it will be copied to the ` +
      "resources root, and the next entry's to: belongs to it, not to this one",
    );
  }
});

test("a resource is copied to the directory its from: is named after", () => {
  // `from: ../gateway` landing anywhere but `gateway` is the shape of the
  // failure: it is what putting one entry above another's to: produces.
  for (const { from, to } of extraResources()) {
    /*
      The media stack is the one exception, and it is an exception because the
      rule is about IMPORTS. `server/gateway.js` imports "../../gateway/…", so
      that entry's `to:` has to spell what module resolution will look for.
      Nothing imports an ffmpeg: it is spawned, by an absolute path the finders
      build at runtime. `media-stack/` is a staging directory whose whole job is
      to become those two names, so the test below asserts the thing that
      actually matters — that they are the names the finders probe.
    */
    if (from.startsWith("media-stack/")) continue;
    assert.equal(
      to, from.replace(/^\.\.\//, ""),
      `"${from}" is copied to "${to}", so an import of "../../${from.replace(/^\.\.\//, "")}/…" will not resolve`,
    );
  }
});

test("the staged media binaries land where the finders actually look", () => {
  const staged = extraResources().filter((entry) => entry.from.startsWith("media-stack/"));
  assert.deepEqual(
    staged.map((entry) => entry.to).sort(),
    ["ffmpeg", "mpv"],
    "the LGPL bundle is staged from media-stack/ and must arrive under these two names",
  );
  /*
    Asserted against the source rather than trusted, because the failure is
    silent: an installer that carries a perfectly good ffmpeg under a name
    nothing probes is a 61 MB download that changes nothing, and it looks
    identical to a working one until a customer with no ffmpeg opens an export.
  */
  const mediaAccess = readFileSync(join(root, "electron", "mediaAccess.cjs"), "utf8");
  assert.match(mediaAccess, /path\.join\(resourcesPath, "ffmpeg"/, "findFfmpeg must probe <Resources>/ffmpeg");
  const mpvProcess = readFileSync(join(root, "electron", "mpvProcess.cjs"), "utf8");
  assert.match(mpvProcess, /path\.join\(resourcesPath, "mpv"/, "findMpv must probe <Resources>/mpv");
});

test("every cross-package import has a resource that carries it", () => {
  const serverDir = join(root, "server");
  const wanted = new Map();

  for (const name of readdirSync(serverDir)) {
    if (!name.endsWith(".js")) continue;
    const source = readFileSync(join(serverDir, name), "utf8");
    for (const [, dir] of source.matchAll(/from\s+"\.\.\/\.\.\/([^/"]+)\//g)) {
      if (!wanted.has(dir)) wanted.set(dir, name);
    }
  }

  assert.ok(wanted.size > 0, "no cross-package imports found — this test has stopped testing");

  const copied = new Set(extraResources().map((entry) => entry.to));
  for (const [dir, importer] of wanted) {
    assert.ok(
      copied.has(dir),
      `server/${importer} imports "../../${dir}/…", which resolves to <Resources>/${dir} ` +
      `in a packaged app, but no extraResources entry copies anything to "${dir}"`,
    );
  }
});

/*
  The signing variables, which are pending and must stay inert.

  `CSC_LINK` is read as `v1 == null ? v2 : v1` — an empty string is a value,
  not an absence. The release workflow sets it from a secret that does not
  exist yet, so it arrives as "", electron-builder resolves it as a
  certificate *path* against the project directory, and the macOS build dies
  with "<projectDir> not a file". It failed v1.2.0 twice that way, on a tag
  that was already public, and nothing in the suite could see it because the
  variable only exists on a runner.

  So the run step unsets them when they are empty, and this asserts it still
  does. It is a text assertion on a workflow rather than a behavioural one:
  cheap, and the alternative is finding out during a release again.
*/
test("the release workflow unsets empty signing variables before packaging", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url).pathname, "utf8",
  );

  assert.match(
    workflow, /unset CSC_LINK CSC_KEY_PASSWORD/,
    "an empty CSC_LINK is read as a certificate path, not as an absent one",
  );
  assert.match(
    workflow, /unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID/,
    "three empty notarization variables are a set that is present and unusable",
  );
  // The guard is worthless if it runs after the thing it guards.
  const guard = workflow.indexOf("unset CSC_LINK");
  const build = workflow.indexOf("npx electron-builder");
  assert.ok(guard !== -1 && build !== -1 && guard < build, "the unset must precede the build");

  // ...and worthless if the runner cannot parse it. Windows defaults to
  // PowerShell, which reads `if [ -z ... ]` as a syntax error and fails the
  // job before electron-builder starts. That cost the third v1.2.0 build.
  assert.match(
    workflow.slice(0, build), /shell: bash/,
    "the packaging step must pin bash, or the guard is a parse error on Windows",
  );
});

/*
  The speech sidecar's payload, which every platform block prunes by hand.

  `@huggingface/transformers` ships both halves of itself: the Node half that
  loads onnxruntime-node, and a web half — the `onnxruntime-web` package, the
  `transformers.web` bundles, and the 21 MB `ort-wasm-simd-threaded.jsep.wasm`
  the WASM backend runs on. The sidecar is a Node child process and its package
  `exports` resolve the `node` condition, so it never touches any of it, but
  nothing in electron-builder knows that: the filter starts by taking everything.

  Shipped, that dead half is 91 MB of the sidecar's 186 — and on Windows NSIS
  packs the whole app into app-64.7z with `-mx=9` hardcoded in
  app-builder-lib (out/targets/archive.js), whatever `compression` is set to.
  Three Windows jobs in a row were cancelled for running over an hour before
  anyone read a log; the payload is the lever that is actually left.

  Each platform block repeats the filter, so a fourth target — or a hand-edit
  of one block — can quietly put all of it back. This asserts it stays out of
  every one of them, and fails if a new block forgets.
*/
test("no platform ships the web half of transformers.js", () => {
  const lines = config.split("\n");
  const blocks = [];
  let platform = null;

  for (let i = 0; i < lines.length; i += 1) {
    const top = lines[i].match(/^([A-Za-z][\w-]*):/);
    if (top) platform = top[1];
    if (!/^\s*-\s+from:\s*voice-runtime\/node_modules\s*$/.test(lines[i])) continue;

    const patterns = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      // The next entry, or the next key at or above this entry's level.
      if (/^\s*-\s+from:/.test(lines[j]) || /^[A-Za-z]/.test(lines[j])) break;
      const pattern = lines[j].match(/^\s*-\s*"([^"]+)"\s*$/);
      if (pattern) patterns.push(pattern[1]);
    }
    blocks.push({ platform, patterns });
  }

  /*
    Two, not three, and Windows is the one missing.

    The rule this test exists for is "no platform ships what it cannot load",
    and a platform that ships none of the sidecar's dependencies at all cannot
    break it. Windows is that platform: packing the 573 MB into an NSIS archive
    is the step that has never once finished — 0.0.2, 0.0.3 and 0.0.5 all died
    on it — so the deps are dropped there entirely and `speech-local.js`
    degrades instead. See the comment on `win:` in electron-builder.yml and the
    wizard-download plan it points at. When that lands, Windows gets a block
    again and this floor goes back to three.

    Two is a floor, not a target: a NEW platform that ships the deps unpruned
    still has to add its own block, and the pattern check below still runs over
    every block that exists.
  */
  assert.ok(
    blocks.length >= 2,
    `expected the sidecar's dependencies to be pruned in every platform block that ships them, found ${blocks.length} — ` +
    "a new target must prune them too, or it ships 91 MB it cannot load",
  );

  assert.ok(
    !blocks.some((block) => block.platform === "win"),
    "win has a sidecar block again — restore its pruning patterns and raise the floor above",
  );

  // Every one of these was proven droppable by deleting it and running a real
  // Whisper transcription and a real Kokoro generation, not by reading imports.
  const dead = [
    "!**/onnxruntime-web/**",
    "!**/transformers/dist/transformers.web*",
    "!**/transformers/dist/*.wasm",
  ];

  for (const { platform: name, patterns } of blocks) {
    for (const pattern of dead) {
      assert.ok(
        patterns.includes(pattern),
        `the ${name} block does not exclude "${pattern}", so that build ships web assets ` +
        "the Node sidecar never loads — 91 MB through NSIS's hardcoded -mx=9",
      );
    }
  }
});
