import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPlanLimits, recordPlanLimits } from "../server/plan.js";

/**
 * The plan store, not the probe. `agentAccounts` shells out to the real CLIs
 * and its answer depends on whether this machine happens to be signed in, so
 * asserting on it would test the operator rather than the code.
 */

const root = mkdtempSync(join(tmpdir(), "plan-test-"));
const storeAt = (name) => join(root, `${name}.json`);

const WINDOWS = {
  type: "limits",
  status: "allowed_warning",
  isUsingOverage: false,
  windows: [
    { id: "five_hour", utilization: 0.8, resetsAt: 1788468600 },
    { id: "seven_day", utilization: 0.63, resetsAt: 1788886800 },
  ],
};

test("a missing store is an empty answer, not a failure", async () => {
  // Before the first subscription turn there is genuinely nothing to report,
  // and the panel has to be able to render that state.
  assert.deepEqual(await readPlanLimits(storeAt("absent")), {});
});

test("windows are stored under their engine and read back whole", async () => {
  const path = storeAt("basic");
  await recordPlanLimits(path, "claude", WINDOWS);

  const limits = await readPlanLimits(path);
  assert.equal(limits.claude.status, "allowed_warning");
  assert.equal(limits.claude.isUsingOverage, false);
  assert.deepEqual(limits.claude.windows, WINDOWS.windows);
  // The stamp is what stops the panel implying these numbers are live.
  assert.ok(!Number.isNaN(Date.parse(limits.claude.observedAt)));
});

test("a later report replaces the earlier one rather than merging into it", async () => {
  const path = storeAt("replace");
  await recordPlanLimits(path, "claude", WINDOWS);
  await recordPlanLimits(path, "claude", {
    ...WINDOWS,
    windows: [{ id: "five_hour", utilization: 0.1, resetsAt: 1788480000 }],
  });

  const limits = await readPlanLimits(path);
  // The CLI reports the complete set it knows about each time. A window it has
  // stopped reporting has stopped applying, and merging would strand a bar on
  // screen that nothing would ever clear.
  assert.deepEqual(limits.claude.windows, [{ id: "five_hour", utilization: 0.1, resetsAt: 1788480000 }]);
});

test("an empty report is ignored so a good reading is never overwritten", async () => {
  const path = storeAt("empty");
  await recordPlanLimits(path, "claude", WINDOWS);
  await recordPlanLimits(path, "claude", { type: "limits", windows: [] });

  const limits = await readPlanLimits(path);
  assert.equal(limits.claude.windows.length, 2);
});

test("engines are kept apart", async () => {
  const path = storeAt("engines");
  await recordPlanLimits(path, "claude", WINDOWS);
  await recordPlanLimits(path, "codex", { ...WINDOWS, windows: [{ id: "five_hour", utilization: 0.5, resetsAt: null }] });

  const limits = await readPlanLimits(path);
  assert.equal(limits.claude.windows.length, 2);
  assert.equal(limits.codex.windows.length, 1);
  assert.equal(limits.codex.windows[0].resetsAt, null);
});
