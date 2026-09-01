/**
 * Evidence-based visual and functional verification.
 * DOM geometry is measured locally; functional claims require runner artifacts.
 */

export type VisualAssertionStatus = "pass" | "fail" | "warning" | "unmeasured";

export interface VisualAssertionResult {
  id: string;
  name: string;
  category: "layout" | "color" | "functional_engine" | "spacing" | "responsiveness";
  status: VisualAssertionStatus;
  expectedValue: string;
  actualValue: string;
  deltaScore: number | null;
  details: string;
  measuredAt: string | null;
  artifactRefs: string[];
}

export interface FunctionalVerificationEvidence {
  id: "engine_monaco_active" | "engine_ai_stream" | "engine_workspace_search" | "engine_video_studio";
  status: "pass" | "fail";
  actualValue: string;
  details: string;
  measuredAt: string;
  artifactRefs: string[];
}

export interface VerificationSuiteReport {
  timestamp: number;
  measurementStatus: "measured" | "partial" | "unmeasured";
  totalAssertions: number;
  measuredAssertions: number;
  passedCount: number;
  failedCount: number;
  unmeasuredCount: number;
  visualFidelityScore: number | null;
  enginePreservationScore: number | null;
  assertions: VisualAssertionResult[];
  autoPatched: false;
  summary: string;
}

export interface VerificationOptions {
  functionalEvidence?: FunctionalVerificationEvidence[];
}

const nowIso = (): string => new Date().toISOString();

const unmeasured = (
  id: VisualAssertionResult["id"],
  name: string,
  category: VisualAssertionResult["category"],
  expectedValue: string,
  details: string,
): VisualAssertionResult => ({
  id,
  name,
  category,
  status: "unmeasured",
  expectedValue,
  actualValue: "Not measured",
  deltaScore: null,
  details,
  measuredAt: null,
  artifactRefs: [],
});

const percent = (passed: number, measured: number): number | null =>
  measured === 0 ? null : Math.round((passed / measured) * 10_000) / 100;

export class VisualVerificationTesterSkill {
  public static async runVerificationSuite(
    rootSelector = ".ide-stage",
    options: VerificationOptions = {},
  ): Promise<VerificationSuiteReport> {
    const assertions: VisualAssertionResult[] = [];
    const canMeasureDom = typeof document !== "undefined" && typeof window !== "undefined";

    if (!canMeasureDom) {
      assertions.push(unmeasured(
        "root_visible",
        "Application root visibility",
        "layout",
        `${rootSelector} exists and has a non-zero rectangle`,
        "DOM APIs are unavailable in this runtime.",
      ));
    } else {
      const root = document.querySelector(rootSelector);
      const rootRect = root?.getBoundingClientRect();
      const visible = Boolean(root && rootRect && rootRect.width > 0 && rootRect.height > 0);
      assertions.push({
        id: "root_visible",
        name: "Application root visibility",
        category: "layout",
        status: visible ? "pass" : "fail",
        expectedValue: `${rootSelector} exists and has a non-zero rectangle`,
        actualValue: rootRect
          ? `${Math.round(rootRect.width)}px × ${Math.round(rootRect.height)}px`
          : "Element not found",
        deltaScore: visible ? 0 : 100,
        details: "Measured from getBoundingClientRect in the active document.",
        measuredAt: nowIso(),
        artifactRefs: [],
      });

      const geometryChecks = [
        { id: "topbar_geometry", name: "Topbar height", selector: ".topbar", property: "height", expected: 50 },
        { id: "rail_geometry", name: "Activity rail width", selector: ".activity-rail", property: "width", expected: 64 },
      ] as const;

      for (const check of geometryChecks) {
        const element = document.querySelector(check.selector);
        const actual = element ? Number.parseFloat(window.getComputedStyle(element)[check.property]) : Number.NaN;
        const delta = Number.isFinite(actual) ? Math.abs(actual - check.expected) : null;
        assertions.push({
          id: check.id,
          name: check.name,
          category: "layout",
          status: delta === null ? "fail" : delta <= 1 ? "pass" : "fail",
          expectedValue: `${check.expected}px ± 1px`,
          actualValue: Number.isFinite(actual) ? `${actual}px` : "Element or computed value unavailable",
          deltaScore: delta,
          details: `Measured ${check.property} using getComputedStyle.`,
          measuredAt: nowIso(),
          artifactRefs: [],
        });
      }

      const workspace = document.querySelector(".workspace");
      const display = workspace ? window.getComputedStyle(workspace).display : null;
      assertions.push({
        id: "workspace_grid_layout",
        name: "Workspace grid layout",
        category: "layout",
        status: display === "grid" ? "pass" : "fail",
        expectedValue: "display: grid",
        actualValue: display ?? "Element not found",
        deltaScore: display === "grid" ? 0 : 100,
        details: "Measured the computed display property in the active document.",
        measuredAt: nowIso(),
        artifactRefs: [],
      });
    }

    const evidenceById = new Map((options.functionalEvidence ?? []).map((item) => [item.id, item]));
    const functionalChecks = [
      ["engine_monaco_active", "Monaco editor interaction", "A browser interaction trace proving Monaco accepted and retained input"],
      ["engine_ai_stream", "Local AI stream", "A captured model stream with request, response, timing, and provider status"],
      ["engine_workspace_search", "Workspace search", "A browser trace showing a query and verified result selection"],
      ["engine_video_studio", "Video studio MCP", "A verified MCP mutation with before/after timeline evidence"],
    ] as const;

    for (const [id, name, expectedValue] of functionalChecks) {
      const evidence = evidenceById.get(id);
      const validEvidence = Boolean(
        evidence &&
        Number.isFinite(Date.parse(evidence.measuredAt)) &&
        evidence.artifactRefs.length > 0,
      );

      assertions.push(validEvidence && evidence ? {
        id,
        name,
        category: "functional_engine",
        status: evidence.status,
        expectedValue,
        actualValue: evidence.actualValue,
        deltaScore: evidence.status === "pass" ? 0 : 100,
        details: evidence.details,
        measuredAt: evidence.measuredAt,
        artifactRefs: [...evidence.artifactRefs],
      } : unmeasured(
        id,
        name,
        "functional_engine",
        expectedValue,
        evidence
          ? "Evidence was rejected because it lacked a valid timestamp or artifact reference."
          : "No functional runner evidence was supplied.",
      ));
    }

    const measured = assertions.filter((assertion) => assertion.status !== "unmeasured");
    const passed = measured.filter((assertion) => assertion.status === "pass");
    const failed = measured.filter((assertion) => assertion.status === "fail");
    const visual = measured.filter((assertion) => assertion.category !== "functional_engine");
    const visualPassed = visual.filter((assertion) => assertion.status === "pass").length;
    const engine = measured.filter((assertion) => assertion.category === "functional_engine");
    const enginePassed = engine.filter((assertion) => assertion.status === "pass").length;
    const unmeasuredCount = assertions.length - measured.length;
    const measurementStatus = measured.length === 0
      ? "unmeasured"
      : unmeasuredCount > 0
        ? "partial"
        : "measured";

    return {
      timestamp: Date.now(),
      measurementStatus,
      totalAssertions: assertions.length,
      measuredAssertions: measured.length,
      passedCount: passed.length,
      failedCount: failed.length,
      unmeasuredCount,
      visualFidelityScore: percent(visualPassed, visual.length),
      enginePreservationScore: percent(enginePassed, engine.length),
      assertions,
      autoPatched: false,
      summary: `${measured.length}/${assertions.length} assertions measured; ${failed.length} measured failures; ${unmeasuredCount} unmeasured.`,
    };
  }
}
