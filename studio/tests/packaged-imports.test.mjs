/**
 * Every import under server/ must resolve in the PACKAGED layout, not just in
 * a checkout.
 *
 * v0.0.1 shipped a backend that could not load. server/speech-local.js imports
 * "../voice-runtime/lexicon.js"; from app.asar/server/ that is
 * app.asar/voice-runtime/lexicon.js, and voice-runtime ships beside the
 * archive rather than inside it. The import threw ERR_MODULE_NOT_FOUND while
 * server/gateway.js was still loading, createGateway never returned, and every
 * panel of every packaged build said "Failed to fetch".
 *
 * A checkout cannot notice: there the same path is studio/voice-runtime and it
 * resolves. Only the packaged tree is different, so this test models it —
 *
 *   app.asar/         ← the `files` allowlist, rooted at studio/
 *   <Resources>/      ← `extraResources`, one level further out
 *
 * and asserts each escaping import lands somewhere one of those two carries.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = readFileSync(join(STUDIO, "electron-builder.yml"), "utf8");

/** The `files:` allowlist — the paths that end up inside app.asar. */
function asarPatterns() {
  const out = [];
  let inside = false;
  for (const line of CONFIG.split("\n")) {
    if (/^files:/.test(line)) { inside = true; continue; }
    if (inside && /^[a-zA-Z]/.test(line)) break;
    const m = inside && line.match(/^\s+-\s+"?([^"#]+?)"?\s*$/);
    if (m && !m[1].startsWith("!")) out.push(m[1]);
  }
  return out;
}

/** Top-level `extraResources:` — `to:` names the directory under <Resources>. */
function extraResourceDirs() {
  const out = [];
  let inside = false;
  for (const line of CONFIG.split("\n")) {
    if (/^extraResources:/.test(line)) { inside = true; continue; }
    if (inside && /^[a-zA-Z]/.test(line)) break;
    const m = inside && line.match(/^\s+to:\s+"?([^"#]+?)"?\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Does an asar pattern such as `server/**\/*` cover this path? */
function covered(patterns, path) {
  return patterns.some((pattern) => {
    if (pattern === path) return true;
    const rx = new RegExp("^" + pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\/\*/g, ".*")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*") + "$");
    return rx.test(path);
  });
}

/** Every relative import in server/*.js that leaves the server/ directory. */
function escapingImports() {
  const found = [];
  for (const file of readdirSync(join(STUDIO, "server")).filter((f) => f.endsWith(".js"))) {
    if (file.endsWith(".test.js")) continue;
    const source = readFileSync(join(STUDIO, "server", file), "utf8");
    for (const m of source.matchAll(/from\s+"(\.\.\/[^"]+)"/g)) {
      found.push({ file: `server/${file}`, specifier: m[1] });
    }
  }
  return found;
}

const ASAR = asarPatterns();
const RESOURCES = extraResourceDirs();

test("the allowlist and the extra resources were both parsed", () => {
  assert.ok(ASAR.includes("server/**/*"), "server/ must be in the asar");
  assert.ok(RESOURCES.includes("gateway"), "the gateway must be an extra resource");
});

test("server/ has imports that leave the directory, or this test is watching nothing", () => {
  assert.ok(escapingImports().length >= 4);
});

for (const { file, specifier } of escapingImports()) {
  test(`${file} → ${specifier} resolves in a packaged build`, () => {
    // Where the specifier points, relative to the asar root (= studio/).
    const fromAsarRoot = posix.normalize(posix.join(posix.dirname(file), specifier));

    if (!fromAsarRoot.startsWith("..")) {
      // Stays inside the archive: the allowlist has to carry it.
      assert.ok(
        covered(ASAR, fromAsarRoot),
        `${specifier} stays inside app.asar as ${fromAsarRoot}, but no \`files\` `
        + `entry ships it. Either add it to files: or import it via ../../ so it `
        + `resolves against <Resources>. This is the v0.0.1 gateway failure.`,
      );
      assert.ok(existsSync(join(STUDIO, fromAsarRoot)), `${fromAsarRoot} does not exist`);
      return;
    }

    // Escapes the archive: it must land in a directory extraResources copies.
    const underResources = fromAsarRoot.replace(/^\.\.\//, "");
    const top = underResources.split("/")[0];
    assert.ok(
      RESOURCES.includes(top),
      `${specifier} resolves to <Resources>/${underResources}, but nothing `
      + `copies "${top}" there.`,
    );
    const onDisk = resolve(STUDIO, posix.dirname(file), specifier);
    assert.ok(existsSync(onDisk), `${relative(STUDIO, onDisk)} does not exist in the checkout`);
  });
}

