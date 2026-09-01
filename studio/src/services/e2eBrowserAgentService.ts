/**
 * Browser verification contract.
 *
 * This module deliberately does not pretend that a DOM query is a browser run.
 * A Playwright (or equivalent) process must execute the suite and return its
 * captured evidence through BrowserEvidenceRunner. When no runner is supplied,
 * the result is explicitly unmeasured.
 */

export type E2EAssertionStatus = "pass" | "fail" | "unmeasured";

export interface E2ETestAssertion {
  name: string;
  selector: string;
  action: "click" | "input" | "scroll" | "assert_visible" | "assert_text";
  payload?: string;
  expectedOutcome: string;
  actualOutcome: string;
  status: E2EAssertionStatus;
  durationMs: number | null;
  artifactRefs: string[];
}

export interface BrowserRunEvidence {
  runner: "playwright" | "webdriver" | "other";
  startedAt: string;
  finishedAt: string;
  targetUrl: string;
  assertions: E2ETestAssertion[];
  consoleErrors: string[];
  pageErrors: string[];
  networkFailures: string[];
  artifactRefs: string[];
}

export interface BrowserEvidenceRunner {
  run(request: { testSuiteName: string; targetUrl: string }): Promise<BrowserRunEvidence>;
}

export interface E2EExecutionReport {
  timestamp: number;
  testSuiteName: string;
  targetUrl: string;
  measurementStatus: "measured" | "unmeasured" | "error";
  measurementMessage: string;
  runner: BrowserRunEvidence["runner"] | null;
  startedAt: string | null;
  finishedAt: string | null;
  totalAssertions: number;
  measuredAssertions: number;
  passedCount: number;
  failedCount: number;
  consoleErrors: string[];
  pageErrors: string[];
  networkFailures: string[];
  assertions: E2ETestAssertion[];
  artifactRefs: string[];
  selfHealRequired: boolean;
  score: number | null;
}

const isFiniteNonNegative = (value: number | null): boolean =>
  value === null || (Number.isFinite(value) && value >= 0);

const isValidIsoDate = (value: string): boolean =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);

const unmeasuredReport = (
  testSuiteName: string,
  targetUrl: string,
  message: string,
  measurementStatus: "unmeasured" | "error" = "unmeasured",
): E2EExecutionReport => ({
  timestamp: Date.now(),
  testSuiteName,
  targetUrl,
  measurementStatus,
  measurementMessage: message,
  runner: null,
  startedAt: null,
  finishedAt: null,
  totalAssertions: 0,
  measuredAssertions: 0,
  passedCount: 0,
  failedCount: 0,
  consoleErrors: [],
  pageErrors: [],
  networkFailures: [],
  assertions: [],
  artifactRefs: [],
  selfHealRequired: false,
  score: null,
});

export class E2EBrowserAgentService {
  public static reportFromEvidence(
    testSuiteName: string,
    targetUrl: string,
    evidence: BrowserRunEvidence,
  ): E2EExecutionReport {
    const startedMs = Date.parse(evidence.startedAt);
    const finishedMs = Date.parse(evidence.finishedAt);
    const assertionsValid = Array.isArray(evidence.assertions) && evidence.assertions.every((assertion) =>
      assertion &&
      typeof assertion.name === "string" &&
      typeof assertion.selector === "string" &&
      ["click", "input", "scroll", "assert_visible", "assert_text"].includes(assertion.action) &&
      typeof assertion.expectedOutcome === "string" &&
      typeof assertion.actualOutcome === "string" &&
      ["pass", "fail", "unmeasured"].includes(assertion.status) &&
      isFiniteNonNegative(assertion.durationMs) &&
      (assertion.status === "unmeasured" || assertion.durationMs !== null) &&
      isStringArray(assertion.artifactRefs) &&
      (assertion.status === "unmeasured" || assertion.artifactRefs.length > 0)
    );

    if (
      !isValidIsoDate(evidence.startedAt) ||
      !isValidIsoDate(evidence.finishedAt) ||
      finishedMs < startedMs ||
      evidence.targetUrl !== targetUrl ||
      !["playwright", "webdriver", "other"].includes(evidence.runner) ||
      !assertionsValid ||
      !isStringArray(evidence.consoleErrors) ||
      !isStringArray(evidence.pageErrors) ||
      !isStringArray(evidence.networkFailures) ||
      !isStringArray(evidence.artifactRefs) ||
      evidence.artifactRefs.length === 0
    ) {
      return unmeasuredReport(
        testSuiteName,
        targetUrl,
        "Browser runner returned malformed or mismatched evidence.",
        "error",
      );
    }

    const measured = evidence.assertions.filter((assertion) => assertion.status !== "unmeasured");
    const passedCount = measured.filter((assertion) => assertion.status === "pass").length;
    const failedCount = measured.filter((assertion) => assertion.status === "fail").length;
    const runtimeFailureCount =
      evidence.consoleErrors.length + evidence.pageErrors.length + evidence.networkFailures.length;
    const scoredChecks = measured.length + runtimeFailureCount;
    const score = scoredChecks === 0
      ? null
      : Math.round((passedCount / scoredChecks) * 10_000) / 100;

    return {
      timestamp: Date.now(),
      testSuiteName,
      targetUrl,
      measurementStatus: measured.length === 0 ? "unmeasured" : "measured",
      measurementMessage: measured.length === 0
        ? "The browser runner completed but returned no measured assertions."
        : `Recorded ${measured.length} browser assertions from ${evidence.runner}.`,
      runner: evidence.runner,
      startedAt: evidence.startedAt,
      finishedAt: evidence.finishedAt,
      totalAssertions: evidence.assertions.length,
      measuredAssertions: measured.length,
      passedCount,
      failedCount,
      consoleErrors: [...evidence.consoleErrors],
      pageErrors: [...evidence.pageErrors],
      networkFailures: [...evidence.networkFailures],
      assertions: evidence.assertions.map((assertion) => ({
        ...assertion,
        artifactRefs: [...assertion.artifactRefs],
      })),
      artifactRefs: [...evidence.artifactRefs],
      selfHealRequired: failedCount > 0 || runtimeFailureCount > 0,
      score,
    };
  }

  /** Execute only through an explicitly supplied browser runner. */
  public static async runSuite(
    testSuiteName: string,
    targetUrl: string,
    runner?: BrowserEvidenceRunner,
  ): Promise<E2EExecutionReport> {
    if (!runner) {
      return unmeasuredReport(
        testSuiteName,
        targetUrl,
        "No browser evidence runner is configured. No assertions were executed.",
      );
    }

    try {
      const evidence = await runner.run({ testSuiteName, targetUrl });
      return this.reportFromEvidence(testSuiteName, targetUrl, evidence);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return unmeasuredReport(
        testSuiteName,
        targetUrl,
        `Browser runner failed: ${detail}`,
        "error",
      );
    }
  }
}
