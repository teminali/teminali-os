import test from "node:test";
import assert from "node:assert/strict";
import {
  approvalKey,
  closeRun,
  openRun,
  requestApproval,
  requestCameraFrame,
  resolveApproval,
  resolveCameraFrame,
  runCount,
} from "../server/permission-bridge.js";
import { permissionMcpArgs, PERMISSION_TOOL } from "../server/permission-mcp.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/** Open a run and collect what it emits. */
function harness(id) {
  const events = [];
  const token = openRun(id, (event) => events.push(event));
  return { token, events, prompts: () => events.filter((e) => e.type === "permission") };
}

test("an approval reaches the operator and its answer reaches the agent", async () => {
  const { token, prompts } = harness("r1");
  const verdict = requestApproval({ runId: "r1", token, toolName: "Bash", input: { command: "open -a VLC" } });
  assert.equal(prompts().length, 1);
  resolveApproval({ runId: "r1", id: prompts()[0].id, behavior: "allow" });
  assert.deepEqual(await verdict, { behavior: "allow", updatedInput: { command: "open -a VLC" } });
  closeRun("r1");
});

test("an allow always carries updatedInput, because the CLI runs that and not the original", async () => {
  const { token, prompts } = harness("r2");
  const verdict = requestApproval({ runId: "r2", token, toolName: "Read", input: { file_path: "/tmp/a" } });
  resolveApproval({ runId: "r2", id: prompts()[0].id, behavior: "allow" });
  const answer = await verdict;
  assert.equal(answer.behavior, "allow");
  assert.deepEqual(answer.updatedInput, { file_path: "/tmp/a" });
  closeRun("r2");
});

test("an edited input is what runs", async () => {
  const { token, prompts } = harness("r3");
  const verdict = requestApproval({ runId: "r3", token, toolName: "Bash", input: { command: "rm -rf ." } });
  resolveApproval({ runId: "r3", id: prompts()[0].id, behavior: "allow", updatedInput: { command: "ls" } });
  assert.deepEqual((await verdict).updatedInput, { command: "ls" });
  closeRun("r3");
});

test("a denial carries the reason the agent will report", async () => {
  const { token, prompts } = harness("r4");
  const verdict = requestApproval({ runId: "r4", token, toolName: "Bash", input: {} });
  resolveApproval({ runId: "r4", id: prompts()[0].id, behavior: "deny", message: "not that one" });
  assert.deepEqual(await verdict, { behavior: "deny", message: "not that one" });
  closeRun("r4");
});

test("`always allow` covers the command, not the whole of Bash", async () => {
  const { token, prompts } = harness("r5");
  const first = requestApproval({ runId: "r5", token, toolName: "Bash", input: { command: "open -a VLC" } });
  resolveApproval({ runId: "r5", id: prompts()[0].id, behavior: "allow", remember: true });
  await first;

  const sameHead = await requestApproval({ runId: "r5", token, toolName: "Bash", input: { command: "open -a Safari" } });
  assert.equal(sameHead.behavior, "allow", "another `open` is covered");
  assert.equal(prompts().length, 1, "and asks nothing");

  requestApproval({ runId: "r5", token, toolName: "Bash", input: { command: "rm -rf /" } });
  assert.equal(prompts().length, 2, "a different command is a different decision");
  closeRun("r5");
});

test("the approval key names the command's head", () => {
  assert.equal(approvalKey("Bash", { command: "open -a VLC" }), "Bash(open)");
  assert.equal(approvalKey("Bash", { command: "  git   push  " }), "Bash(git)");
  assert.equal(approvalKey("Bash", {}), "Bash");
  assert.equal(approvalKey("Write", { file_path: "/tmp/a" }), "Write");
});

test("a caller with the wrong token is refused rather than asked about", async () => {
  const { prompts } = harness("r6");
  const verdict = await requestApproval({ runId: "r6", token: "forged", toolName: "Bash", input: {} });
  assert.equal(verdict.behavior, "deny");
  assert.equal(prompts().length, 0, "a forged caller must not even reach the operator");
  closeRun("r6");
});

test("an unknown run is denied, not left hanging", async () => {
  const verdict = await requestApproval({ runId: "never-opened", token: "x", toolName: "Bash", input: {} });
  assert.equal(verdict.behavior, "deny");
});

test("closing a run denies everything still outstanding", async () => {
  const { token, prompts } = harness("r7");
  const verdict = requestApproval({ runId: "r7", token, toolName: "Bash", input: {} });
  assert.equal(prompts().length, 1);
  closeRun("r7");
  assert.equal((await verdict).behavior, "deny");
});

test("a run leaves nothing behind", () => {
  const before = runCount();
  openRun("r8", () => {});
  assert.equal(runCount(), before + 1);
  closeRun("r8");
  assert.equal(runCount(), before);
});

test("answering twice is refused rather than double-settling", async () => {
  const { token, prompts } = harness("r9");
  const verdict = requestApproval({ runId: "r9", token, toolName: "Bash", input: {} });
  const id = prompts()[0].id;
  assert.equal(resolveApproval({ runId: "r9", id, behavior: "allow" }).ok, true);
  assert.equal(resolveApproval({ runId: "r9", id, behavior: "deny" }).ok, false);
  assert.equal((await verdict).behavior, "allow");
  closeRun("r9");
});

test("the operator is told when a request was settled without them", async () => {
  const { token, events, prompts } = harness("r10");
  const verdict = requestApproval({ runId: "r10", token, toolName: "Bash", input: {} });
  resolveApproval({ runId: "r10", id: prompts()[0].id, behavior: "allow" });
  await verdict;
  assert.ok(events.some((e) => e.type === "permission-resolved" && e.behavior === "allow"));
  closeRun("r10");
});

test("the CLI is handed a prompt tool, and the tool is pre-approved", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-test-"));
  try {
    const built = permissionMcpArgs("run-x", "token-y", { tmpDir: dir });
    assert.ok(built.args.includes("--permission-prompt-tool"));
    assert.ok(built.args.includes(PERMISSION_TOOL));
    // Without this the first thing needing approval is the approver itself.
    assert.ok(built.args.includes("--allowedTools"));
    assert.ok(built.args.some((a) => a === "mcp__teminali_permissions"));

    const config = JSON.parse(fs.readFileSync(built.file, "utf8"));
    const spec = config.mcpServers.teminali_permissions;
    assert.equal(spec.env.TEMINALI_PERMISSION_RUN, "run-x");
    assert.equal(spec.env.TEMINALI_PERMISSION_TOKEN, "token-y");
    assert.equal(spec.env.ELECTRON_RUN_AS_NODE, "1");
    // The token is in it, so nobody else on a shared temp dir may read it.
    assert.equal(fs.statSync(built.file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no run and no token means no flags at all", () => {
  assert.deepEqual(permissionMcpArgs(null, null).args, []);
  assert.deepEqual(permissionMcpArgs("run", "").args, []);
});


/* ── The camera, on the same run's token ────────────────────────────────── */

test("a frame is asked for on the run's stream and answered on its own request", async () => {
  /*
    The gateway is a plain Node process: it has `screencapture` for the screen
    and nothing at all for a camera, because opening one needs `getUserMedia`
    and that lives in a renderer. So the ask goes out on the stream the window
    already opened by starting this turn, and the picture comes back the way an
    approval's answer does.
  */
  const events = [];
  const token = openRun("cam-1", (event) => events.push(event));

  const frame = requestCameraFrame({ runId: "cam-1", token });
  const asked = events.find((event) => event.type === "camera");
  assert.ok(asked, "the window is asked on its own stream");

  // The request's shape travels with the ask, so the window takes what was
  // wanted rather than what it assumes.
  assert.equal(asked.frames, 1);
  assert.equal(asked.spanMs, 1200);

  assert.deepEqual(resolveCameraFrame({ runId: "cam-1", id: asked.id, images: ["aGVsbG8="], warm: true, tookMs: 31 }), { ok: true });
  const answered = await frame;
  assert.deepEqual(answered.images, ["aGVsbG8="]);
  assert.equal(answered.warm, true);
  assert.equal(answered.tookMs, 31);

  // A frame is answered once. A second answer is not a second photograph.
  assert.equal(resolveCameraFrame({ runId: "cam-1", id: asked.id, images: ["again"] }).ok, false);
  closeRun("cam-1");
});

test("a window that cannot open the camera says so, and the tool fails with its words", async () => {
  const events = [];
  const token = openRun("cam-2", (event) => events.push(event));
  const frame = requestCameraFrame({ runId: "cam-2", token });
  const asked = events.find((event) => event.type === "camera");

  resolveCameraFrame({ runId: "cam-2", id: asked.id, error: "There is no camera on this machine." });
  await assert.rejects(frame, /no camera on this machine/);
  closeRun("cam-2");
});

test("the camera is not reachable without this run's token", async () => {
  const token = openRun("cam-3", () => {});
  await assert.rejects(requestCameraFrame({ runId: "cam-3", token: "not-it" }), /rejected the caller/);
  await assert.rejects(requestCameraFrame({ runId: "no-such-run", token }), /no longer running/);
  closeRun("cam-3");
});

test("a sequence is asked for as one, and comes back in order", async () => {
  const events = [];
  const token = openRun("cam-4", (event) => events.push(event));
  const frame = requestCameraFrame({ runId: "cam-4", token, frames: 4, spanMs: 2000 });
  const asked = events.find((event) => event.type === "camera");
  assert.equal(asked.frames, 4);
  assert.equal(asked.spanMs, 2000);
  resolveCameraFrame({ runId: "cam-4", id: asked.id, images: ["a", "b", "c", "d"] });
  assert.deepEqual((await frame).images, ["a", "b", "c", "d"]);
  closeRun("cam-4");
});

test("an empty answer is a failure, not a photograph of nothing", async () => {
  const events = [];
  const token = openRun("cam-5", (event) => events.push(event));
  const frame = requestCameraFrame({ runId: "cam-5", token });
  const asked = events.find((event) => event.type === "camera");
  resolveCameraFrame({ runId: "cam-5", id: asked.id, images: [] });
  await assert.rejects(frame, /could not take a photograph/);
  closeRun("cam-5");
});
