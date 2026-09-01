import assert from "node:assert/strict";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentRuntimeError } from "./errors.js";
import { GatewayPlanner } from "./gateway-planner.js";
import { SingleAgentRuntime } from "./runtime.js";
import { StateStore } from "./state-store.js";
import { WorkspaceTools } from "./workspace-tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "seeded-multi-file");
const VERIFY_COMMANDS = [
  { argv: ["node", "--test", "test/regression.test.js"] },
  { argv: ["node", "--test", "test/acceptance.test.js"] },
];

async function copyFixture(label) {
  const root = await mkdtemp(join(tmpdir(), `frontier-agent-${label}-`));
  const workspace = join(root, "workspace");
  await cp(FIXTURE, workspace, { recursive: true });
  return workspace;
}

function usage(stage) {
  const records = {
    plan: { promptTokens: 10, completionTokens: 5, totalDurationNs: 1000 },
    repair: { promptTokens: 12, completionTokens: 5, totalDurationNs: 2000 },
    review: { promptTokens: 8, completionTokens: 2, totalDurationNs: 500 },
  };
  return { source: "deterministic-test-planner", model: "fixture-planner-v1", ...records[stage] };
}

function deterministicPlanner() {
  return {
    async plan() {
      return {
        value: {
          rationale: "Correct the divisor first and verify before touching the formatter.",
          edits: [{
            path: "src/arithmetic.js",
            before: "return sum(values) / (values.length - 1);",
            after: "return sum(values) / values.length;",
          }],
        },
        usage: usage("plan"),
      };
    },
    async repair(context) {
      assert.equal(context.failedVerification.passed, false);
      assert.match(context.failedVerification.commands[1].stdout, /fail 1/);
      return {
        value: {
          rationale: "The remaining acceptance failure is the summary label.",
          edits: [{
            path: "src/summary.js",
            before: "return `Average=${mean(values)}`;",
            after: "return `Average: ${mean(values)}`;",
          }],
        },
        usage: usage("repair"),
      };
    },
    async review(context) {
      const changed = context.changedFiles.map((file) => file.path).sort();
      const findings = [];
      if (!context.verification.passed) findings.push("Verification is not passing.");
      if (JSON.stringify(changed) !== JSON.stringify(["src/arithmetic.js", "src/summary.js"])) findings.push("Unexpected files changed.");
      return { value: { approved: findings.length === 0, findings }, usage: usage("review") };
    },
  };
}

function runtimeOptions(workspace, planner, runId) {
  return {
    workspace,
    runId,
    objective: "Repair mean calculation and public summary formatting without regressing sum behavior.",
    acceptanceCriteria: [
      "mean([2, 4, 6]) returns 4",
      "summarize([2, 4, 6]) returns Average: 4",
      "sum and empty-array regression behavior remains unchanged",
      "README.md remains byte-for-byte unchanged",
    ],
    editablePaths: ["src/arithmetic.js", "src/summary.js"],
    verifyCommands: VERIFY_COMMANDS,
    allowedCommands: ["node"],
    maxRepairAttempts: 2,
    planner,
  };
}

test("single agent autonomously repairs a seeded multi-file defect with exact evidence", async () => {
  const workspace = await copyFixture("repair");
  const sentinelBefore = await readFile(join(workspace, "README.md"), "utf8");
  const runtime = new SingleAgentRuntime(runtimeOptions(workspace, deterministicPlanner(), "seeded-repair"));

  const report = await runtime.run();

  assert.equal(report.status, "completed");
  assert.deepEqual(report.changedFiles.map((file) => file.path), ["src/arithmetic.js", "src/summary.js"]);
  assert.equal(await readFile(join(workspace, "README.md"), "utf8"), sentinelBefore);
  assert.deepEqual(report.verification.map((attempt) => attempt.passed), [false, true]);
  assert.equal(report.verification.at(-1).commands.every((command) => command.exitCode === 0 && command.passed), true);
  assert.match(report.verification.at(-1).commands[0].stdout, /pass 2/);
  assert.match(report.verification.at(-1).commands[1].stdout, /pass 2/);
  assert.deepEqual(report.modelUsage, {
    calls: 3,
    promptTokens: 30,
    completionTokens: 12,
    totalDurationNs: 3500,
    complete: true,
    records: [
      { stage: "plan", ...usage("plan") },
      { stage: "repair", ...usage("repair") },
      { stage: "review", ...usage("review") },
    ],
  });
  assert.equal(report.repairAttempts, 1);
  assert.ok(report.elapsedMs > 0);
  assert.ok(report.toolCalls.some((call) => call.tool === "applyPatch" && call.path === "src/arithmetic.js" && call.changed));
  assert.ok(report.toolCalls.some((call) => call.tool === "applyPatch" && call.path === "src/summary.js" && call.changed));
  assert.deepEqual(report.transitions.map(({ from, to }) => `${from}->${to}`), [
    "inspect->plan",
    "plan->edit",
    "edit->verify",
    "verify->repair",
    "repair->edit",
    "edit->verify",
    "verify->review",
    "review->report",
    "report->complete",
  ]);

  const persisted = await new StateStore(workspace).load("seeded-repair");
  assert.equal(persisted.status, "completed");
  assert.deepEqual(persisted.acceptanceCriteria, report.acceptanceCriteria);
  assert.equal(persisted.report.runId, report.runId);
});

test("a failed run resumes from persisted state without repeating inspection", async () => {
  const workspace = await copyFixture("resume");
  let firstCall = true;
  const interruptedPlanner = {
    ...deterministicPlanner(),
    async plan() {
      if (firstCall) {
        firstCall = false;
        throw new AgentRuntimeError("MODEL_OFFLINE", "Injected planner interruption.");
      }
      return deterministicPlanner().plan();
    },
  };
  const first = new SingleAgentRuntime(runtimeOptions(workspace, interruptedPlanner, "resumable-run"));
  await assert.rejects(first.run(), (error) => error.code === "MODEL_OFFLINE");
  const interruptedState = await new StateStore(workspace).load("resumable-run");
  assert.equal(interruptedState.state, "plan");
  assert.equal(interruptedState.status, "failed");

  const resumed = new SingleAgentRuntime(runtimeOptions(workspace, deterministicPlanner(), "resumable-run"));
  const report = await resumed.run();
  assert.equal(report.status, "completed");
  assert.equal(report.transitions.filter(({ from }) => from === "inspect").length, 1);
  assert.deepEqual(report.changedFiles.map((file) => file.path), ["src/arithmetic.js", "src/summary.js"]);
});

test("workspace tools reject traversal and edits outside explicit scope", async () => {
  const workspace = await copyFixture("scope");
  const tools = new WorkspaceTools({ workspace, editablePaths: ["src/arithmetic.js"], allowedCommands: ["node"] });
  await tools.initialize();
  await assert.rejects(tools.read("../outside.txt"), (error) => error.code === "PATH_ESCAPE");
  await assert.rejects(
    tools.applyPatch({ path: "README.md", before: "Seeded", after: "Changed" }),
    (error) => error.code === "OUTSIDE_EDIT_SCOPE",
  );
  await assert.rejects(
    tools.run({ argv: ["sh", "-c", "echo unsafe"] }),
    (error) => error.code === "COMMAND_NOT_ALLOWED",
  );
  assert.throws(() => new StateStore(workspace, join(workspace, "..", "escaped-state")), (error) => error.code === "STATE_PATH_ESCAPE");
});

test("shell cancellation terminates a running verification command", async () => {
  const workspace = await copyFixture("cancel");
  const tools = new WorkspaceTools({ workspace, editablePaths: ["src/arithmetic.js"], allowedCommands: ["node"], commandTimeoutMs: 2_000 });
  await tools.initialize();
  const controller = new AbortController();
  const pending = tools.run({ argv: ["node", "-e", "setInterval(() => {}, 1000)"] }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (error) => error.code === "CANCELLED");
});

test("repeated repair patches are stopped by loop detection", async () => {
  const workspace = await copyFixture("loop");
  const repeatedRepair = {
    ...deterministicPlanner(),
    async repair() {
      return {
        value: {
          rationale: "A deliberately ineffective repeated repair.",
          edits: [{ path: "src/summary.js", before: "Average=", after: "Average - " }],
        },
        usage: usage("repair"),
      };
    },
  };
  const runtime = new SingleAgentRuntime({ ...runtimeOptions(workspace, repeatedRepair, "loop-run"), maxRepairAttempts: 3 });
  await assert.rejects(runtime.run(), (error) => error.code === "LOOP_DETECTED");
  const state = await new StateStore(workspace).load("loop-run");
  assert.equal(state.status, "failed");
  assert.equal(state.lastError.code, "LOOP_DETECTED");
  assert.equal(state.report, null);
});

test("passing commands cannot hide a mutation outside the declared edit scope", async () => {
  const workspace = await copyFixture("unrelated");
  const planner = {
    async plan() {
      return {
        value: {
          rationale: "Repair both declared files.",
          edits: [
            { path: "src/arithmetic.js", before: "return sum(values) / (values.length - 1);", after: "return sum(values) / values.length;" },
            { path: "src/summary.js", before: "return `Average=${mean(values)}`;", after: "return `Average: ${mean(values)}`;" },
          ],
        },
        usage: usage("plan"),
      };
    },
    async repair() {
      throw new Error("repair must not be reached");
    },
    async review() {
      throw new Error("review must not run after an unrelated mutation");
    },
  };
  const runtime = new SingleAgentRuntime({
    ...runtimeOptions(workspace, planner, "unrelated-run"),
    verifyCommands: [
      { argv: ["node", "-e", 'require("node:fs").writeFileSync("README.md", "mutated\\n")'] },
      ...VERIFY_COMMANDS,
    ],
  });
  await assert.rejects(runtime.run(), (error) => error.code === "UNRELATED_FILE_CHANGED");
  const state = await new StateStore(workspace).load("unrelated-run");
  assert.equal(state.status, "failed");
  assert.equal(state.report, null);
});

test("gateway planner parses authoritative Ollama usage and rejects unstructured output", async () => {
  const requests = [];
  let valid = true;
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), authorization: init.headers.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      model: "devstral-test",
      message: { content: valid ? JSON.stringify({ edits: [{ path: "src/arithmetic.js", before: "old", after: "new" }], rationale: "exact" }) : "not-json" },
      prompt_eval_count: 21,
      eval_count: 8,
      total_duration: 1234,
    }), { headers: { "content-type": "application/json" } });
  };
  const planner = new GatewayPlanner({ gatewayUrl: "http://127.0.0.1:4310", token: "a-private-session-token", model: "devstral", fetchImpl });
  const result = await planner.plan({ objective: "test" });
  assert.deepEqual(result.usage, { source: "ollama", model: "devstral-test", promptTokens: 21, completionTokens: 8, totalDurationNs: 1234 });
  assert.equal(requests[0].url, "http://127.0.0.1:4310/api/ollama/chat");
  assert.equal(requests[0].authorization, "Bearer a-private-session-token");
  assert.equal(JSON.stringify(result).includes("a-private-session-token"), false);

  valid = false;
  await assert.rejects(planner.plan({ objective: "test" }), (error) => error.code === "INVALID_MODEL_RESPONSE");
});
