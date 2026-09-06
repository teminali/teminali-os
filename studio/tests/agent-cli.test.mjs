import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENTS,
  agentEnvironment,
  isAgentEngine,
  resolveAgentCwd,
  runAgentTurn,
} from "../server/agent-cli.js";

/**
 * These drive a fake agent — a node script that prints canned NDJSON on stdout —
 * through the real `runAgentTurn`. Spawning, line framing, JSON parsing,
 * normalisation, and the close/limit paths are therefore all exercised for real,
 * with no network, no credentials, and no cost. The canned lines below are
 * copied from actual `claude --output-format stream-json` and `codex exec --json`
 * output rather than invented, which is the only reason they are worth asserting
 * against.
 */

const root = mkdtempSync(join(tmpdir(), "agent-cli-test-"));

/**
 * Writes an executable fake agent that prints `lines` as NDJSON and exits.
 *
 * It is the binary itself rather than a script passed to node, so the real
 * agent arguments `runAgentTurn` builds are appended and harmlessly ignored —
 * which means the spawn path under test is the production one, not a variant.
 */
function fakeAgent(lines, { exitCode = 0, stderr = "" } = {}) {
  const file = join(root, `fake-${randomUUID()}.mjs`);
  const body = lines.map((line) => `process.stdout.write(${JSON.stringify(`${JSON.stringify(line)}\n`)});`).join("\n");
  writeFileSync(
    file,
    `#!${process.execPath}\n${body}\n${stderr ? `process.stderr.write(${JSON.stringify(stderr)});\n` : ""}process.exit(${exitCode});\n`,
    { mode: 0o755 },
  );
  return file;
}

async function collect(engine, lines, options = {}) {
  const events = [];
  const outcome = await runAgentTurn({
    engine,
    prompt: "test",
    root,
    bin: fakeAgent(lines, options),
    permission: options.permission,
    onEvent: (event) => events.push(event),
  });
  return { events, outcome };
}

/* ── Boundaries ──────────────────────────────────────────────────────────── */

test("an agent cannot be pointed outside the workspace", () => {
  assert.equal(resolveAgentCwd("/work", ""), "/work");
  assert.equal(resolveAgentCwd("/work", "src"), "/work/src");
  assert.throws(() => resolveAgentCwd("/work", "../etc"), /AGENT_CWD_ESCAPE/);
  assert.throws(() => resolveAgentCwd("/work", "/etc"), /AGENT_CWD_ESCAPE/);
  assert.throws(() => resolveAgentCwd("/work", "a\0b"), /INVALID_AGENT_CWD/);
});

test("the gateway's own session token never reaches an agent", () => {
  const environment = agentEnvironment({
    FRONTIER_SESSION_TOKEN: "secret",
    ANTHROPIC_API_KEY: "key",
    PATH: "/usr/bin",
  });
  assert.equal(environment.FRONTIER_SESSION_TOKEN, undefined);
  // The provider key is how the CLI authenticates; scrubbing it would break the
  // agent rather than protect anything.
  assert.equal(environment.ANTHROPIC_API_KEY, "key");
  // PATH is widened, not replaced: what the caller had stays first, and the
  // package-manager prefixes follow so a Finder launch can still find the CLI.
  assert.ok(environment.PATH.startsWith("/usr/bin"));
  assert.ok(environment.PATH.split(":").includes("/opt/homebrew/bin"));
});

test("only the two known engines are accepted", () => {
  assert.ok(isAgentEngine("claude"));
  assert.ok(isAgentEngine("codex"));
  assert.equal(isAgentEngine("gpt"), false);
  assert.equal(isAgentEngine("__proto__"), false);
});

test("neither agent defaults to its most permissive mode", () => {
  for (const [engine, agent] of Object.entries(AGENTS)) {
    assert.notEqual(
      agent.defaultPermission,
      agent.permissions.at(-1),
      `${engine} must not default to full access`,
    );
    assert.ok(agent.permissions.includes(agent.defaultPermission));
  }
});

/* ── Claude normalisation ────────────────────────────────────────────────── */

const CLAUDE_TURN = [
  { type: "system", subtype: "init", session_id: "sess-1", model: "claude-haiku-4-5", cwd: "/w", tools: ["Bash"] },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }, { type: "text", text: "Hello" }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "a.txt" }] } },
  { type: "result", subtype: "success", is_error: false, duration_ms: 1200, total_cost_usd: 0.02, session_id: "sess-1", usage: { output_tokens: 7 }, result: "Hello", permission_denials: [] },
];

test("claude text is taken from deltas only, never doubled by the settled message", async () => {
  const { events } = await collect("claude", CLAUDE_TURN);
  const text = events.filter((e) => e.type === "token").map((e) => e.text).join("");
  // The settled `assistant` message repeats the same prose. Counting it too
  // would render "HelloHello", which is the bug this asserts against.
  assert.equal(text, "Hello");
});

test("claude tool calls transition running to completed under one id", async () => {
  const { events } = await collect("claude", CLAUDE_TURN);
  const tools = events.filter((e) => e.type === "tool");
  assert.equal(tools.length, 2);
  assert.deepEqual(
    tools.map((t) => [t.id, t.status]),
    [["t1", "running"], ["t1", "completed"]],
  );
  assert.equal(tools[0].name, "Bash");
  assert.equal(tools[1].output, "a.txt");
});

test("claude session, cost and duration are carried through verbatim", async () => {
  const { events, outcome } = await collect("claude", CLAUDE_TURN);
  const session = events.find((e) => e.type === "session");
  assert.equal(session.sessionId, "sess-1");
  assert.equal(session.model, "claude-haiku-4-5");

  const result = events.find((e) => e.type === "result");
  assert.equal(result.ok, true);
  assert.equal(result.costUsd, 0.02);
  assert.equal(result.durationMs, 1200);
  assert.equal(outcome.sessionId, "sess-1");
});

test("plan windows are lifted off the turn's own stream", async () => {
  // Copied from a real `rate_limit_event`: the CLI reports the account's
  // headroom on the same stream it reports tokens on, which is the whole
  // reason the studio can show a plan meter without a second request.
  const { events } = await collect("claude", [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.63,
        isUsingOverage: false,
        unifiedWindows: {
          five_hour: { utilization: 0.8, resetsAt: 1788468600 },
          seven_day: { utilization: 0.63, resetsAt: 1788886800 },
        },
      },
    },
  ]);

  const limits = events.filter((e) => e.type === "limits");
  assert.equal(limits.length, 1);
  assert.equal(limits[0].status, "allowed_warning");
  assert.equal(limits[0].isUsingOverage, false);
  assert.deepEqual(limits[0].windows, [
    { id: "five_hour", utilization: 0.8, resetsAt: 1788468600 },
    { id: "seven_day", utilization: 0.63, resetsAt: 1788886800 },
  ]);
});

test("a rate limit event with no windows reports nothing rather than zero", async () => {
  // An API-key login has no plan behind it and says so by omission. Emitting a
  // limits event here would draw an empty meter, which reads as "nothing used".
  const { events } = await collect("claude", CLAUDE_TURN);
  assert.equal(events.filter((e) => e.type === "limits").length, 0);
});

test("a failed claude turn reports why rather than resolving empty", async () => {
  const { events } = await collect("claude", [
    { type: "system", subtype: "init", session_id: "s", model: "m", cwd: "/w", tools: [] },
    { type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 5, session_id: "s", result: "You've hit your usage limit.", permission_denials: [] },
  ]);
  const result = events.find((e) => e.type === "result");
  assert.equal(result.ok, false);
  assert.equal(result.text, "You've hit your usage limit.");
});

test("refused tool calls are surfaced, not swallowed", async () => {
  const { events } = await collect("claude", [
    { type: "result", subtype: "success", is_error: false, duration_ms: 1, session_id: "s", result: "", permission_denials: [{ tool_name: "Bash" }] },
  ]);
  assert.equal(events.find((e) => e.type === "result").permissionDenials.length, 1);
});

/* ── Codex normalisation ─────────────────────────────────────────────────── */

test("codex items become tool steps and its message becomes prose", async () => {
  const { events } = await collect("codex", [
    { type: "thread.started", thread_id: "th-1" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "i1", item_type: "command_execution", command: "ls" } },
    { type: "item.completed", item: { id: "i1", item_type: "command_execution", command: "ls", exit_code: 0, aggregated_output: "a.txt" } },
    { type: "item.completed", item: { id: "i2", item_type: "agent_message", text: "Done." } },
    { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 4 } },
  ]);

  assert.equal(events.find((e) => e.type === "session").sessionId, "th-1");

  const tools = events.filter((e) => e.type === "tool");
  assert.deepEqual(tools.map((t) => t.status), ["running", "completed"]);
  assert.equal(tools[1].output, "a.txt");

  assert.equal(events.filter((e) => e.type === "token").map((e) => e.text).join(""), "Done.");
  assert.equal(events.find((e) => e.type === "result").ok, true);
});

test("a non-zero codex command is an errored step, not a completed one", async () => {
  const { events } = await collect("codex", [
    { type: "thread.started", thread_id: "th" },
    { type: "item.completed", item: { id: "i1", item_type: "command_execution", command: "false", exit_code: 1, aggregated_output: "" } },
  ]);
  assert.equal(events.find((e) => e.type === "tool").status, "error");
});

test("a codex turn failure reports its message", async () => {
  const { events } = await collect("codex", [
    { type: "thread.started", thread_id: "th" },
    { type: "turn.failed", error: { message: "You've hit your usage limit." } },
  ]);
  const result = events.find((e) => e.type === "result");
  assert.equal(result.ok, false);
  assert.equal(result.text, "You've hit your usage limit.");
});

test("an unrecognised codex item is shown rather than dropped", async () => {
  // A future CLI version will emit item types this build has never seen. A
  // silently incomplete transcript is worse than an unfamiliar step in it.
  const { events } = await collect("codex", [
    { type: "thread.started", thread_id: "th" },
    { type: "item.completed", item: { id: "x", item_type: "some_future_thing", detail: 1 } },
  ]);
  const tool = events.find((e) => e.type === "tool");
  assert.equal(tool.name, "some_future_thing");
  assert.equal(tool.status, "completed");
});

/* ── Process handling ────────────────────────────────────────────────────── */

test("a missing CLI is reported as not installed rather than as a crash", async () => {
  const events = [];
  const outcome = await runAgentTurn({
    engine: "claude",
    prompt: "x",
    root,
    bin: join(root, "definitely-not-a-real-binary"),
    onEvent: (event) => events.push(event),
  });
  const error = events.find((e) => e.type === "error");
  assert.equal(error.code, "AGENT_NOT_INSTALLED");
  assert.match(error.message, /not installed/);
  assert.equal(outcome.reason, "AGENT_NOT_INSTALLED");
});

test("a non-zero exit with no result of its own still closes the turn", async () => {
  // Otherwise the pane streams nothing and simply stops, with no explanation.
  const { events, outcome } = await collect("claude", [], { exitCode: 3, stderr: "boom" });
  const result = events.find((e) => e.type === "result");
  assert.equal(result.ok, false);
  assert.match(result.text, /boom|status 3/);
  assert.equal(outcome.reason, "AGENT_NONZERO_EXIT");
});

test("a line that is not JSON is passed through as a notice rather than dropped", async () => {
  const file = join(root, `notice-${randomUUID()}.mjs`);
  writeFileSync(file, `#!${process.execPath}\nprocess.stdout.write("Warning: something\\n");\nprocess.exit(0);\n`, { mode: 0o755 });
  const events = [];
  await runAgentTurn({ engine: "claude", prompt: "x", root, bin: file, onEvent: (e) => events.push(e) });
  assert.equal(events.find((e) => e.type === "notice")?.text, "Warning: something");
});

test("aborting a turn stops the agent", async () => {
  const file = join(root, `slow-${randomUUID()}.mjs`);
  writeFileSync(file, `#!${process.execPath}\nsetTimeout(() => process.exit(0), 60000);\n`, { mode: 0o755 });
  const controller = new AbortController();
  const started = Date.now();
  const promise = runAgentTurn({ engine: "claude", prompt: "x", root, bin: file, signal: controller.signal, onEvent: () => {} });
  controller.abort();
  const outcome = await promise;
  assert.equal(outcome.reason, "AGENT_ABORTED");
  assert.ok(Date.now() - started < 10_000, "abort must not wait for the process to finish");
});

/* ── Token and cost accounting ───────────────────────────────────────────── */

/**
 * The usage block below is copied verbatim from a real `claude -p` turn. It is
 * the reason this accounting is done from `modelUsage` rather than `usage`:
 * that turn used two models, and `usage` describes only the second one.
 */
const REAL_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 3486,
  session_id: "s",
  total_cost_usd: 0.17312699999999998,
  result: "DONE",
  permission_denials: [],
  usage: {
    input_tokens: 4,
    cache_creation_input_tokens: 40808,
    cache_read_input_tokens: 40580,
    output_tokens: 81,
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": { inputTokens: 906, outputTokens: 11, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.000961 },
    "claude-sonnet-5": { inputTokens: 4, outputTokens: 81, cacheReadInputTokens: 40580, cacheCreationInputTokens: 40808, costUSD: 0.17216599999999999 },
  },
};

test("claude token counts come from every model the turn used, not just the last", async () => {
  const { events } = await collect("claude", [REAL_RESULT]);
  const usage = events.find((e) => e.type === "result").usage;

  // usage.input_tokens alone reports 4. The turn actually consumed 910.
  assert.equal(usage.inputTokens, 910);
  assert.equal(usage.outputTokens, 92);
  assert.equal(usage.cacheReadTokens, 40580);
  assert.equal(usage.cacheCreationTokens, 40808);
  assert.equal(usage.models.length, 2);
});

test("per-model costs sum to the total the CLI reported", async () => {
  const { events } = await collect("claude", [REAL_RESULT]);
  const result = events.find((e) => e.type === "result");
  const summed = result.usage.models.reduce((total, m) => total + (m.costUsd ?? 0), 0);
  assert.ok(Math.abs(summed - result.costUsd) < 1e-9, `${summed} should equal ${result.costUsd}`);
});

test("cache tokens are not dropped from the prompt total", async () => {
  const { events } = await collect("claude", [REAL_RESULT]);
  const u = events.find((e) => e.type === "result").usage;
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  assert.equal(prompt, 82298, "a turn that read and wrote 80k of cache did not have a 910-token prompt");
});

test("falling back to usage when modelUsage is absent still counts cache", async () => {
  const { events } = await collect("claude", [{ ...REAL_RESULT, modelUsage: undefined }]);
  const u = events.find((e) => e.type === "result").usage;
  assert.deepEqual(
    { i: u.inputTokens, o: u.outputTokens, r: u.cacheReadTokens, c: u.cacheCreationTokens },
    { i: 4, o: 81, r: 40580, c: 40808 },
  );
});

test("codex reports tokens but no cost, and null must not become zero", async () => {
  const { events } = await collect("codex", [
    { type: "thread.started", thread_id: "t" },
    { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30, total_tokens: 190 } },
  ]);
  const result = events.find((e) => e.type === "result");
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.cacheReadTokens, 40);
  assert.equal(result.usage.outputTokens, 30);
  // Codex bills against the ChatGPT subscription and reports no figure. Showing
  // $0.00 would claim the turn was free.
  assert.equal(result.costUsd, null, "an unreported cost must stay null, never 0");
});

test("a zero cache field is counted as zero, not treated as missing", async () => {
  // `a ?? b` returns 0 when a is 0, which is correct — this pins it, because the
  // two CLIs use different key names and a fallback chain here would silently
  // read the wrong engine's field.
  const { events } = await collect("claude", [
    { ...REAL_RESULT, modelUsage: { m: { inputTokens: 5, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 } } },
  ]);
  const u = events.find((e) => e.type === "result").usage;
  assert.equal(u.cacheReadTokens, 0);
  assert.equal(u.inputTokens, 5);
});

/* ── Edits on their way to the review dock ───────────────────────────────── */

/**
 * The end of the wiring, over a real spawn and a real file.
 *
 * The fake agent below does what a real one does and the canned-line fakes
 * above cannot: it announces a tool call, then actually writes the file, then
 * reports the result. That ordering is the whole reason the snapshot is taken
 * on the server — see server/agent-edits.js.
 */
function fakeEditingAgent(target, { before, after, delayMs = 60 }) {
  writeFileSync(target, before);
  const announce = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: target, old_string: before.trim(), new_string: after.trim() } }] } };
  const settle = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } };
  const file = join(root, `fake-edit-${randomUUID()}.mjs`);
  writeFileSync(
    file,
    [
      `#!${process.execPath}`,
      `import { writeFileSync } from "node:fs";`,
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(announce)}\n`)});`,
      `setTimeout(() => {`,
      `  writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(after)});`,
      `  process.stdout.write(${JSON.stringify(`${JSON.stringify(settle)}\n`)});`,
      `  process.exit(0);`,
      `}, ${delayMs});`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return file;
}

test("a file the agent writes mid-turn comes back as an edit, both sides of it", async () => {
  const target = join(root, "reviewed.ts");
  const events = [];
  await runAgentTurn({
    engine: "claude",
    prompt: "test",
    root,
    bin: fakeEditingAgent(target, { before: "const a = 1;\n", after: "const a = 2;\n" }),
    onEvent: (event) => events.push(event),
  });

  const edit = events.find((event) => event.type === "edit");
  assert.ok(edit, "the turn produced no edit event");
  assert.equal(edit.path, "reviewed.ts", "the dock addresses files the way the workspace API does");
  assert.equal(edit.before, "const a = 1;\n");
  assert.equal(edit.after, "const a = 2;\n");
  assert.equal(edit.existedBefore, true);
  // After the tool it describes: the pane draws the step, then the dock row.
  assert.ok(events.indexOf(edit) > events.findIndex((event) => event.type === "tool"));
});

test("a turn with no workspace root watches nothing rather than guessing a path", async () => {
  const target = join(root, "unrooted.ts");
  const events = [];
  await runAgentTurn({
    engine: "claude",
    prompt: "test",
    root: "",
    bin: fakeEditingAgent(target, { before: "const a = 1;\n", after: "const a = 3;\n" }),
    onEvent: (event) => events.push(event),
  });
  assert.equal(events.some((event) => event.type === "edit"), false);
});

/* ── The turn ends with the process, not with its pipes ─────────────────── */

test("a turn ends when the agent exits, even while a grandchild holds its pipes open", async () => {
  /*
    The fake agent answers, spawns a detached child that INHERITS its stdio —
    an MCP server it never took down — and exits. `close` on the agent cannot
    fire until that child lets go of the pipes, six seconds later; the turn
    has to end well before that, on `exit` plus the grace period.
  */
  const file = join(root, `fake-${randomUUID()}.mjs`);
  const answer = JSON.stringify({
    type: "result", subtype: "success", is_error: false, duration_ms: 3, total_cost_usd: 0,
    session_id: "sess-orphan", usage: { output_tokens: 1 }, result: "done", permission_denials: [],
  });
  writeFileSync(
    file,
    `#!${process.execPath}
import { spawn } from "node:child_process";
process.stdout.write(${JSON.stringify(`${answer}\n`)});
const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { stdio: "inherit", detached: true });
orphan.unref();
process.exit(0);
`,
    { mode: 0o755 },
  );

  const started = Date.now();
  const events = [];
  const outcome = await runAgentTurn({
    engine: "claude", prompt: "test", root, bin: file, onEvent: (event) => events.push(event),
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 4_000, `the turn waited ${elapsed} ms for an orphan's pipes`);
  assert.equal(outcome.reason, null);
  assert.equal(events.find((e) => e.type === "result")?.ok, true);
});
