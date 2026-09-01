import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runQualityGates } from "../orchestrator.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

const command = (source) => ({ executable: process.execPath, args: ["-e", source] });

const baseConfig = (projectRoot, suites) => ({
  schemaVersion: "frontier-quality-config/v1",
  projectRoot,
  artifactDirectory: "quality-artifacts",
  maxCapturedBytes: 1024 * 1024,
  maxReportBytes: 128 * 1024,
  defaultTimeoutMs: 5000,
  suites,
});

const passSuites = () => [
  { id: "typecheck", type: "typecheck", command: command("process.stdout.write('typecheck ok\\n')") },
  { id: "unit", type: "unit", command: command("process.stdout.write('unit ok\\n')") },
  { id: "integration", type: "integration", command: command("process.stdout.write('integration ok\\n')") },
];

const makeProject = async () => mkdtemp(join(tmpdir(), "frontier-quality-runtime-"));

const browserRunnerCommand = (traceSha256, screenshotSha256, consoleErrors = []) => command(`
  const { writeFileSync } = require("node:fs");
  const startedAt = new Date().toISOString();
  const report = {
    schemaVersion: "frontier-browser-evidence/v1",
    qualityRunId: process.env.FRONTIER_QUALITY_RUN_ID,
    runner: "playwright",
    targetUrl: "http://127.0.0.1:3000",
    startedAt,
    finishedAt: new Date().toISOString(),
    assertions: [{ name: "workspace visible", status: "pass" }],
    consoleErrors: ${JSON.stringify(consoleErrors)},
    pageErrors: [],
    networkFailures: [],
    artifacts: [
      { kind: "trace", path: "browser/trace.zip", sha256: "${traceSha256}" },
      { kind: "screenshot", path: "browser/screenshot.png", sha256: "${screenshotSha256}" }
    ]
  };
  writeFileSync("browser/report.json", JSON.stringify(report) + "\\n", { flag: "wx" });
`);

test("seeded JavaScript syntax and service failures are caught with exact stream evidence", async () => {
  const projectRoot = await makeProject();
  await writeFile(join(projectRoot, "broken.js"), "function seededSyntaxFailure( {\n");
  await writeFile(
    join(projectRoot, "failing-service.mjs"),
    "process.stdout.write('service-started\\n'); process.stderr.write('seeded service failure\\n'); process.exit(7);\n",
  );
  const result = await runQualityGates(baseConfig(projectRoot, [
    { id: "typecheck", type: "typecheck", command: { executable: process.execPath, args: ["--check", "broken.js"] } },
    { id: "unit", type: "unit", command: command("process.stdout.write('unit ok\\n')") },
    { id: "integration", type: "integration", command: { executable: process.execPath, args: ["failing-service.mjs"] } },
  ]));

  assert.equal(result.report.successful, false);
  assert.equal(result.report.status, "fail");
  const typecheck = result.report.suites.find((suite) => suite.type === "typecheck");
  const integration = result.report.suites.find((suite) => suite.type === "integration");
  const browser = result.report.suites.find((suite) => suite.type === "browser");
  assert.equal(typecheck.status, "fail");
  assert.notEqual(typecheck.exitCode, 0);
  assert.equal(integration.status, "fail");
  assert.equal(integration.exitCode, 7);
  assert.equal(browser.status, "unmeasured");

  const typecheckStderr = await readFile(join(projectRoot, typecheck.stderr.path));
  const serviceStdout = await readFile(join(projectRoot, integration.stdout.path));
  const serviceStderr = await readFile(join(projectRoot, integration.stderr.path));
  assert.match(typecheckStderr.toString("utf8"), /SyntaxError/);
  assert.equal(serviceStdout.toString("utf8"), "service-started\n");
  assert.equal(serviceStderr.toString("utf8"), "seeded service failure\n");
  assert.equal(typecheck.stderr.sha256, digest(typecheckStderr));
  assert.equal(integration.stdout.sha256, digest(serviceStdout));
  assert.ok(Date.parse(typecheck.finishedAt) >= Date.parse(typecheck.startedAt));
});

test("a missing browser runner prevents overall success", async () => {
  const projectRoot = await makeProject();
  const result = await runQualityGates(baseConfig(projectRoot, passSuites()));
  assert.equal(result.report.summary.passed, 3);
  assert.equal(result.report.summary.unmeasured, 1);
  assert.equal(result.report.successful, false);
  assert.equal(result.report.suites.find((suite) => suite.type === "browser").reason, "No browser suite is configured.");
});

test("a successful browser command without report, trace, and screenshot remains unmeasured", async () => {
  const projectRoot = await makeProject();
  const suites = [...passSuites(), {
    id: "browser",
    type: "browser",
    command: command("process.stdout.write('browser command exited zero\\n')"),
    evidenceFiles: [],
  }];
  const result = await runQualityGates(baseConfig(projectRoot, suites));
  const browser = result.report.suites.find((suite) => suite.type === "browser");
  assert.equal(browser.exitCode, 0);
  assert.equal(browser.status, "unmeasured");
  assert.match(browser.reason, /browser-report, trace, screenshot/);
  assert.equal(result.report.successful, false);
});

test("all four gates pass only with measured clean browser evidence", async () => {
  const projectRoot = await makeProject();
  await mkdir(join(projectRoot, "browser"));
  const traceBytes = Buffer.from("deterministic trace fixture\n");
  const screenshotBytes = Buffer.from("deterministic screenshot fixture bytes\n");
  await writeFile(join(projectRoot, "browser", "trace.zip"), traceBytes);
  await writeFile(join(projectRoot, "browser", "screenshot.png"), screenshotBytes);

  const suites = [...passSuites(), {
    id: "browser",
    type: "browser",
    command: browserRunnerCommand(digest(traceBytes), digest(screenshotBytes)),
    evidenceFiles: [
      { kind: "browser-report", path: "browser/report.json" },
      { kind: "trace", path: "browser/trace.zip" },
      { kind: "screenshot", path: "browser/screenshot.png" },
    ],
  }];
  const result = await runQualityGates(baseConfig(projectRoot, suites));
  assert.equal(result.report.successful, true);
  assert.equal(result.report.summary.passed, 4);
  assert.ok(result.report.suites.every((suite) => suite.status === "pass"));
  const reportBytes = await readFile(join(projectRoot, result.reportArtifact.path));
  assert.equal(result.reportArtifact.sha256, digest(reportBytes));
  assert.ok(reportBytes.length <= 128 * 1024);
});

test("browser assertion or runtime failures fail the browser gate", async () => {
  const projectRoot = await makeProject();
  await mkdir(join(projectRoot, "browser"));
  const traceBytes = Buffer.from("trace\n");
  const screenshotBytes = Buffer.from("screenshot\n");
  await writeFile(join(projectRoot, "browser", "trace.zip"), traceBytes);
  await writeFile(join(projectRoot, "browser", "screenshot.png"), screenshotBytes);
  const result = await runQualityGates(baseConfig(projectRoot, [...passSuites(), {
    id: "browser",
    type: "browser",
    command: browserRunnerCommand(digest(traceBytes), digest(screenshotBytes), ["Uncaught Error: seeded render failure"]),
    evidenceFiles: [
      { kind: "browser-report", path: "browser/report.json" },
      { kind: "trace", path: "browser/trace.zip" },
      { kind: "screenshot", path: "browser/screenshot.png" },
    ],
  }]));
  const browser = result.report.suites.find((suite) => suite.type === "browser");
  assert.equal(browser.status, "fail");
  assert.match(browser.reason, /1 assertion or runtime failures/);
  assert.equal(result.report.successful, false);
});
