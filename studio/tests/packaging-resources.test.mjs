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
  the gateway lost its destination and its filter, the licence was copied on
  top of the path the gateway is imported from, and the macOS build failed
  during packaging with "not a file" — five minutes into a release, on a tag
  that had already been pushed.

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
    assert.equal(
      to, from.replace(/^\.\.\//, ""),
      `"${from}" is copied to "${to}", so an import of "../../${from.replace(/^\.\.\//, "")}/…" will not resolve`,
    );
  }
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
