/**
 * Supervision of the realtime voice pipeline.
 *
 * The pipeline is a Python process the studio does not own the source of and
 * cannot import, so every interesting decision is about a process that might
 * be absent, already running, or someone else's. Those are exactly the cases a
 * live test cannot cover cheaply — spawning a 2 GB virtualenv per assertion is
 * not a test suite — so the decision is a pure function and this pins it.
 *
 * The case that motivated the split: a pipeline still loading its weights holds
 * the port without answering, and the first version spawned a second process
 * into it, which failed on bind and restart-looped. "Busy" and "healthy" are
 * different questions and the planner now asks both.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  planRealtimeVoiceLaunch,
  resolveRealtimeVoicePython,
  realtimeVoiceSocketUrl,
  createRealtimeVoiceSupervisor,
} from "../server/realtime-voice.js";

const ROOT = "/repo/RealtimeVoiceChat";

/** A config shaped like the gateway's, with only the keys this module reads. */
function configure(overrides = {}) {
  return {
    realtimeVoiceUrl: new URL("http://127.0.0.1:8000"),
    realtimeVoiceRoot: ROOT,
    realtimeVoicePython: "",
    realtimeVoiceAutostart: true,
    realtimeVoiceStartupTimeoutMs: 300_000,
    ...overrides,
  };
}

/** A filesystem where a full install is present. */
const installed = (path) =>
  path === ROOT ||
  path === `${ROOT}/code/server.py` ||
  path === `${ROOT}/.venv/bin/python`;

const nothing = () => false;

test("a healthy server is adopted rather than duplicated", () => {
  const plan = planRealtimeVoiceLaunch({ config: configure(), healthy: true, portBusy: true, exists: installed });
  assert.equal(plan.action, "adopt");
  assert.equal(plan.reason, "already-listening");
});

test("adoption beats the autostart switch, so the setting never strands a running pipeline", () => {
  const plan = planRealtimeVoiceLaunch({
    config: configure({ realtimeVoiceAutostart: false }),
    healthy: true,
    exists: installed,
  });
  assert.equal(plan.action, "adopt");
});

test("a busy but unhealthy port is waited on, never spawned into", () => {
  const plan = planRealtimeVoiceLaunch({ config: configure(), healthy: false, portBusy: true, exists: installed });
  assert.equal(plan.action, "await");
  assert.equal(plan.reason, "port-busy");
  assert.equal(plan.command, undefined);
});

test("a free port with a complete install is spawned, told its own address", () => {
  const plan = planRealtimeVoiceLaunch({ config: configure(), healthy: false, portBusy: false, exists: installed });
  assert.equal(plan.action, "spawn");
  assert.equal(plan.command, `${ROOT}/.venv/bin/python`);
  assert.deepEqual(plan.args, ["server.py"]);
  assert.equal(plan.cwd, `${ROOT}/code`);
  assert.equal(plan.env.PORT, "8000");
  assert.equal(plan.env.HOST, "127.0.0.1");
  assert.equal(plan.env.PYTHONUNBUFFERED, "1");
});

test("autostart off on a free port starts nothing", () => {
  const plan = planRealtimeVoiceLaunch({
    config: configure({ realtimeVoiceAutostart: false }),
    healthy: false,
    exists: installed,
  });
  assert.equal(plan.action, "disabled");
});

test("a missing checkout is unavailable, not an error", () => {
  const plan = planRealtimeVoiceLaunch({ config: configure(), healthy: false, exists: nothing });
  assert.equal(plan.action, "unavailable");
  assert.equal(plan.reason, "no-checkout");
});

test("a checkout without an interpreter names the fix", () => {
  const exists = (path) => path === ROOT || path === `${ROOT}/code/server.py`;
  const plan = planRealtimeVoiceLaunch({ config: configure(), healthy: false, exists });
  assert.equal(plan.action, "unavailable");
  assert.equal(plan.reason, "no-interpreter");
  assert.match(plan.detail, /TEMINALI_REALTIME_VOICE_PYTHON/);
});

test("an explicitly configured interpreter is believed without probing the filesystem", () => {
  const python = resolveRealtimeVoicePython(configure({ realtimeVoicePython: "/opt/py" }), nothing);
  assert.equal(python, "/opt/py");
});

test("the Windows virtualenv layout is found too", () => {
  const exists = (path) => path === `${ROOT}/.venv/Scripts/python.exe`;
  assert.equal(resolveRealtimeVoicePython(configure(), exists), `${ROOT}/.venv/Scripts/python.exe`);
});

test("the socket address is derived from the HTTP one, so the port has one source", () => {
  assert.equal(realtimeVoiceSocketUrl("http://127.0.0.1:8000"), "ws://127.0.0.1:8000/ws");
  assert.equal(realtimeVoiceSocketUrl("https://127.0.0.1:8443"), "wss://127.0.0.1:8443/ws");
  assert.equal(realtimeVoiceSocketUrl(null), "");
});

test("an adopted pipeline is reported as adopted and is never killed on shutdown", async () => {
  let spawned = 0;
  const supervisor = createRealtimeVoiceSupervisor({
    config: configure(),
    spawnProcess: () => { spawned += 1; throw new Error("must not spawn"); },
    probe: async () => true,
  });
  const status = await supervisor.start();
  assert.equal(status.ready, true);
  assert.equal(status.adopted, true);
  assert.equal(status.supervised, false);
  await supervisor.stop();
  assert.equal(spawned, 0);
});

test("a missing install leaves the studio on its other voice tiers", async () => {
  const supervisor = createRealtimeVoiceSupervisor({
    config: configure({ realtimeVoiceRoot: "/nowhere" }),
    spawnProcess: () => { throw new Error("must not spawn"); },
    probe: async () => false,
    portBusyProbe: async () => false,
  });
  const status = await supervisor.start();
  assert.equal(status.state, "unavailable");
  assert.equal(status.ready, false);
  assert.equal(status.socketUrl, "ws://127.0.0.1:8000/ws");
});
