/**
 * Run Mode, the deletion guard, and the allowlist the gate now keeps.
 *
 * The settings row is the visible half of this; these are the half that
 * decides whether a command runs. Every case here is written against
 * `runAgentCommands` rather than the pane, because the pane can only be as
 * honest as the thing underneath it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createApprovalGate,
  isDestructiveCommand,
  runAgentCommands,
} from "../src/services/agentCommands.ts";
import { normalizeAllowlist, normalizePreferences } from "../src/services/preferences.ts";

/** A fence the parser accepts, so the runner sees exactly one command. */
const fence = (command) => ["```frontier-run", command, "```"].join("\n");

/** Records what actually executed, and answers approvals however told to. */
const harness = (answer) => {
  const ran = [];
  const asked = [];
  return {
    ran,
    asked,
    options: {
      execute: async (command) => {
        ran.push(command);
        return { code: 0, durationMs: 1, truncated: false };
      },
      approve: async (request) => {
        asked.push(request.command);
        return answer;
      },
    },
  };
};

test("review is the default and is what the runner always did", async () => {
  const readOnly = harness(false);
  await runAgentCommands(fence("ls -la"), readOnly.options);
  assert.deepEqual(readOnly.ran, ["ls -la"], "a read-only command runs unasked");
  assert.deepEqual(readOnly.asked, []);

  const writing = harness(false);
  await runAgentCommands(fence("npm install left-pad"), writing.options);
  assert.deepEqual(writing.ran, [], "a state-changing command waits");
  assert.deepEqual(writing.asked, ["npm install left-pad"]);
});

test("ask puts a read-only command in front of a human too", async () => {
  const denied = harness(false);
  await runAgentCommands(fence("ls -la"), { ...denied.options, runMode: "ask" });
  assert.deepEqual(denied.ran, []);
  assert.deepEqual(denied.asked, ["ls -la"], "nothing runs unseen in this mode");

  const allowed = harness(true);
  await runAgentCommands(fence("ls -la"), { ...allowed.options, runMode: "ask" });
  assert.deepEqual(allowed.ran, ["ls -la"]);
});

test("a command skipped only because of the mode says so, not the classifier's verdict", async () => {
  const denied = harness(false);
  const [execution] = await runAgentCommands(fence("ls -la"), { ...denied.options, runMode: "ask" });
  assert.match(execution.note, /every command is set to ask first/);
  assert.equal(execution.executed, false);
});

test("auto runs a state-changing command without asking", async () => {
  const auto = harness(false);
  await runAgentCommands(fence("npm install left-pad"), { ...auto.options, runMode: "auto" });
  assert.deepEqual(auto.ran, ["npm install left-pad"]);
  assert.deepEqual(auto.asked, [], "nobody was asked");
});

test("auto still stops for a delete while the guard is on", async () => {
  const guarded = harness(false);
  await runAgentCommands(fence("rm -f build/out.js"), { ...guarded.options, runMode: "auto" });
  assert.deepEqual(guarded.ran, [], "the delete did not run");
  assert.deepEqual(guarded.asked, ["rm -f build/out.js"]);

  const unguarded = harness(false);
  await runAgentCommands(fence("rm -f build/out.js"), {
    ...unguarded.options,
    runMode: "auto",
    protectDeletions: false,
  });
  assert.deepEqual(unguarded.ran, ["rm -f build/out.js"], "turning the guard off is honoured");
});

test("no mode runs a blocked command", async () => {
  for (const runMode of ["ask", "review", "auto"]) {
    const gate = harness(true);
    const [execution] = await runAgentCommands(fence("sudo rm -rf /"), {
      ...gate.options,
      runMode,
      protectDeletions: false,
    });
    assert.deepEqual(gate.ran, [], `blocked ran under ${runMode}`);
    assert.deepEqual(gate.asked, [], `blocked was offered for approval under ${runMode}`);
    assert.match(execution.note, /^Refused:/);
  }
});

test("destructive is about what cannot be recovered, not what is risky", () => {
  for (const command of [
    "rm -rf node_modules",
    "git clean -fd",
    "git reset --hard HEAD~1",
    "find . -name '*.log' -delete",
    "npm uninstall left-pad",
    "docker rmi my-image",
    "echo hello > notes.txt",
  ]) {
    assert.equal(isDestructiveCommand(command), true, command);
  }

  for (const command of [
    "ls -la",
    "npm install left-pad",
    "git status",
    "echo hello >> notes.txt",
    "grep -rn 'rm' src/",
    "node --test",
  ]) {
    assert.equal(isDestructiveCommand(command), false, command);
  }
});

test("a saved allowlist skips the prompt in a fresh gate", async () => {
  const gate = createApprovalGate(undefined, { allowlist: ["npm"] });
  assert.equal(await gate.request({ command: "npm install left-pad", risk: "confirm", reason: "x" }), true);
  assert.equal(gate.pending(), null, "a saved entry does not stop the run");
});

test("a new `always` is handed out exactly once, and only when it is new", async () => {
  const remembered = [];
  const gate = createApprovalGate(undefined, {
    allowlist: ["npm"],
    onRemember: (scope) => remembered.push(scope),
  });

  const first = gate.request({ command: "open -a VLC", risk: "confirm", reason: "x" });
  gate.settle(true, true);
  assert.equal(await first, true);
  assert.deepEqual(remembered, ["open"]);

  // Already held: granting it again must not churn the stored list.
  const second = gate.request({ command: "npm ci", risk: "confirm", reason: "x" });
  assert.equal(await second, true);
  assert.deepEqual(remembered, ["open"]);
});

test("the stored list is the truth, so removing an entry takes effect at once", async () => {
  const gate = createApprovalGate(undefined, { allowlist: ["npm"] });
  gate.replaceAllowlist([]);
  gate.request({ command: "npm ci", risk: "confirm", reason: "x" });
  assert.ok(gate.pending(), "the removed entry must ask again");
  gate.cancel();
});

test("the allowlist is bounded, unique and free of arguments", () => {
  assert.deepEqual(normalizeAllowlist(["npm", "npm", " git ", "", "rm -rf /", null]), ["npm", "git"]);
  assert.deepEqual(normalizeAllowlist("npm"), [], "a non-array is not a list");
  assert.equal(normalizeAllowlist(Array.from({ length: 500 }, (_, i) => `cmd${i}`)).length, 200);
});

test("the new agent preferences have defaults and survive a bad persisted shape", () => {
  const fresh = normalizePreferences();
  assert.equal(fresh.runMode, "review", "the default mode is the reviewed one");
  assert.equal(fresh.protectDeletions, true);
  assert.equal(fresh.submitWithModEnter, false);
  assert.deepEqual(fresh.commandAllowlist, []);

  const rescued = normalizePreferences({ runMode: "sandbox", commandAllowlist: "npm" });
  assert.equal(rescued.runMode, "review", "a mode we do not have falls back to the default");
  assert.deepEqual(rescued.commandAllowlist, []);
});
