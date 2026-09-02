import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { childEnvironment, resolveCommandCwd, runWorkspaceCommand } from "../server/terminal.js";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "frontier-terminal-"));
  await writeFile(join(root, "marker.txt"), "hello\n");
  return root;
}

function collect() {
  const chunks = [];
  return { chunks, onChunk: (chunk) => chunks.push(chunk) };
}

function text(chunks, type) {
  return chunks.filter((chunk) => chunk.type === type).map((chunk) => chunk.data).join("");
}

test("a real command runs in the workspace and reports true stdout and exit code", async () => {
  const root = await workspace();
  const { chunks, onChunk } = collect();
  const result = await runWorkspaceCommand({ root, command: "cat marker.txt", onChunk });
  assert.equal(result.code, 0);
  assert.equal(text(chunks, "stdout"), "hello\n");
  assert.equal(result.truncated, false);
});

test("a failing command surfaces its real non-zero exit code and stderr", async () => {
  const root = await workspace();
  const { chunks, onChunk } = collect();
  const result = await runWorkspaceCommand({ root, command: "cat does-not-exist.txt", onChunk });
  assert.notEqual(result.code, 0);
  assert.match(text(chunks, "stderr"), /does-not-exist/);
});

test("the working directory cannot escape the workspace root", async () => {
  const root = await workspace();
  assert.throws(() => resolveCommandCwd(root, "../.."), /TERMINAL_CWD_ESCAPE/);
  assert.throws(() => resolveCommandCwd(root, "/etc"), /TERMINAL_CWD_ESCAPE/);
  assert.equal(resolveCommandCwd(root, ""), root);
});

test("a long-running command is terminated at the timeout", async () => {
  const root = await workspace();
  const result = await runWorkspaceCommand({ root, command: "sleep 30", timeoutMs: 300 });
  assert.equal(result.reason, "timeout");
  assert.notEqual(result.signal, null);
});

test("runaway output is capped and the process is stopped", async () => {
  const root = await workspace();
  const { chunks, onChunk } = collect();
  const result = await runWorkspaceCommand({
    root,
    command: "yes abcdefghij",
    maxOutputBytes: 4096,
    timeoutMs: 10_000,
    onChunk,
  });
  assert.equal(result.truncated, true);
  assert.equal(result.reason, "output_limit");
  assert.ok(text(chunks, "stdout").length <= 4096);
});

test("cancelling the request kills the command", async () => {
  const root = await workspace();
  const controller = new AbortController();
  const pending = runWorkspaceCommand({ root, command: "sleep 30", signal: controller.signal, timeoutMs: 10_000 });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.equal(result.reason, "cancelled");
});

test("provider credentials are not readable from a workspace command", async () => {
  const environment = childEnvironment({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret", HOME: "/tmp" });
  assert.equal("ANTHROPIC_API_KEY" in environment, false);
  assert.ok(environment.PATH.startsWith("/usr/bin"));
  assert.ok(environment.PATH.split(":").includes("/opt/homebrew/bin"));

  const root = await workspace();
  const { chunks, onChunk } = collect();
  await runWorkspaceCommand({
    root,
    command: "echo key=[$ANTHROPIC_API_KEY]",
    env: { ...process.env, ANTHROPIC_API_KEY: "super-secret-value" },
    onChunk,
  });
  assert.equal(text(chunks, "stdout").includes("super-secret-value"), false);
  assert.match(text(chunks, "stdout"), /key=\[\]/);
});

test("an empty or oversized command is rejected before spawning", async () => {
  const root = await workspace();
  await assert.rejects(runWorkspaceCommand({ root, command: "   " }), /TERMINAL_COMMAND_REQUIRED/);
  await assert.rejects(runWorkspaceCommand({ root, command: "x".repeat(9000) }), /TERMINAL_COMMAND_TOO_LONG/);
});
