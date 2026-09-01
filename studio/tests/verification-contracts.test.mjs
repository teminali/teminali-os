import assert from "node:assert/strict";
import test from "node:test";
import { E2EBrowserAgentService } from "../src/services/e2eBrowserAgentService.ts";
import { VisualVerificationTesterSkill } from "../src/services/visualVerificationTesterSkill.ts";

const browserEvidence = () => ({
  runner: "playwright",
  startedAt: "2026-08-31T00:00:00.000Z",
  finishedAt: "2026-08-31T00:00:01.000Z",
  targetUrl: "http://127.0.0.1:3000",
  assertions: [
    {
      name: "workspace is visible",
      selector: ".workspace",
      action: "assert_visible",
      expectedOutcome: "workspace has a visible bounding box",
      actualOutcome: "workspace bounding box was 1280px × 720px",
      status: "pass",
      durationMs: 20,
      artifactRefs: ["runs/browser/trace.zip#workspace-visible"],
    },
    {
      name: "missing control is rejected",
      selector: "[data-testid=missing-control]",
      action: "click",
      expectedOutcome: "control handles a click",
      actualOutcome: "selector did not match an element",
      status: "fail",
      durationMs: 30,
      artifactRefs: ["runs/browser/trace.zip#missing-control"],
    },
  ],
  consoleErrors: [],
  pageErrors: [],
  networkFailures: [],
  artifactRefs: ["runs/browser/trace.zip", "runs/browser/final.png"],
});

test("browser suite without a runner is unmeasured", async () => {
  const report = await E2EBrowserAgentService.runSuite("workspace", "http://127.0.0.1:3000");
  assert.equal(report.measurementStatus, "unmeasured");
  assert.equal(report.score, null);
  assert.equal(report.passedCount, 0);
  assert.equal(report.totalAssertions, 0);
});

test("browser report is computed from supplied runner evidence", async () => {
  const evidence = browserEvidence();
  const report = await E2EBrowserAgentService.runSuite(
    "workspace",
    evidence.targetUrl,
    { run: async () => evidence },
  );
  assert.equal(report.measurementStatus, "measured");
  assert.equal(report.passedCount, 1);
  assert.equal(report.failedCount, 1);
  assert.equal(report.score, 50);
  assert.equal(report.selfHealRequired, true);
  assert.deepEqual(report.artifactRefs, evidence.artifactRefs);
});

test("runtime failures reduce the browser score and require repair", () => {
  const evidence = browserEvidence();
  evidence.assertions = [evidence.assertions[0]];
  evidence.consoleErrors = ["Uncaught Error: render failed"];
  const report = E2EBrowserAgentService.reportFromEvidence("workspace", evidence.targetUrl, evidence);
  assert.equal(report.score, 50);
  assert.equal(report.selfHealRequired, true);
});

test("evidence without a trace or screenshot is rejected", () => {
  const evidence = browserEvidence();
  evidence.artifactRefs = [];
  const report = E2EBrowserAgentService.reportFromEvidence("workspace", evidence.targetUrl, evidence);
  assert.equal(report.measurementStatus, "error");
  assert.equal(report.score, null);
});

test("visual suite reports unavailable DOM and engine checks as unmeasured", async () => {
  const report = await VisualVerificationTesterSkill.runVerificationSuite();
  assert.equal(report.measurementStatus, "unmeasured");
  assert.equal(report.visualFidelityScore, null);
  assert.equal(report.enginePreservationScore, null);
  assert.equal(report.autoPatched, false);
  assert.ok(report.assertions.every((assertion) => assertion.status === "unmeasured"));
});

test("functional engine score requires timestamped artifact evidence", async () => {
  const report = await VisualVerificationTesterSkill.runVerificationSuite(".ide-stage", {
    functionalEvidence: [{
      id: "engine_ai_stream",
      status: "pass",
      actualValue: "Stream returned 32 measured output tokens",
      details: "Captured from gateway request correlation run-123",
      measuredAt: "2026-08-31T00:00:02.000Z",
      artifactRefs: ["runs/run-123/model-stream.json"],
    }],
  });
  assert.equal(report.measurementStatus, "partial");
  assert.equal(report.enginePreservationScore, 100);
  assert.equal(report.measuredAssertions, 1);
  assert.equal(report.unmeasuredCount, report.totalAssertions - 1);
});
