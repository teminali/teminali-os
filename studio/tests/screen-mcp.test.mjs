/**
 * The screen MCP server: the chat pane's hands.
 *
 * What these tests are actually protecting is the design, not the plumbing.
 * Two properties matter more than the rest and each has a test that fails
 * loudly if a later change quietly relaxes it:
 *
 *   1. No tool takes a coordinate. `noToolTakesACoordinate` walks every input
 *      schema the shim advertises and fails on an `x`, `y` or `point`.
 *   2. Only `look` is pre-approved. Naming the whole server in `--allowedTools`
 *      would move the operator's pointer with no prompt they could refuse.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { screenMcpArgs, screenMcpServerSpec, screenShimPath, SCREEN_SERVER_NAME, SCREEN_READ_TOOL } from "../server/screen-mcp.js";
import { openRun, closeRun, runAuthorises } from "../server/permission-bridge.js";
import { agentBriefing, briefingArgs } from "../server/agent-briefing.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "screen-mcp-test-"));
}

/* ── The spec and the flags ─────────────────────────────────────────────── */

test("the shim it points at is a real file", () => {
  assert.ok(fs.existsSync(screenShimPath()), `${screenShimPath()} does not exist`);
});

test("a run's token reaches the shim, and nothing else does", () => {
  const spec = screenMcpServerSpec("run-1", "tok-1", { execPath: "/bin/node", port: 4319 });
  assert.equal(spec.env.TEMINALI_SCREEN_RUN, "run-1");
  assert.equal(spec.env.TEMINALI_SCREEN_TOKEN, "tok-1");
  assert.equal(spec.env.FRONTIER_GATEWAY_PORT, "4319");
  // The gateway's own bearer must never travel to an agent's child process.
  assert.equal(JSON.stringify(spec).includes("FRONTIER_SESSION_TOKEN"), false);
});

test("only `look` is pre-approved", () => {
  const dir = tempDir();
  const { args } = screenMcpArgs("claude", "run-2", "tok-2", { tmpDir: dir, execPath: "/bin/node" });
  const allowed = args[args.indexOf("--allowedTools") + 1];
  assert.equal(allowed, SCREEN_READ_TOOL);
  assert.equal(allowed, "mcp__screen__look");
  /*
    The failure this guards against is `mcp__screen`, which allows every tool on
    the server. It reads like a small tidy-up and it silently removes the
    operator's chance to refuse a click.
  */
  assert.notEqual(allowed, `mcp__${SCREEN_SERVER_NAME}`);
});

test("the config file carries the token and is not world-readable", () => {
  const dir = tempDir();
  const { file } = screenMcpArgs("claude", "run-3", "tok-3", { tmpDir: dir, execPath: "/bin/node" });
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.mcpServers.screen.env.TEMINALI_SCREEN_TOKEN, "tok-3");
});

test("no grant, no run and no bridgeable engine each mean no hands", () => {
  const dir = tempDir();
  const opts = { tmpDir: dir, execPath: "/bin/node" };
  // Accessibility not granted.
  assert.deepEqual(screenMcpArgs("claude", "r", "t", { ...opts, available: false }).args, []);
  // No approval bridge to gate the tools with.
  assert.deepEqual(screenMcpArgs("claude", null, "t", opts).args, []);
  assert.deepEqual(screenMcpArgs("claude", "r", "", opts).args, []);
  // Codex cannot be asked, so it must not be granted.
  assert.deepEqual(screenMcpArgs("codex", "r", "t", opts).args, []);
});

/* ── The run token ──────────────────────────────────────────────────────── */

test("a run's token authorises that run and dies with it", () => {
  const token = openRun("run-auth", () => {});
  assert.equal(runAuthorises("run-auth", token), true);
  assert.equal(runAuthorises("run-auth", "not-it"), false);
  assert.equal(runAuthorises("other-run", token), false);
  assert.equal(runAuthorises("run-auth", ""), false);
  closeRun("run-auth");
  assert.equal(runAuthorises("run-auth", token), false);
});

/* ── The briefing ───────────────────────────────────────────────────────── */

test("the agent is told it is in an application, not a terminal", () => {
  const briefing = agentBriefing({ screen: true, video: true });
  assert.match(briefing, /Teminali Code/);
  assert.match(briefing, /not a terminal/);
  /*
    The two names the product must never be called appear here exactly once
    each, inside the sentence that forbids them. The agent has read this
    repository's history and will otherwise reach for them.
  */
  assert.match(briefing, /It is not "Teminali Studio" and not "Frontier Code"/);
  assert.equal(briefing.match(/Teminali Studio/g).length, 1);
  assert.equal(briefing.match(/Frontier Code/g).length, 1);
});

test("an agent without hands is told so rather than left to discover it", () => {
  const without = agentBriefing({ screen: false });
  assert.match(without, /no screen tools/);
  assert.equal(/`look` returns the frontmost application/.test(without), false);

  const with_ = agentBriefing({ screen: true });
  assert.match(with_, /never guess at a position/);
  assert.match(with_, /Never type a password/);
});

test("only Claude takes a briefing; Codex would see it as the operator's words", () => {
  assert.equal(briefingArgs("claude", { screen: true })[0], "--append-system-prompt");
  assert.deepEqual(briefingArgs("codex", { screen: true }), []);
});

/* ── The tool surface, driven for real over stdio ───────────────────────── */

/** Speaks JSON-RPC to the shim the way a CLI would, and collects the replies. */
function askShim(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [screenShimPath()], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TEMINALI_SCREEN_RUN: "r", TEMINALI_SCREEN_TOKEN: "t" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      resolve(out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
}

test("the shim speaks MCP and lists the hands the design promises", async () => {
  const replies = await askShim([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);

  const init = replies.find((reply) => reply.id === 1);
  assert.equal(init.result.serverInfo.name, "screen");

  const tools = replies.find((reply) => reply.id === 2).result.tools;
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["click", "drag", "focus", "key", "launch", "look", "scroll", "type", "wait"]);
});

test("no tool takes a coordinate", async () => {
  const replies = await askShim([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }]);
  const tools = replies.find((reply) => reply.id === 1).result.tools;

  /*
    The whole design rests on this. A model's guess at a position must have no
    way to reach the screen, so the surface it is offered may not contain one —
    `dx`/`dy` are displacements from an element the operating system located,
    which is a different thing from a point on a screen.
    */
  const forbidden = new Set(["x", "y", "point", "position", "coordinate", "coordinates", "left", "top"]);
  for (const tool of tools) {
    for (const property of Object.keys(tool.inputSchema?.properties ?? {})) {
      assert.equal(forbidden.has(property), false, `${tool.name} accepts "${property}"`);
    }
  }
});

test("an action before any look is refused with something the agent can act on", async () => {
  const replies = await askShim([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "click", arguments: { element: "e1" } } },
  ]);
  const result = replies.find((reply) => reply.id === 1).result;
  // A tool result, not a JSON-RPC error: an error code usually aborts the turn.
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /look at the screen first/);
});

test("the gateway's own source keeps the agent routes above the bearer gate", async () => {
  const source = await fs.promises.readFile(path.join(here, "..", "server", "gateway.js"), "utf8");
  const bridge = source.indexOf("SCREEN_AGENT_ROUTES.has(route)");
  const gate = source.indexOf("AUTH_REQUIRED");
  assert.ok(bridge > 0 && gate > 0);
  /*
    The shim has no session bearer by design. If a refactor moved these routes
    below the gate they would answer 401 to every call and the hands would stop
    working with no other symptom.
  */
  assert.ok(bridge < gate, "the screen bridge routes must be answered before the bearer gate");
});
