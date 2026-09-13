/*
  The per-address connect deadline, and the two places main.cjs applies it.

  Nothing here can reproduce the failure. It needs a TCP handshake slower than
  250 ms and an IPv6 address with no route, and loopback has neither. So the
  arithmetic is tested directly, the flag is handed to a real Node to prove it
  is one Node accepts, and the wiring is read from main.cjs the way
  recorder-bridge.test.mjs reads it: deleting either line breaks only a network
  no CI runner sits on.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { ATTEMPT_FLOOR_MS, raiseAddressAttemptBudget, addressAttemptArgs } = require("../electron/addressAttempts.cjs");
const mainSource = readFileSync(join(here, "..", "electron", "main.cjs"), "utf8");

/** Stands in for node:net's two default accessors, so no test moves the real one. */
function fakeNet(initial) {
  let value = initial;
  return {
    getDefaultAutoSelectFamilyAttemptTimeout: () => value,
    setDefaultAutoSelectFamilyAttemptTimeout: (next) => { value = next; },
  };
}

test("Electron's 250 ms deadline is raised to the floor", () => {
  const net = fakeNet(250);
  assert.equal(raiseAddressAttemptBudget(net), ATTEMPT_FLOOR_MS);
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), ATTEMPT_FLOOR_MS);
});

test("a deadline already above the floor is left alone", () => {
  const net = fakeNet(ATTEMPT_FLOOR_MS * 3);
  assert.equal(raiseAddressAttemptBudget(net), ATTEMPT_FLOOR_MS * 3);
});

test("the child's flag carries the deadline without moving the parent's", () => {
  const net = fakeNet(250);
  assert.deepEqual(addressAttemptArgs(net), [`--network-family-autoselection-attempt-timeout=${ATTEMPT_FLOOR_MS}`]);
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 250);
  assert.deepEqual(addressAttemptArgs(fakeNet(4000)), ["--network-family-autoselection-attempt-timeout=4000"]);
});

test("Node accepts the flag, and the child starts with the floor", () => {
  // A misspelt flag would not be ignored: Node exits with "bad option", and the
  // voice sidecar would never start. Only a real process can tell.
  const probe = "process.stdout.write(String(require('net').getDefaultAutoSelectFamilyAttemptTimeout()))";
  const result = spawnSync(process.execPath, [...addressAttemptArgs(fakeNet(250)), "-e", probe], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, String(ATTEMPT_FLOOR_MS));
});

test("main.cjs raises the deadline at load, before the gateway is imported", () => {
  assert.match(mainSource, /require\("\.\/addressAttempts\.cjs"\)/, "main.cjs does not require addressAttempts.cjs");
  const call = mainSource.search(/^raiseAddressAttemptBudget\(\);$/m);
  assert.ok(call > -1, "main.cjs never calls raiseAddressAttemptBudget() at top level");
  assert.ok(call < mainSource.indexOf("await import(gatewayUrl)"), "the deadline is raised after the gateway loads");
});

test("the voice sidecar is spawned with the same deadline", () => {
  assert.match(mainSource, /spawn\(process\.execPath, \[\.\.\.addressAttemptArgs\(\), entry\]/);
});
