import test from "node:test";
import assert from "node:assert/strict";
import { commandHead, createApprovalGate } from "../src/services/agentCommands.ts";

const request = (command) => ({ command, risk: "confirm", reason: "changes state" });

test("the approval unit is the executable", () => {
  assert.equal(commandHead("open -a VLC"), "open");
  assert.equal(commandHead("  git   push --force "), "git");
  assert.equal(commandHead(""), "");
});

test("a plain approval is not remembered", async () => {
  const gate = createApprovalGate();
  const first = gate.request(request("open -a VLC"));
  gate.settle(true);
  assert.equal(await first, true);
  gate.request(request("open -a Safari"));
  assert.ok(gate.pending(), "it must ask again");
  gate.cancel();
});

test("`always` covers the same executable and nothing else", async () => {
  const gate = createApprovalGate();
  const first = gate.request(request("open -a VLC"));
  gate.settle(true, true);
  assert.equal(await first, true);

  assert.equal(await gate.request(request("open -a Safari")), true);
  assert.equal(gate.pending(), null, "a remembered executable never stops the run");

  gate.request(request("rm -rf /"));
  assert.ok(gate.pending(), "a different executable is a different decision");
  gate.cancel();
});

test("a denial is never remembered", async () => {
  const gate = createApprovalGate();
  const first = gate.request(request("rm -rf /"));
  gate.settle(false, true);
  assert.equal(await first, false);
  gate.request(request("rm -rf ."));
  assert.ok(gate.pending(), "denying must not create a standing allowance");
  gate.cancel();
});

test("the promise still always settles", async () => {
  const gate = createApprovalGate();
  const first = gate.request(request("git push"));
  const second = gate.request(request("git tag"));
  assert.equal(await first, false, "a superseded request denies rather than hanging");
  gate.cancel();
  assert.equal(await second, false);
});
