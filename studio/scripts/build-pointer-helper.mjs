#!/usr/bin/env node
/**
 * Compiles the macOS pointer helper.
 *
 * The helper is Swift source in the repository rather than a checked-in binary
 * or a native npm module, and that is three deliberate choices at once:
 *
 *  - No `robotjs` and no `@nut-tree` — one needs a native build toolchain on
 *    every install, the other needs a licence.
 *  - No committed binary — an unsigned Mach-O in git is something nobody can
 *    audit and everybody has to trust.
 *  - No install hook — a Linux or Windows checkout must not fail `npm install`
 *    over a capability it was never going to have.
 *
 * So it is built on demand, and the gateway reports "not built" as an ordinary
 * state with a one-line fix rather than as an error.
 */

import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const HELPER_SOURCE = resolve(here, "..", "native", "macos", "pointer", "main.swift");
export const HELPER_BINARY = resolve(here, "..", "native", "macos", "bin", "teminali-pointer");

function run(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => resolvePromise({ ok: false, stderr: error.message }));
    child.on("close", (code) => resolvePromise({ ok: code === 0, stderr }));
  });
}

/** True when the compiled helper is newer than its source. */
export async function helperIsCurrent() {
  try {
    const [binary, source] = await Promise.all([stat(HELPER_BINARY), stat(HELPER_SOURCE)]);
    return binary.mtimeMs >= source.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ built: boolean, reason?: string }>} Never throws: a
 * machine without Xcode's command line tools is an ordinary machine.
 */
export async function buildPointerHelper({ force = false } = {}) {
  if (process.platform !== "darwin") {
    return { built: false, reason: "The pointer helper is macOS-only." };
  }
  if (!force && (await helperIsCurrent())) return { built: true };

  const swift = await run("/usr/bin/xcrun", ["--find", "swiftc"]);
  if (!swift.ok) {
    return {
      built: false,
      reason: "swiftc was not found. Install Xcode's command line tools with: xcode-select --install",
    };
  }

  await mkdir(dirname(HELPER_BINARY), { recursive: true });
  const compile = await run("/usr/bin/xcrun", ["swiftc", "-O", "-o", HELPER_BINARY, HELPER_SOURCE]);
  if (!compile.ok) {
    return { built: false, reason: compile.stderr.trim().split("\n").slice(0, 4).join(" ") || "swiftc failed." };
  }
  return { built: true };
}

// Direct invocation: `node scripts/build-pointer-helper.mjs`
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = await buildPointerHelper({ force: process.argv.includes("--force") });
  if (result.built) {
    process.stdout.write(`Pointer helper built: ${HELPER_BINARY}\n`);
  } else {
    process.stderr.write(`Pointer helper not built: ${result.reason}\n`);
    process.exitCode = 1;
  }
}
