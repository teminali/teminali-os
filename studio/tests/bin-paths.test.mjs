import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import { BIN_SEARCH_PATHS, withBinPaths } from "../server/bin-paths.js";

/**
 * The bug these guard against: a Finder-launched app gets launchd's PATH,
 * /usr/bin:/bin:/usr/sbin:/sbin, so `claude`, `gh` and `whisper-cli` all appear
 * uninstalled to the packaged build while resolving fine from a terminal.
 */

test("the launchd PATH is widened to reach package-manager prefixes", () => {
  const { PATH } = withBinPaths({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  const entries = PATH.split(path.delimiter);
  for (const dir of BIN_SEARCH_PATHS) assert.ok(entries.includes(dir), `${dir} missing`);
});

test("what the caller already had keeps its precedence", () => {
  const { PATH } = withBinPaths({ PATH: "/my/tools:/usr/bin" });
  assert.ok(PATH.startsWith("/my/tools:/usr/bin"));
});

test("a prefix already on PATH is not duplicated", () => {
  const { PATH } = withBinPaths({ PATH: "/opt/homebrew/bin:/usr/bin" });
  const occurrences = PATH.split(path.delimiter).filter((dir) => dir === "/opt/homebrew/bin");
  assert.equal(occurrences.length, 1);
  // First still wins, so an operator's ordering survives.
  assert.ok(PATH.startsWith("/opt/homebrew/bin:/usr/bin"));
});

test("applying it twice changes nothing", () => {
  const once = withBinPaths({ PATH: "/usr/bin" });
  assert.equal(withBinPaths(once).PATH, once.PATH);
});

test("everything else in the environment is carried through untouched", () => {
  const environment = withBinPaths({ PATH: "/usr/bin", HOME: "/tmp", ANTHROPIC_API_KEY: "key" });
  assert.equal(environment.HOME, "/tmp");
  assert.equal(environment.ANTHROPIC_API_KEY, "key");
});

test("an environment with no PATH still gets one", () => {
  const { PATH } = withBinPaths({ HOME: "/tmp" });
  assert.ok(PATH.split(path.delimiter).includes("/opt/homebrew/bin"));
});

test("the home-relative prefixes resolve against the real home", () => {
  assert.ok(BIN_SEARCH_PATHS.includes(path.join(os.homedir(), ".local/bin")));
});
