/*
  The workspace MCP surface — the agent's hands on the editor around it.

  What these guard is the line between showing and changing. `reveal` opens
  folders in a tree the operator is already looking at and is pre-approved;
  `open_project` rebinds the workspace root, which is what bounds every
  workspace route, the search and every terminal, and must go through the
  permission prompt. A refactor that pre-approved the server rather than the
  one tool would erase that line silently, so it is asserted here.
*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  workspaceMcpArgs, workspaceMcpServerSpec, workspaceShimPath,
  WORKSPACE_SERVER_NAME, WORKSPACE_READ_TOOL,
} from "../server/workspace-mcp.js";
import { openRun, closeRun, emitToRun, runAuthorises } from "../server/permission-bridge.js";
import { agentBriefing } from "../server/agent-briefing.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "workspace-mcp-test-"));
}

/* ── The spec and the flags ─────────────────────────────────────────────── */

test("the shim it points at is a real file", () => {
  assert.ok(fs.existsSync(workspaceShimPath()), `${workspaceShimPath()} does not exist`);
});

test("a run's token reaches the shim, and the gateway's bearer does not", () => {
  const spec = workspaceMcpServerSpec("run-1", "tok-1", { execPath: "/bin/node", port: 4319 });
  assert.equal(spec.env.TEMINALI_WORKSPACE_RUN, "run-1");
  assert.equal(spec.env.TEMINALI_WORKSPACE_TOKEN, "tok-1");
  assert.equal(spec.env.FRONTIER_GATEWAY_PORT, "4319");
  assert.equal(JSON.stringify(spec).includes("FRONTIER_SESSION_TOKEN"), false);
});

test("only `reveal` is pre-approved — naming the server would allow the project switch too", () => {
  const tmpDir = tempDir();
  const { args } = workspaceMcpArgs("claude", "run-2", "tok-2", { tmpDir, execPath: "/bin/node" });
  const allowed = args[args.indexOf("--allowedTools") + 1];
  assert.equal(allowed, WORKSPACE_READ_TOOL);
  assert.equal(allowed, "mcp__workspace__reveal");
  assert.equal(allowed.includes("open_project"), false);
  // The bare server name allows everything on it. It must not appear alone.
  assert.notEqual(allowed, `mcp__${WORKSPACE_SERVER_NAME}`);
});

test("the config file carries the token and is not world-readable", () => {
  const tmpDir = tempDir();
  const { file } = workspaceMcpArgs("claude", "run-3", "tok-3", { tmpDir, execPath: "/bin/node" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, "utf8"), /tok-3/);
});

test("no run and no bridgeable engine each mean no workspace tools", () => {
  const tmpDir = tempDir();
  assert.deepEqual(workspaceMcpArgs("codex", "run-4", "tok-4", { tmpDir }).args, []);
  assert.deepEqual(workspaceMcpArgs("claude", "", "tok-4", { tmpDir }).args, []);
  assert.deepEqual(workspaceMcpArgs("claude", "run-4", "", { tmpDir }).args, []);
});

/* ── The channel back to the window ─────────────────────────────────────── */

test("a reveal reaches the run's own stream, and only on that run's token", () => {
  const seen = [];
  const token = openRun("run-emit", (event) => seen.push(event));

  assert.equal(emitToRun("run-emit", token, { type: "workspace", action: "reveal", path: "src" }), true);
  assert.deepEqual(seen, [{ type: "workspace", action: "reveal", path: "src" }]);

  assert.equal(emitToRun("run-emit", "not-the-token", { type: "workspace", action: "reveal", path: "src" }), false);
  assert.equal(seen.length, 1, "a bad token must not put an event on the stream");

  closeRun("run-emit");
  // A turn the operator stopped can no longer move their file tree.
  assert.equal(emitToRun("run-emit", token, { type: "workspace", action: "reveal", path: "src" }), false);
  assert.equal(runAuthorises("run-emit", token), false);
});

/* ── What the agent is told ─────────────────────────────────────────────── */

test("the agent is told about the tree only when the tools are attached", () => {
  assert.match(agentBriefing({ workspace: true }), /reveal/);
  assert.equal(agentBriefing({ workspace: false }).includes("reveal"), false);
});

/* ── The tool surface, driven for real over stdio ───────────────────────── */

function askShim(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workspaceShimPath()], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TEMINALI_WORKSPACE_RUN: "r", TEMINALI_WORKSPACE_TOKEN: "t" },
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

test("the shim speaks MCP and offers exactly the three tools the design names", async () => {
  const replies = await askShim([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);

  assert.equal(replies.find((reply) => reply.id === 1).result.serverInfo.name, "workspace");
  const names = replies.find((reply) => reply.id === 2).result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["open_project", "recent_projects", "reveal"]);
});

test("an unknown tool is a result the agent can act on, not an aborted turn", async () => {
  const replies = await askShim([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_everything", arguments: {} } },
  ]);
  const result = replies.find((reply) => reply.id === 1).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /is not a workspace tool/);
});

test("the gateway keeps the workspace agent routes above the bearer gate", async () => {
  const source = await fs.promises.readFile(path.join(here, "..", "server", "gateway.js"), "utf8");
  const bridge = source.indexOf("WORKSPACE_AGENT_ROUTES.has(route)");
  const gate = source.indexOf("AUTH_REQUIRED");
  assert.ok(bridge > 0 && gate > 0);
  /*
    The shim holds a run token, never a session bearer. Moving these routes
    below the gate would make every workspace call from an agent a 401 — the
    same regression the screen bridge guards against a few lines away.
  */
  assert.ok(bridge < gate, "the workspace agent routes must be answered before the bearer gate");
});
