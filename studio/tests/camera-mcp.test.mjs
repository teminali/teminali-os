import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  cameraMcpArgs, cameraMcpServerSpec, cameraShimPath,
  CAMERA_SERVER_NAME, CAMERA_TOOL, CAMERA_READ_TOOLS,
} from "../server/camera-mcp.js";
import { agentBriefing } from "../server/agent-briefing.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "camera-mcp-test-"));
}

/**
 * The operator asked whether the assistant could see them, and it answered by
 * looking at their screen — correctly, because that was the only sense it had.
 * What is pinned here is the shape of the second one: that it is attached, that
 * it is not free, and that a machine without a camera gets an answer rather
 * than a broken turn.
 */

test("the shim it points at is a real file", () => {
  assert.ok(fs.existsSync(cameraShimPath()), `${cameraShimPath()} does not exist`);
});

test("the server is not called `camera`, and never was", () => {
  /*
    `workspace` shipped as a bare name and was silently discarded by the CLI,
    which reserves it — nine tools dark for as long as they existed. `camera`
    is not reserved today. The prefix is what stops this one being the next to
    find out, and this assertion is what stops someone shortening it back.
  */
  assert.equal(CAMERA_SERVER_NAME, "teminali-camera");
  assert.equal(CAMERA_TOOL, "mcp__teminali-camera__look_at_me");
});

test("a run's token reaches the shim, and the gateway's bearer does not", () => {
  const spec = cameraMcpServerSpec("run-1", "tok-1", { execPath: "/bin/node", port: 4319 });
  assert.equal(spec.env.TEMINALI_CAMERA_RUN, "run-1");
  assert.equal(spec.env.TEMINALI_CAMERA_TOKEN, "tok-1");
  assert.equal(spec.env.FRONTIER_GATEWAY_PORT, "4319");
  assert.equal(JSON.stringify(spec).includes("FRONTIER_SESSION_TOKEN"), false);
});

test("nothing on the camera is pre-approved", () => {
  /*
    The whole posture of the feature. `reveal` is pre-approved because showing
    a folder in a tree someone is already looking at changes nothing; this
    turns on a camera pointed at a person and sends what it sees to a model.
    There is no reading of that which makes it a showing, so there is no
    `--allowedTools` at all — an empty list would still be a claim.
  */
  const { args } = cameraMcpArgs("claude", "run-2", "tok-2", { tmpDir: tempDir(), execPath: "/bin/node" });
  assert.deepEqual(CAMERA_READ_TOOLS, []);
  assert.equal(args.includes("--allowedTools"), false);
  assert.equal(args.filter((arg) => arg === "--mcp-config").length, 1);
});

test("the config file carries the token and is not world-readable", () => {
  const { file } = cameraMcpArgs("claude", "run-3", "tok-3", { tmpDir: tempDir(), execPath: "/bin/node" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, "utf8"), /tok-3/);
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`"${CAMERA_SERVER_NAME}"`));
});

test("no run and no bridgeable engine each mean no camera", () => {
  const tmpDir = tempDir();
  // Codex has no permission-prompt tool, so the one gate this feature has
  // could not be asked — and a gate that cannot ask must not grant.
  assert.deepEqual(cameraMcpArgs("codex", "run-4", "tok-4", { tmpDir }).args, []);
  assert.deepEqual(cameraMcpArgs("claude", "", "tok-4", { tmpDir }).args, []);
  assert.deepEqual(cameraMcpArgs("claude", "run-4", "", { tmpDir }).args, []);
});

test("the agent is told about the camera only when the tool is attached", () => {
  assert.match(agentBriefing({ camera: true }), /look_at_me/);
  // And is told to reach for the right sense: the screen is what they are
  // doing, the camera is where they are.
  assert.match(agentBriefing({ camera: true }), /screen\*? is a different sense/);
  assert.doesNotMatch(agentBriefing({ camera: false }), /look_at_me/);
});

function askShim(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, "..", "electron", "cameraMcpStdio.cjs")], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TEMINALI_CAMERA_RUN: "run", TEMINALI_CAMERA_TOKEN: "tok" },
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
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
}

test("the shim speaks MCP and offers exactly the one tool", async () => {
  const replies = await askShim([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  assert.equal(replies.find((reply) => reply.id === 1).result.serverInfo.name, CAMERA_SERVER_NAME);
  assert.deepEqual(replies.find((reply) => reply.id === 2).result.tools.map((tool) => tool.name), ["look_at_me"]);
});

test("a camera that cannot be reached is a result, not an aborted turn", async () => {
  /*
    No gateway is listening on this port in a test run, so the call fails. The
    agent must get a sentence it can say out loud — "I couldn't open your
    camera" — rather than a JSON-RPC error that ends the turn mid-answer.
  */
  const replies = await askShim([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "look_at_me", arguments: {} } },
  ]);
  const result = replies.find((reply) => reply.id === 1).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Error: /);
});

test("an unknown tool is refused by name", async () => {
  const replies = await askShim([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_video", arguments: {} } },
  ]);
  assert.equal(replies.find((reply) => reply.id === 1).result.isError, true);
});
