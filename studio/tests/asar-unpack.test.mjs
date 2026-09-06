/**
 * A shim that rewrites its path to app.asar.unpacked must actually be
 * unpacked.
 *
 * The four MCP shims are spawned as their own processes, so they have to be
 * real files on disk — nothing can spawn a path inside an asar. Each
 * `*ShimPath()` rewrites `app.asar/` to `app.asar.unpacked/`, and
 * electron-builder only puts a file there if `asarUnpack` names it.
 *
 * The two halves live in different files and nothing tied them together, so
 * the camera shipped with the rewrite and without the entry: v0.0.2's packaged
 * app had screen, video and workspace under app.asar.unpacked/electron/ and no
 * cameraMcpStdio.cjs. The agent was pointed at a file that did not exist, the
 * server exited immediately, and the model reported "teminali-camera failed to
 * connect (Connection closed)" — then answered questions about the operator
 * from screenshots, having never opened the webcam.
 *
 * A checkout cannot notice: there is no asar, the rewrite is a no-op, and the
 * shim is exactly where the path says it is.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = readFileSync(join(STUDIO, "electron-builder.yml"), "utf8");

/** The files electron-builder is told to leave outside the archive. */
function unpacked() {
  const out = [];
  let inside = false;
  for (const line of CONFIG.split("\n")) {
    if (/^asarUnpack:/.test(line)) { inside = true; continue; }
    if (inside && /^[a-zA-Z]/.test(line)) break;
    const m = inside && line.match(/^\s+-\s+"?([^"#]+?)"?\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Every server module that rewrites a path into app.asar.unpacked. */
function rewriters() {
  const found = [];
  for (const file of readdirSync(join(STUDIO, "server")).filter((f) => f.endsWith(".js"))) {
    const source = readFileSync(join(STUDIO, "server", file), "utf8");
    if (!source.includes("app.asar.unpacked")) continue;
    // The join() that builds the path names the file it points at.
    for (const m of source.matchAll(/join\(\s*here\s*,\s*"\.\."\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)) {
      found.push({ file: `server/${file}`, target: `${m[1]}/${m[2]}` });
    }
  }
  return found;
}

const UNPACKED = unpacked();
const REWRITERS = rewriters();

test("the config and the shims were both parsed", () => {
  assert.ok(UNPACKED.length >= 3, "asarUnpack should list the shims");
  assert.ok(REWRITERS.length >= 4, `expected every shim to be found, got ${REWRITERS.length}`);
});

for (const { file, target } of REWRITERS) {
  test(`${target} is unpacked for ${file}`, () => {
    assert.ok(
      UNPACKED.includes(target),
      `${file} rewrites its path into app.asar.unpacked, but asarUnpack does not list `
      + `"${target}" — so the packaged app spawns a file that is not there and the server `
      + `dies on start. This is the v0.0.2 camera failure.`,
    );
  });
}

test("nothing is unpacked that no shim asks for", () => {
  const wanted = new Set(REWRITERS.map((r) => r.target));
  for (const entry of UNPACKED) {
    assert.ok(wanted.has(entry), `asarUnpack carries "${entry}" but no server module rewrites to it`);
  }
});
