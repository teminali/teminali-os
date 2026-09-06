import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
  MACHINE_SEARCH_LIMIT,
  machineSearchAvailability,
  machineSearchQuery,
  parseSpotlightOutput,
  searchMachine,
  spotlightArgs,
} from "../server/machine-search.js";

/**
 * Searching the machine spawns a process with words the operator typed. Two
 * things are pinned here: that the query can never become anything but one
 * argument, and that a lane which cannot answer says so instead of hanging.
 */

/* ── The query never becomes a command ────────────────────────────────────── */

test("the query lands as one argument, whatever is in it", () => {
  const hostile = '"; rm -rf / #';
  const args = spotlightArgs(hostile, "/Users/x");
  assert.deepEqual(args, ["-onlyin", "/Users/x", "-name", hostile]);
  // Exactly four arguments: nothing was split, joined or interpolated.
  assert.equal(args.length, 4);
});

test("a query that would be read as a flag is refused before it is spawned", () => {
  assert.equal(machineSearchQuery("-onlyin"), null);
  assert.equal(machineSearchQuery("-"), null);
  // Too short to be an answer, and too long to be a name.
  assert.equal(machineSearchQuery("a"), null);
  assert.equal(machineSearchQuery(""), null);
  assert.equal(machineSearchQuery("x".repeat(201)), null);
  assert.equal(machineSearchQuery(null), null);
  assert.equal(machineSearchQuery(42), null);
  assert.equal(machineSearchQuery("  report.pdf  "), "report.pdf");
});

/* ── What comes back ──────────────────────────────────────────────────────── */

test("only absolute paths are kept, and only up to the limit", () => {
  const output = ["/a/one.txt", "", "  /b/two.txt  ", "relative/three.txt", "not a path"].join("\n");
  assert.deepEqual(parseSpotlightOutput(output), ["/a/one.txt", "/b/two.txt"]);
  assert.deepEqual(parseSpotlightOutput(null), []);
  const many = Array.from({ length: 100 }, (_, i) => `/x/${i}`).join("\n");
  assert.equal(parseSpotlightOutput(many).length, MACHINE_SEARCH_LIMIT);
  assert.equal(parseSpotlightOutput(many, 3).length, 3);
});

test("a platform with no index says so rather than walking the disk", async () => {
  assert.equal(machineSearchAvailability("darwin").available, true);
  for (const platform of ["win32", "linux", "freebsd"]) {
    const answer = machineSearchAvailability(platform);
    assert.equal(answer.available, false, platform);
    assert.match(answer.reason, /Spotlight/);
  }
  // And the search itself refuses without spawning anything.
  let spawned = false;
  const answer = await searchMachine("report", {
    availability: machineSearchAvailability("win32"),
    spawnImpl: () => {
      spawned = true;
      throw new Error("must not spawn");
    },
  });
  assert.equal(answer.available, false);
  assert.deepEqual(answer.results, []);
  assert.equal(spawned, false);
});

/* ── The spawn itself ─────────────────────────────────────────────────────── */

function fakeSpotlight(lines, { hang = false } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    if (!hang) {
      setImmediate(() => {
        child.stdout.emit("data", lines.join("\n"));
        child.emit("close", 0);
      });
    }
    return child;
  };
}

test("each path is classified as a file or a folder, and the missing are dropped", async () => {
  const answer = await searchMachine("report", {
    root: "/Users/x",
    availability: { available: true, reason: null },
    spawnImpl: fakeSpotlight(["/Users/x/report.pdf", "/Users/x/Reports", "/Users/x/gone.pdf"]),
    statImpl: async (path) => {
      if (path.endsWith("gone.pdf")) throw new Error("ENOENT");
      return { isDirectory: () => path.endsWith("Reports") };
    },
  });
  assert.deepEqual(answer.results, [
    { path: "/Users/x/report.pdf", name: "report.pdf", directory: false },
    { path: "/Users/x/Reports", name: "Reports", directory: true },
  ]);
});

test("a search that never answers is killed and reports nothing", async () => {
  const started = [];
  const spawnImpl = (...args) => {
    const child = fakeSpotlight([], { hang: true })(...args);
    started.push(child);
    return child;
  };
  const answer = await searchMachine("report", {
    availability: { available: true, reason: null },
    timeoutMs: 10,
    spawnImpl,
  });
  assert.deepEqual(answer.results, []);
  assert.equal(answer.available, true);
  assert.equal(started[0].killed, true, "the process must be killed, not left running");
});

test("a spawn that cannot start is nothing found, not a thrown error", async () => {
  const answer = await searchMachine("report", {
    availability: { available: true, reason: null },
    spawnImpl: () => {
      throw new Error("ENOENT /usr/bin/mdfind");
    },
  });
  assert.deepEqual(answer.results, []);
  assert.equal(answer.available, true);
});
