/*
  The workspace MCP surface — the agent's hands on the editor around it.

  What these guard is the line between showing and changing. `reveal` opens
  folders in a tree the operator is already looking at and `open_file` opens
  one of those files into the file panel; both only show, and both are
  pre-approved. `open_project` rebinds the workspace root, which is what bounds
  every workspace route, the search and every terminal, and must go through the
  permission prompt. A refactor that pre-approved the server rather than the
  showing tools would erase that line silently, so it is asserted here.
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
  WORKSPACE_SERVER_NAME, WORKSPACE_READ_TOOL, WORKSPACE_READ_TOOLS,
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

test("the server is not called `workspace` — the CLI throws that name away", () => {
  /*
    Claude Code reserves `workspace`. A server declared under that name in
    `--mcp-config` is discarded before it is spawned: no stderr, no entry in
    the CLI's `mcp_servers`, no failed status — the tools are simply not
    there, and the agent reports that it cannot switch projects. That is what
    shipped, and nothing caught it, because every unit here passes on a name
    the CLI silently refuses. This assertion is the only place that knows.
  */
  assert.notEqual(WORKSPACE_SERVER_NAME, "workspace");
  assert.ok(
    WORKSPACE_READ_TOOLS.every((tool) => tool.startsWith(`mcp__${WORKSPACE_SERVER_NAME}__`)),
    "every pre-approved tool must carry the server's real name",
  );
});

test("a run's token reaches the shim, and the gateway's bearer does not", () => {
  const spec = workspaceMcpServerSpec("run-1", "tok-1", { execPath: "/bin/node", port: 4319 });
  assert.equal(spec.env.TEMINALI_WORKSPACE_RUN, "run-1");
  assert.equal(spec.env.TEMINALI_WORKSPACE_TOKEN, "tok-1");
  assert.equal(spec.env.FRONTIER_GATEWAY_PORT, "4319");
  assert.equal(JSON.stringify(spec).includes("FRONTIER_SESSION_TOKEN"), false);
});

test("only the showing tools are pre-approved — naming the server would allow the project switch too", () => {
  const tmpDir = tempDir();
  const { args } = workspaceMcpArgs("claude", "run-2", "tok-2", { tmpDir, execPath: "/bin/node" });
  const allowed = args[args.indexOf("--allowedTools") + 1];
  /*
    Six tools now, and each widening was deliberate: `open_file` opens a file
    the operator could open with one click, through the same route and the same
    limits, and writes nothing; `browse` shows a page the same way, and the
    three browser reads read. What must never join them is anything that
    changes something — a confirmation the operator can answer is the only
    thing standing between the agent and the ground under their feet. That is
    why `bookmark` is not here.
  */
  assert.deepEqual(allowed.split(","), [
    "mcp__teminali-workspace__reveal",
    "mcp__teminali-workspace__open_file",
    "mcp__teminali-workspace__browse",
    "mcp__teminali-workspace__bookmarks",
    "mcp__teminali-workspace__browsing_history",
    "mcp__teminali-workspace__downloads",
  ]);
  assert.equal(allowed.includes("mcp__teminali-workspace__bookmark,"), false);
  assert.deepEqual(allowed.split(","), [...WORKSPACE_READ_TOOLS]);
  assert.equal(WORKSPACE_READ_TOOL, "mcp__teminali-workspace__reveal");
  assert.equal(allowed.includes("open_project"), false);
  // The bare server name allows everything on it. It must not appear alone.
  assert.equal(allowed.split(",").includes(`mcp__${WORKSPACE_SERVER_NAME}`), false);
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

test("an opened file reaches the window as its own action, not as a reveal", () => {
  const seen = [];
  const token = openRun("run-open", (event) => seen.push(event));

  assert.equal(emitToRun("run-open", token, { type: "workspace", action: "open-file", path: "src/App.tsx" }), true);
  /*
    A distinct action, deliberately. The renderer answers `reveal` by scrolling
    the tree and `open-file` by opening the panel; collapsing them would mean
    either every reveal opens a tab, or the operator asked to see a file and
    got a highlighted row.
  */
  assert.deepEqual(seen, [{ type: "workspace", action: "open-file", path: "src/App.tsx" }]);
  closeRun("run-open");
});

/* ── What the agent is told ─────────────────────────────────────────────── */

test("the agent is told about the tree only when the tools are attached", () => {
  assert.match(agentBriefing({ workspace: true }), /reveal/);
  assert.match(agentBriefing({ workspace: true }), /open_file/);
  assert.equal(agentBriefing({ workspace: false }).includes("reveal"), false);
  assert.equal(agentBriefing({ workspace: false }).includes("open_file"), false);
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

test("the shim speaks MCP and offers exactly the nine tools the design names", async () => {
  const replies = await askShim([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);

  assert.equal(replies.find((reply) => reply.id === 1).result.serverInfo.name, WORKSPACE_SERVER_NAME);
  const names = replies.find((reply) => reply.id === 2).result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["bookmark", "bookmarks", "browse", "browsing_history", "downloads", "open_file", "open_project", "recent_projects", "reveal"]);
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
