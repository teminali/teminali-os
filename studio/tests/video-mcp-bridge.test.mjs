/**
 * The MCP bridge, end to end under plain Node.
 *
 * The chain in the running app is
 *
 *   agent CLI → videoMcpStdio.cjs → 127.0.0.1/rpc → main → IPC → renderer
 *
 * and everything up to the IPC hop is exercised here with the real files: the
 * real shim as a real child process, the real RPC server, and a stand-in for
 * the bridge that main would hand it. Only the last hop is faked, because it
 * needs Electron — and that is also the reason videoRpc.cjs takes its bridge as
 * an argument instead of importing one.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { videoMcpArgs, videoBridgeEndpoint, codexMcpOverride, videoMcpServerSpec, shimPath, MCP_SERVER_NAME } from "../server/video-mcp.js";

const require_ = createRequire(import.meta.url);
const { startVideoRpcServer, endpointFile } = require_("../electron/videoRpc.cjs");

/* ── Harness ──────────────────────────────────────────────────────────────── */

function fakeBridge() {
  const calls = [];
  return {
    calls,
    ready: true,
    manifest: [{ name: "describe_timeline", description: "read it", inputSchema: { type: "object" } }],
    result: { success: true, data: { clipId: "clip_1" }, durationMs: 3 },
    isReady() { return this.ready; },
    async listTools() { return this.manifest; },
    async callTool(name, args) {
      calls.push({ name, args });
      return this.result;
    },
  };
}

async function withBridge(run) {
  const bridge = fakeBridge();
  const rpc = startVideoRpcServer({ bridge, port: 0, token: "test-token" });
  await new Promise((resolve, reject) => {
    rpc.server.once("listening", resolve);
    rpc.server.once("error", reject);
  });
  try {
    await run({ bridge, rpc });
  } finally {
    rpc.close();
  }
}

function post(port, body, token = "test-token") {
  return fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-teminali-token": token },
    body: JSON.stringify(body),
  });
}

/** A live shim, spoken to the way an MCP client speaks to it. */
function startShim(env) {
  const child = spawn(process.execPath, [shimPath()], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
      newline = buffer.indexOf("\n");
    }
  });

  let id = 0;
  return {
    child,
    request(method, params) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`shim never answered ${method}`)), 10_000);
        waiting.set(requestId, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      });
    },
    stop() {
      child.stdin.end();
      child.kill();
    },
  };
}

/* ── The RPC door ─────────────────────────────────────────────────────────── */

test("the bridge answers only POST /rpc, and only with the token", async () => {
  await withBridge(async ({ rpc }) => {
    const port = rpc.port();

    const wrongPath = await fetch(`http://127.0.0.1:${port}/`, { method: "POST" });
    assert.equal(wrongPath.status, 404);

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/rpc`);
    assert.equal(wrongMethod.status, 404);

    const noToken = await post(port, { method: "ping" }, "");
    assert.equal(noToken.status, 401);

    const wrongToken = await post(port, { method: "ping" }, "not-the-token");
    assert.equal(wrongToken.status, 401);

    const ok = await post(port, { method: "ping" });
    assert.equal(ok.status, 200);
  });
});

test("a closed window is 503, not a hang and not a lie", async () => {
  await withBridge(async ({ bridge, rpc }) => {
    bridge.ready = false;
    const response = await post(rpc.port(), { method: "tools/list" });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /video panel is not available/);
  });
});

test("the endpoint file describes the port actually bound, and is private", async () => {
  await withBridge(async ({ rpc }) => {
    const file = endpointFile(rpc.port());
    const published = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(published.port, rpc.port());
    assert.equal(published.token, "test-token");
    assert.equal(published.pid, process.pid);
    // The file carries a credential and the temp directory is shared on Linux.
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
  // And closing takes it away, so the next launch cannot find credentials for a
  // window that has gone.
  assert.equal(fs.existsSync(endpointFile(0)), false);
});

test("an instance that lost the port race leaves the winner's endpoint alone", async () => {
  await withBridge(async ({ rpc }) => {
    const file = endpointFile(rpc.port());
    // A second instance asking for a port it cannot have. `listen` reports
    // EADDRINUSE asynchronously, so give it a turn to fail.
    const loser = startVideoRpcServer({ bridge: fakeBridge(), port: rpc.port(), token: "loser" });
    await new Promise((resolve) => loser.server.once("error", resolve));
    loser.close();

    assert.equal(fs.existsSync(file), true, "the winner's endpoint file must survive");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, "test-token");
  });
});

/* ── The shim, as a real child process ────────────────────────────────────── */

test("the shim forwards a tool call to the bridge and returns its data", async () => {
  await withBridge(async ({ bridge, rpc }) => {
    const shim = startShim({
      TEMINALI_VIDEO_RPC_PORT: String(rpc.port()),
      TEMINALI_VIDEO_RPC_TOKEN: "test-token",
    });
    try {
      const init = await shim.request("initialize", {});
      assert.equal(init.result.protocolVersion, "2024-11-05");
      assert.equal(init.result.serverInfo.name, MCP_SERVER_NAME);

      const list = await shim.request("tools/list", {});
      assert.deepEqual(list.result.tools, bridge.manifest);

      const call = await shim.request("tools/call", {
        name: "patch_clip",
        arguments: { clipId: "clip_1", properties: { "transform.rotation": 45 } },
      });
      // The call reached the bridge with its arguments intact...
      assert.deepEqual(bridge.calls, [
        { name: "patch_clip", args: { clipId: "clip_1", properties: { "transform.rotation": 45 } } },
      ]);
      // ...and the answer came back as MCP tool content, not as a raw result.
      assert.equal(call.result.isError, false);
      assert.deepEqual(JSON.parse(call.result.content[0].text), { clipId: "clip_1" });
    } finally {
      shim.stop();
    }
  });
});

test("a tool that failed is an error RESULT the agent can read, not a dead turn", async () => {
  await withBridge(async ({ bridge, rpc }) => {
    bridge.result = { success: false, error: 'No clip matching "mascot".', durationMs: 1 };
    const shim = startShim({
      TEMINALI_VIDEO_RPC_PORT: String(rpc.port()),
      TEMINALI_VIDEO_RPC_TOKEN: "test-token",
    });
    try {
      const call = await shim.request("tools/call", { name: "patch_clip", arguments: {} });
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /No clip matching "mascot"/);
      assert.equal(call.error, undefined, "a failed tool is not a protocol error");
    } finally {
      shim.stop();
    }
  });
});

test("with no app running, tools/list is empty and a call explains itself", async () => {
  // No bridge at all: nothing is listening on this port.
  const shim = startShim({ TEMINALI_VIDEO_RPC_PORT: "1", TEMINALI_VIDEO_RPC_TOKEN: "irrelevant" });
  try {
    const list = await shim.request("tools/list", {});
    // Empty rather than an error: a client that cannot initialise its MCP
    // servers usually aborts the session, and a closed video panel must not be
    // able to stop the operator's coding agent from starting.
    assert.deepEqual(list.result.tools, []);

    const call = await shim.request("tools/call", { name: "describe_timeline", arguments: {} });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /Error:/);
  } finally {
    shim.stop();
  }
});

/* ── What the agent CLIs are told ─────────────────────────────────────────── */

test("no bridge means no MCP arguments at all", () => {
  /*
    A port nothing publishes to, rather than an empty environment: an empty one
    falls through to the DEFAULT port's file, and this suite must give the same
    answer whether or not the developer running it has the app open. It did not,
    which is how that was found.
  */
  const nowhere = { TEMINALI_VIDEO_RPC_PORT: "65500" };
  assert.equal(videoBridgeEndpoint(nowhere), null);
  assert.deepEqual(videoMcpArgs("claude", { env: nowhere }), []);
  assert.deepEqual(videoMcpArgs("codex", { env: nowhere }), []);
});

test("an endpoint file whose process has gone is not an endpoint", () => {
  const file = endpointFile(3899);
  const existing = fs.existsSync(file) ? fs.readFileSync(file) : null;
  try {
    // A pid that cannot be signalled. 2**31 - 1 is above every real pid.
    fs.writeFileSync(file, JSON.stringify({ port: 3899, token: "stale", pid: 2 ** 31 - 1 }));
    assert.equal(videoBridgeEndpoint({}), null);
  } finally {
    if (existing) fs.writeFileSync(file, existing);
    else fs.rmSync(file, { force: true });
  }
});

test("Claude is given a config file and permission to use it", () => {
  // Its own directory: the real path is fixed and belongs to whichever app is
  // running on this machine, and this test used to overwrite it.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-mcp-test-"));
  const args = videoMcpArgs("claude", {
    env: { TEMINALI_VIDEO_RPC_PORT: "4200", TEMINALI_VIDEO_RPC_TOKEN: "tok" },
    execPath: "/usr/bin/node",
    tmpDir,
  });
  assert.equal(path.dirname(args[1]), tmpDir);
  assert.equal(args[0], "--mcp-config");
  const written = JSON.parse(fs.readFileSync(args[1], "utf8"));
  const spec = written.mcpServers[MCP_SERVER_NAME];
  assert.equal(spec.command, "/usr/bin/node");
  assert.deepEqual(spec.args, [shimPath()]);
  assert.equal(spec.env.TEMINALI_VIDEO_RPC_TOKEN, "tok");
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, "1");
  // Headless `claude -p` has no TTY to approve a tool call on.
  assert.deepEqual(args.slice(2), ["--allowedTools", `mcp__${MCP_SERVER_NAME}`]);
  // The operator's own MCP servers must survive: this is their coding agent.
  assert.equal(args.includes("--strict-mcp-config"), false);
  assert.equal(fs.statSync(args[1]).mode & 0o777, 0o600);
});

test("Codex is given one config override, and the TOML is escaped", () => {
  const args = videoMcpArgs("codex", {
    env: { TEMINALI_VIDEO_RPC_PORT: "4200", TEMINALI_VIDEO_RPC_TOKEN: "tok" },
    execPath: "/usr/bin/node",
  });
  assert.equal(args[0], "-c");
  assert.match(args[1], /^mcp_servers\.cut=\{command="\/usr\/bin\/node", args=\[".*videoMcpStdio\.cjs"\]/);

  const awkward = videoMcpServerSpec({ port: 1, token: 'a"b\\c' }, 'C:\\Program "Files"\\node.exe');
  const rendered = codexMcpOverride(awkward);
  assert.match(rendered, /command="C:\\\\Program \\"Files\\"\\\\node\.exe"/);
  assert.match(rendered, /TEMINALI_VIDEO_RPC_TOKEN="a\\"b\\\\c"/);
});

test("the agent CLI builder attaches the panel without disturbing the rest", async () => {
  const source = await fs.promises.readFile(new URL("../server/agent-cli.js", import.meta.url), "utf8");
  // Resolved per call, not captured at import: the app may be opened after the
  // gateway starts, and a stale token would fail every call.
  assert.match(source, /const mcp = videoMcpArgs\(engine\);/);
  // Codex's prompt is positional and `exec resume <id> <prompt>` is
  // order-sensitive, so the override has to lead.
  assert.match(source, /const args = \[\.\.\.mcp, "exec", "--json"/);
});

/* ── The curated surface ──────────────────────────────────────────────────── */

const registry = await fs.promises.readFile(new URL("../src/video/mcp/toolRegistry.ts", import.meta.url), "utf8");

test("the exposed surface is an allowlist, and stays inside its budget", () => {
  const budget = Number(registry.match(/export const TOOL_BUDGET = (\d+);/)[1]);
  const listed = [...registry.match(/export const EXPOSED_TOOLS[\s\S]*?\];/)[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

  assert.ok(listed.length > 0, "something has to be exposed");
  assert.ok(
    listed.length <= budget,
    `${listed.length} tools exposed against a budget of ${budget}. The Cut's 115 descriptions ` +
    "are ~8.7k tokens; that is the cost this ceiling exists to keep off every request."
  );
  // A name that resolves to nothing would advertise a tool that cannot be called.
  for (const name of listed) {
    assert.ok(registry.includes(`name: '${name}',`), `${name} is exposed but not defined`);
  }
  // And the manifest must be built from the allowlist, not from every tool
  // someone copy-pastes out of the Cut.
  assert.match(registry, /KERF_TOOLS\.filter\(\(t\) => isExposed\(t\.name\)\)/);
});

test("the MCP path refuses what it does not advertise", async () => {
  const client = await fs.promises.readFile(new URL("../src/services/videoToolBridge.ts", import.meta.url), "utf8");
  assert.match(client, /if \(!isExposed\(name\)\)/);
  // The renderer announces itself only after its listeners exist: the last
  // statement of the function, below both handler registrations.
  assert.ok(client.indexOf("api.ready();") > client.indexOf("api.onCallTool("),
    "readiness must be announced after the handlers are installed");
});

test("describe_timeline answers briefly unless asked otherwise", () => {
  // Summary is the default because a tool result stays in the transcript and is
  // re-sent on every later turn; the full answer on the seed project is ~1.3k
  // tokens the model needed once, to learn clip ids.
  assert.match(registry, /const full = detail === 'full' \|\| includeProperties === true;/);
  assert.match(registry, /detail: z\.enum\(\['summary', 'full'\]\)\.optional\(\)/);
});
