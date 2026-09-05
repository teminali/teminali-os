import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ASSISTANT_LIMITS,
  act,
  forgetObservations,
  recallObservation,
  rememberObservation,
  visionRequest,
} from "../server/assistant.js";
import { POINTER_LIMITS, helperAvailable, runPointer } from "../server/pointer.js";

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

function observation(overrides = {}) {
  return {
    id: "obs_test",
    capturedAt: new Date().toISOString(),
    application: { name: "TestApp", bundleId: "com.example.test", pid: 4242 },
    window: { title: "Test", frame: { x: 0, y: 0, width: 800, height: 600 } },
    screens: [{ id: 1, main: true, x: 0, y: 0, width: 1512, height: 982, scale: 2 }],
    elements: [
      { id: "e0", role: "AXButton", label: "Send", frame: { x: 10, y: 20, width: 80, height: 24 }, enabled: true, focused: false, actions: ["AXPress"], depth: 3, path: "" },
      { id: "e1", role: "AXButton", label: "Publish", frame: { x: 120, y: 20, width: 80, height: 24 }, enabled: false, focused: false, actions: ["AXPress"], depth: 3, path: "" },
      { id: "e2", role: "AXButton", label: "Offscreen", frame: { x: 9000, y: 20, width: 80, height: 24 }, enabled: true, focused: false, actions: [], depth: 3, path: "" },
    ],
    truncated: false,
    sceneDescription: null,
    frame: null,
    limits: [],
    ...overrides,
  };
}

/** The frontmost check spawns the helper; these cases are about the gate before it. */
const noFrontmostCheck = { checkFrontmost: false };

test.beforeEach(() => forgetObservations());

/* ── The boundary ─────────────────────────────────────────────────────────── */

test("an action for an observation that was never stored is refused", async () => {
  await assert.rejects(
    () => act("obs_nothing", { kind: "click", element: "e0" }, noFrontmostCheck),
    (error) => error.code === "OBSERVATION_EXPIRED",
  );
});

test("an element the observation never saw is refused by name", async () => {
  rememberObservation(observation());
  await assert.rejects(
    () => act("obs_test", { kind: "click", element: "e99" }, noFrontmostCheck),
    (error) => error.code === "UNKNOWN_ELEMENT" && /"e99" is not an element/.test(error.message),
  );
});

test("a disabled element is refused even though it was observed", async () => {
  rememberObservation(observation());
  await assert.rejects(
    () => act("obs_test", { kind: "click", element: "e1" }, noFrontmostCheck),
    (error) => error.code === "ELEMENT_DISABLED",
  );
});

test("an element that is no longer on any screen is refused", async () => {
  rememberObservation(observation());
  await assert.rejects(
    () => act("obs_test", { kind: "click", element: "e2" }, noFrontmostCheck),
    (error) => error.code === "OFF_SCREEN",
  );
});

test("an observation older than its lifetime is refused", async () => {
  const stored = rememberObservation(observation());
  // Reach into the stored copy rather than the returned one: the store holds
  // its own `storedAt`, and that is what the freshness check reads.
  recallObservation(stored.id).storedAt = Date.now() - ASSISTANT_LIMITS.observationTtlMs - 1;
  await assert.rejects(
    () => act("obs_test", { kind: "click", element: "e0" }, noFrontmostCheck),
    (error) => error.code === "OBSERVATION_EXPIRED",
  );
});

test("a step with no recognisable action is refused", async () => {
  rememberObservation(observation());
  await assert.rejects(
    () => act("obs_test", { kind: "drag", element: "e0" }, noFrontmostCheck),
    (error) => error.code === "INVALID_STEP",
  );
  await assert.rejects(
    () => act("obs_test", {}, noFrontmostCheck),
    (error) => error.code === "INVALID_STEP",
  );
});

test("typed text is bounded at the boundary, not only in the renderer", async () => {
  rememberObservation(observation());
  await assert.rejects(
    () => act("obs_test", { kind: "type", text: "x".repeat(ASSISTANT_LIMITS.maxTypeLength + 1) }, noFrontmostCheck),
    (error) => error.code === "TEXT_TOO_LONG",
  );
  await assert.rejects(
    () => act("obs_test", { kind: "type", text: "" }, noFrontmostCheck),
    (error) => error.code === "TEXT_REQUIRED",
  );
});

test("a wait needs no target and no application check", async () => {
  rememberObservation(observation());
  const result = await act("obs_test", { kind: "wait", ms: 1 }, noFrontmostCheck);
  assert.equal(result.kind, "wait");
  assert.equal(result.waitedMs, 1);
});

/* ── Storage ──────────────────────────────────────────────────────────────── */

test("observations do not accumulate", () => {
  for (let index = 0; index < ASSISTANT_LIMITS.maxObservations + 4; index += 1) {
    rememberObservation(observation({ id: `obs_${index}` }));
  }
  // A photograph of the operator's screen with every control on it enumerated
  // has no business outliving the handful of turns that needed it.
  assert.equal(recallObservation("obs_0"), null);
  assert.ok(recallObservation(`obs_${ASSISTANT_LIMITS.maxObservations + 3}`));
});

test("forgetting clears every stored look", () => {
  rememberObservation(observation());
  forgetObservations();
  assert.equal(recallObservation("obs_test"), null);
});

/* ── The helper contract ──────────────────────────────────────────────────── */

test("a helper that is not there is reported, not thrown as a crash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pointer-"));
  try {
    assert.equal(await helperAvailable(join(directory, "nope")), false);
    await assert.rejects(
      () => runPointer("permissions", [], { binary: join(directory, "nope") }),
      (error) => error.code === "POINTER_HELPER_MISSING",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("output that is not JSON is reported as such rather than parsed as empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pointer-"));
  const fake = join(directory, "fake");
  try {
    await writeFile(fake, "#!/bin/sh\necho 'not json'\n", { mode: 0o755 });
    await assert.rejects(
      () => runPointer("permissions", [], { binary: fake }),
      (error) => error.code === "POINTER_BAD_OUTPUT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an error object on stdout becomes an error with its own code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pointer-"));
  const fake = join(directory, "fake");
  try {
    await writeFile(fake, `#!/bin/sh\necho '{"error":{"code":"ACCESSIBILITY_DENIED","message":"nope"}}'\nexit 1\n`, { mode: 0o755 });
    await assert.rejects(
      () => runPointer("tree", [], { binary: fake }),
      (error) => error.code === "ACCESSIBILITY_DENIED" && error.message === "nope",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a helper that never answers is killed rather than hanging the gateway", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pointer-"));
  const fake = join(directory, "fake");
  try {
    await writeFile(fake, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    await assert.rejects(
      () => runPointer("tree", [], { binary: fake, timeoutMs: 120 }),
      (error) => error.code === "POINTER_TIMEOUT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the helper is given an argument array, so a prompt cannot become a command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pointer-"));
  const fake = join(directory, "fake");
  try {
    // If the arguments went through a shell, the `;` would end the echo and
    // `touch` would run. The file's absence is the assertion.
    const canary = join(directory, "canary");
    await writeFile(fake, `#!/bin/sh\necho "{\\"typed\\":{\\"characters\\":1}}"\n`, { mode: 0o755 });
    const result = await runPointer("type", ["--text", `hi"; touch ${canary}; echo "`], { binary: fake });
    assert.deepEqual(result, { typed: { characters: 1 } });
    const { access } = await import("node:fs/promises");
    await assert.rejects(() => access(canary));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the element cap the helper is asked for cannot be talked past", () => {
  assert.ok(POINTER_LIMITS.maxElements <= 400);
  assert.ok(POINTER_LIMITS.maxTypeLength >= ASSISTANT_LIMITS.maxTypeLength);
});

/* ── The vision pass ──────────────────────────────────────────────────────── */

test("the vision request leaves room for the model's thinking trace before its answer", () => {
  const request = visionRequest(Buffer.from("jpeg-bytes"));
  assert.equal(request.model, "qwen3-vl:2b");
  assert.equal(request.stream, false);
  assert.deepEqual(request.images, [Buffer.from("jpeg-bytes").toString("base64")]);
  // qwen3-vl:2b thinks for 400-600 tokens before it answers and cannot be told
  // not to; at 260 every description came back empty with done_reason "length".
  // Measured 2026-09-06: 516 and 626 tokens end in "stop" at this budget.
  assert.ok(request.options.num_predict >= 1_000, `num_predict ${request.options.num_predict} would be spent on the thinking trace`);
  assert.equal(request.options.num_predict, ASSISTANT_LIMITS.visionPredictTokens);
  assert.equal(request.options.num_ctx, ASSISTANT_LIMITS.visionContextTokens);
});
