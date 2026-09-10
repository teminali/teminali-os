import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  browserMcpArgs, browserMcpServerSpec, browserShimPath,
  BROWSER_SERVER_NAME, BROWSER_READ_TOOLS, BROWSER_EVAL_TOOL,
} from "../server/browser-mcp.js";
import { BROWSER_AGENT_ROUTES, BrowserActionError, parseBrowserAction, MAX_NETWORK_LIMIT } from "../server/browser-agent.js";
import { agentBriefing } from "../server/agent-briefing.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "browser-mcp-test-"));
}

/**
 * The assistant could not see a web page. It screenshotted the whole desktop
 * and ran the macOS accessibility tree through a vision model, which cannot
 * read past the fold and cannot click. What is pinned here is the shape of the
 * replacement: which tools are free, which are not, and that the one that runs
 * the agent's own code in someone else's document is never on the free list.
 */

/* ── The gate ─────────────────────────────────────────────────────────────── */

test("reading a page is free, acting on one is not", () => {
  assert.deepEqual([...BROWSER_READ_TOOLS], [
    "mcp__teminali-browser__page_snapshot",
    "mcp__teminali-browser__page_read",
    "mcp__teminali-browser__page_screenshot",
  ]);
});

test("page_eval is never pre-approved", () => {
  /*
    The load-bearing one. `page_eval` runs the agent's own JavaScript in
    someone else's document with the operator's cookies, and every other tool
    on this server can be written as an expression — so pre-approving it would
    pre-approve the click and the type at the same time, silently.
  */
  assert.equal(BROWSER_READ_TOOLS.includes(BROWSER_EVAL_TOOL), false);
  const { args } = browserMcpArgs("claude", "run-1", "tok-1", { tmpDir: tempDir(), execPath: "/bin/node" });
  const allowed = args[args.indexOf("--allowedTools") + 1];
  assert.equal(allowed.includes("page_eval"), false);
  assert.equal(allowed.includes("page_click"), false);
  assert.equal(allowed.includes("page_type"), false);
  assert.equal(allowed.includes("page_network"), false);
});

test("the server is not called `browser`, and never was", () => {
  // `workspace` shipped as a bare name and the CLI silently discarded it —
  // nine tools dark for as long as they existed. The prefix is the fix.
  assert.equal(BROWSER_SERVER_NAME, "teminali-browser");
  assert.equal(BROWSER_EVAL_TOOL, "mcp__teminali-browser__page_eval");
});

/* ── The spec ─────────────────────────────────────────────────────────────── */

test("the shim it points at is a real file", () => {
  assert.ok(fs.existsSync(browserShimPath()), `${browserShimPath()} does not exist`);
});

test("a run's token reaches the shim, and the gateway's bearer does not", () => {
  const spec = browserMcpServerSpec("run-2", "tok-2", { execPath: "/bin/node", port: 4319 });
  assert.equal(spec.env.TEMINALI_BROWSER_RUN, "run-2");
  assert.equal(spec.env.TEMINALI_BROWSER_TOKEN, "tok-2");
  assert.equal(spec.env.FRONTIER_GATEWAY_PORT, "4319");
  assert.equal(JSON.stringify(spec).includes("FRONTIER_SESSION_TOKEN"), false);
});

test("the config file carries the token and is not world-readable", () => {
  const { file } = browserMcpArgs("claude", "run-3", "tok-3", { tmpDir: tempDir(), execPath: "/bin/node" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, "utf8"), /tok-3/);
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`"${BROWSER_SERVER_NAME}"`));
});

test("no run and no bridgeable engine each mean no browser tools", () => {
  const tmpDir = tempDir();
  // Codex has no permission-prompt tool, so `page_eval` would be settled by a
  // sandbox flag with nobody asked — and a gate that cannot ask must not grant.
  assert.deepEqual(browserMcpArgs("codex", "run-4", "tok-4", { tmpDir }).args, []);
  assert.deepEqual(browserMcpArgs("claude", "", "tok-4", { tmpDir }).args, []);
  assert.deepEqual(browserMcpArgs("claude", "run-4", "", { tmpDir }).args, []);
});

test("the agent is told about the page only when the tools are attached", () => {
  assert.match(agentBriefing({ browser: true }), /page_snapshot/);
  // And is told to reach for the page rather than for a picture of the display.
  assert.match(agentBriefing({ browser: true }), /cannot read past the fold/);
  assert.doesNotMatch(agentBriefing({ browser: false }), /page_snapshot/);
});

/* ── The routes, decided ──────────────────────────────────────────────────── */

test("there are seven browser routes and they all parse", () => {
  assert.equal(BROWSER_AGENT_ROUTES.size, 7);
  const ops = [...BROWSER_AGENT_ROUTES].map((route) => {
    const body = { ref: "e1", text: "hi", expression: "1 + 1" };
    return parseBrowserAction(route, body).op;
  });
  assert.deepEqual(ops.sort(), ["click", "eval", "network", "read", "screenshot", "snapshot", "type"]);
});

test("a route this file does not know is refused rather than forwarded", () => {
  assert.throws(
    () => parseBrowserAction("/api/workspace/agent/browser/cookies", {}),
    (error) => error instanceof BrowserActionError && error.code === "BROWSER_OP_UNKNOWN",
  );
});

test("a click without a ref is refused before a page is touched", () => {
  // The round trip to the window and back costs the agent a wait; a refusal
  // that can be written from the argument alone should not cost a page visit.
  assert.throws(
    () => parseBrowserAction("/api/workspace/agent/browser/click", { ref: "  " }),
    (error) => error.code === "BROWSER_REF_REQUIRED",
  );
});

test("typing nothing with no submit is refused rather than reported as done", () => {
  /*
    Otherwise it focuses the field, types nothing, and answers with success —
    so the agent believes the form is filled and moves on.
  */
  assert.throws(
    () => parseBrowserAction("/api/workspace/agent/browser/type", { ref: "e1", text: "" }),
    (error) => error.code === "BROWSER_TEXT_REQUIRED",
  );
  // Enter on a field as it stands is a real thing to want, and is allowed.
  assert.deepEqual(
    parseBrowserAction("/api/workspace/agent/browser/type", { ref: "e1", submit: true }).params,
    { ref: "e1", text: "", submit: true },
  );
});

test("an empty expression is refused", () => {
  assert.throws(
    () => parseBrowserAction("/api/workspace/agent/browser/eval", { expression: "  " }),
    (error) => error.code === "BROWSER_EXPRESSION_REQUIRED",
  );
});

test("the network limit is clamped to what the log actually keeps", () => {
  assert.equal(parseBrowserAction("/api/workspace/agent/browser/network", { limit: 5000 }).params.limit, MAX_NETWORK_LIMIT);
  assert.equal(parseBrowserAction("/api/workspace/agent/browser/network", { limit: -3 }).params.limit, 50);
  assert.equal(parseBrowserAction("/api/workspace/agent/browser/network", {}).params.limit, 50);
});

test("an unknown mouse button becomes a left click, not a protocol error", () => {
  assert.equal(parseBrowserAction("/api/workspace/agent/browser/click", { ref: "e1", button: "mouse4" }).params.button, "left");
  assert.equal(parseBrowserAction("/api/workspace/agent/browser/click", { ref: "e1", button: "right" }).params.button, "right");
});

test("no argument anywhere can name a CDP method", () => {
  /*
    The security boundary, stated as a shape rather than as a filter: the ops
    are seven fixed names, and the params carry a ref, some text and a limit.
    Nothing on this path has a field a protocol method could travel in — so
    `WebAuthn.addVirtualAuthenticator` is not rejected here, it is unsayable.
  */
  const { op, params } = parseBrowserAction("/api/workspace/agent/browser/snapshot", {
    method: "WebAuthn.addVirtualAuthenticator",
    cdp: "Storage.getCookies",
  });
  assert.equal(op, "snapshot");
  assert.deepEqual(params, {});
});

/* ── The shim ─────────────────────────────────────────────────────────────── */

function askShim(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, "..", "electron", "browserMcpStdio.cjs")], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TEMINALI_BROWSER_RUN: "run", TEMINALI_BROWSER_TOKEN: "tok" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      resolve(out.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
    setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
  });
}

test("the shim speaks MCP and offers exactly the seven tools", async () => {
  const replies = await askShim([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  assert.equal(replies.find((reply) => reply.id === 1).result.serverInfo.name, BROWSER_SERVER_NAME);
  assert.deepEqual(replies.find((reply) => reply.id === 2).result.tools.map((tool) => tool.name), [
    "page_snapshot", "page_read", "page_screenshot", "page_click", "page_type", "page_network", "page_eval",
  ]);
});

test("a browser panel that cannot be reached is a result, not an aborted turn", async () => {
  // No gateway is listening on this port in a test run. "No browser panel is
  // open — call `browse` first" is an instruction the agent can act on; a
  // JSON-RPC error would end the turn mid-answer.
  const replies = await askShim([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "page_snapshot", arguments: {} } },
  ]);
  const result = replies.find((reply) => reply.id === 1).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Error: /);
});

test("an unknown tool is refused by name", async () => {
  const replies = await askShim([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "page_download", arguments: {} } },
  ]);
  assert.equal(replies.find((reply) => reply.id === 1).result.isError, true);
});
