import assert from "node:assert/strict";
import test from "node:test";

import {
  IDLE_FLOOR_SECONDS,
  SUPERSEDED_GRACE_SECONDS,
  createAutoUnloadSweep,
  planAutoUnload,
} from "../server/guardian-autounload.js";
import { DEFAULT_GOVERNOR_SETTINGS } from "../server/guardian-governor.js";

/** A resident model as trackResidency shapes it, with sane defaults. */
function model(overrides = {}) {
  return {
    name: "frontier-qwen2.5-coder-14b-8k:latest",
    vramBytes: 9 * 1024 ** 3,
    idleSeconds: 0,
    idleIsLowerBound: false,
    expiresAtMs: 1_000_000,
    expiresInSeconds: 300,
    ...overrides,
  };
}

const settings = (overrides = {}) => ({ ...DEFAULT_GOVERNOR_SETTINGS, ...overrides });

/* ── The idle rule ────────────────────────────────────────────────────────── */

test("a model idle past the threshold is unloaded", () => {
  const plan = planAutoUnload(
    [model({ idleSeconds: 20 * 60 })],
    settings({ unloadIdleModelsAfterMinutes: 2 }),
  );
  assert.equal(plan.unload.length, 1);
  assert.equal(plan.unload[0].rule, "idle");
  assert.equal(plan.unload[0].vramBytes, 9 * 1024 ** 3);
});

test("a model idle under the threshold is spared, and says why", () => {
  const plan = planAutoUnload(
    [model({ idleSeconds: 90 })],
    settings({ unloadIdleModelsAfterMinutes: 20 }),
  );
  assert.equal(plan.unload.length, 0);
  assert.match(plan.spared[0].reason, /under the 1200s threshold/);
});

test("the idle floor overrides a threshold set below it", () => {
  // Half a minute would evict during an ordinary typing pause.
  const plan = planAutoUnload(
    [model({ idleSeconds: IDLE_FLOOR_SECONDS - 1 })],
    settings({ unloadIdleModelsAfterMinutes: 0.5 }),
  );
  assert.equal(plan.unload.length, 0);
});

test("a zero threshold switches the idle rule off", () => {
  const plan = planAutoUnload(
    [model({ idleSeconds: 12 * 60 * 60 })],
    settings({ unloadIdleModelsAfterMinutes: 0 }),
  );
  assert.equal(plan.unload.length, 0);
  assert.match(plan.spared[0].reason, /switched off/);
});

/* ── The superseded rule ──────────────────────────────────────────────────── */

test("a model switch evicts the model left behind and keeps the active one", () => {
  const previous = model({ name: "frontier-devstral-24b-32k", expiresAtMs: 1_000, idleSeconds: 120 });
  const active = model({ name: "frontier-qwen2.5-coder-14b-8k", expiresAtMs: 9_000, idleSeconds: 1 });

  const plan = planAutoUnload([previous, active], settings({ unloadIdleModelsAfterMinutes: 20 }));

  assert.deepEqual(plan.unload.map((entry) => entry.name), ["frontier-devstral-24b-32k"]);
  assert.equal(plan.unload[0].rule, "superseded");
  assert.deepEqual(plan.spared.map((entry) => entry.name), ["frontier-qwen2.5-coder-14b-8k"]);
});

test("a just-superseded model gets its grace period", () => {
  const previous = model({ name: "a", expiresAtMs: 1_000, idleSeconds: SUPERSEDED_GRACE_SECONDS - 1 });
  const active = model({ name: "b", expiresAtMs: 9_000, idleSeconds: 0 });

  const plan = planAutoUnload([previous, active], settings());
  assert.equal(plan.unload.length, 0);
});

test("superseded eviction still runs when the idle rule is off", () => {
  const previous = model({ name: "a", expiresAtMs: 1_000, idleSeconds: 120 });
  const active = model({ name: "b", expiresAtMs: 9_000, idleSeconds: 0 });

  const plan = planAutoUnload([previous, active], settings({ unloadIdleModelsAfterMinutes: 0 }));
  assert.deepEqual(plan.unload.map((entry) => entry.name), ["a"]);
});

test("a model with no expiry is never treated as superseded", () => {
  const unknown = model({ name: "a", expiresAtMs: null, expiresInSeconds: null, idleSeconds: 120 });
  const active = model({ name: "b", expiresAtMs: 9_000, idleSeconds: 0 });

  const plan = planAutoUnload([unknown, active], settings({ unloadIdleModelsAfterMinutes: 0 }));
  assert.equal(plan.unload.length, 0);
});

/* ── Safety ───────────────────────────────────────────────────────────────── */

test("a model with a request in flight is never unloaded", () => {
  // Ollama holds a model past its own deadline while it is answering.
  const plan = planAutoUnload(
    [model({ idleSeconds: 60 * 60, expiresInSeconds: -4 })],
    settings({ unloadIdleModelsAfterMinutes: 1 }),
  );
  assert.equal(plan.unload.length, 0);
  assert.match(plan.spared[0].reason, /in flight/);
});

test("in-flight beats the superseded rule too", () => {
  const previous = model({ name: "a", expiresAtMs: 1_000, idleSeconds: 300, expiresInSeconds: -2 });
  const active = model({ name: "b", expiresAtMs: 9_000, idleSeconds: 0 });

  const plan = planAutoUnload([previous, active], settings());
  assert.equal(plan.unload.length, 0);
});

test("the master switch stops the planner dead", () => {
  const plan = planAutoUnload(
    [model({ idleSeconds: 60 * 60 })],
    settings({ autoUnloadModels: false, unloadIdleModelsAfterMinutes: 1 }),
  );
  assert.equal(plan.unload.length, 0);
  assert.match(plan.spared[0].reason, /switched off/);
});

/* ── The sweep ────────────────────────────────────────────────────────────── */

test("the sweep unloads what the plan names and reports what it freed", async () => {
  const unloaded = [];
  const events = [];
  const sweep = createAutoUnloadSweep({
    readSettings: () => settings({ unloadIdleModelsAfterMinutes: 2 }),
    snapshot: async () => ({ ollama: { residentModels: [model({ idleSeconds: 600 })] } }),
    unload: async (name) => {
      unloaded.push(name);
      return { freedBytes: 9 * 1024 ** 3 };
    },
    onEvent: (event) => void events.push(event),
  });

  const result = await sweep.runOnce();
  assert.deepEqual(unloaded, ["frontier-qwen2.5-coder-14b-8k:latest"]);
  assert.equal(result.unloaded[0].freedBytes, 9 * 1024 ** 3);
  assert.equal(events[0].event, "guardian-auto-unloaded");
  assert.equal(events[0].rule, "idle");
});

test("a model that vanished before the unload is not a failure", async () => {
  const sweep = createAutoUnloadSweep({
    readSettings: () => settings({ unloadIdleModelsAfterMinutes: 2 }),
    snapshot: async () => ({ ollama: { residentModels: [model({ idleSeconds: 600 })] } }),
    unload: async () => {
      throw Object.assign(new Error("not resident"), { code: "MODEL_NOT_RESIDENT" });
    },
  });

  const result = await sweep.runOnce();
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.unloaded, []);
});

test("a refused unload is recorded rather than thrown", async () => {
  const sweep = createAutoUnloadSweep({
    readSettings: () => settings({ unloadIdleModelsAfterMinutes: 2 }),
    snapshot: async () => ({ ollama: { residentModels: [model({ idleSeconds: 600 })] } }),
    unload: async () => {
      throw Object.assign(new Error("Ollama refused"), { code: "UNLOAD_REJECTED" });
    },
  });

  const result = await sweep.runOnce();
  assert.equal(result.failed[0].code, "UNLOAD_REJECTED");
});

test("the sweep does no work when nothing is resident", async () => {
  const sweep = createAutoUnloadSweep({
    readSettings: () => settings(),
    snapshot: async () => ({ ollama: { residentModels: [] } }),
    unload: async () => assert.fail("nothing should be unloaded"),
  });
  assert.equal((await sweep.runOnce()).skipped, "none-resident");
});

test("the sweep does not read the machine when it is switched off", async () => {
  const sweep = createAutoUnloadSweep({
    readSettings: () => settings({ autoUnloadModels: false }),
    snapshot: async () => assert.fail("the machine should not be read"),
    unload: async () => assert.fail("nothing should be unloaded"),
  });
  assert.equal((await sweep.runOnce()).skipped, "disabled");
});

test("overlapping sweeps do not double-count", async () => {
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sweep = createAutoUnloadSweep({
    readSettings: () => settings({ unloadIdleModelsAfterMinutes: 2 }),
    snapshot: async () => {
      reads += 1;
      await gate;
      return { ollama: { residentModels: [] } };
    },
    unload: async () => ({}),
  });

  const first = sweep.runOnce();
  const second = await sweep.runOnce();
  assert.equal(second.skipped, "in-progress");
  release();
  await first;
  assert.equal(reads, 1);
});

test("start is idempotent and stop leaves no timer behind", () => {
  const sweep = createAutoUnloadSweep({
    readSettings: () => settings(),
    snapshot: async () => ({ ollama: { residentModels: [] } }),
    intervalMs: 60_000,
  });
  sweep.start();
  sweep.start();
  assert.equal(sweep.active, true);
  sweep.stop();
  assert.equal(sweep.active, false);
});
