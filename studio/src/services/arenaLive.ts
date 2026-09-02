/**
 * The live state of a benchmark while it is still running.
 *
 * A benchmark takes minutes. Two agents edit their own copy of the repository,
 * then each copy is diffed, typechecked and tested. Collecting all of that
 * silently and rendering it at the end is the difference between a tool you can
 * watch and a tool you have to trust — and the whole point of this panel is to
 * stop trusting and start watching.
 *
 * So the state below is written to be *rendered mid-flight*: every stage has a
 * name, every stage that has not happened yet is visible as pending, and a
 * stopped run is distinguishable from a failed one. Dependency-free on purpose,
 * so the node test runner can reach it.
 */

export type LaneStatus =
  | "queued"
  | "preparing"
  | "working"
  | "measuring"
  | "checking"
  | "done"
  | "failed"
  | "stopped";

/**
 * One verification, with the state it is in right now.
 *
 * `pending` is a real state and is shown. A test suite that has not started yet
 * is information — it is the difference between "tests passed" and "tests have
 * not run", and a benchmark that blurred those two would be worthless.
 */
export interface LiveCheck {
  name: string;
  command: string;
  state: "pending" | "running" | "passed" | "failed";
  durationMs: number;
  output: string;
}

export interface LiveMeasurement {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  files: { status: string; path: string }[];
  diff: string;
  diffTruncated: boolean;
  checks: { name: string; command: string; passed: boolean; durationMs: number; output: string }[];
}

/** One line of the gateway's measurement stream. */
export type MeasureEvent =
  | ({ type: "diff" } & Omit<LiveMeasurement, "checks">)
  | { type: "check-start"; name: string; command: string }
  | { type: "check"; name: string; command: string; passed: boolean; durationMs: number; output: string }
  | { type: "result"; measurement: LiveMeasurement }
  | { type: "error"; code: string; message: string };

export interface LiveLaneState {
  status: LaneStatus;
  checks: LiveCheck[];
  measurement: LiveMeasurement | null;
}

const BUSY: LaneStatus[] = ["queued", "preparing", "working", "measuring", "checking"];

export function isLaneBusy(status: LaneStatus): boolean {
  return BUSY.includes(status);
}

/** What the operator reads next to the spinner. Present tense while it runs. */
export function statusLabel(status: LaneStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "preparing":
      return "Preparing sandbox";
    case "working":
      return "Working";
    case "measuring":
      return "Reading the diff";
    case "checking":
      return "Verifying";
    case "done":
      return "Finished";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

/** The checks a run is about to perform, listed before any of them start. */
export function pendingChecks(verify: { name: string; command: string }[]): LiveCheck[] {
  return verify.map((check) => ({
    name: check.name,
    command: check.command,
    state: "pending",
    durationMs: 0,
    output: "",
  }));
}

/**
 * Folds one measurement event into a lane.
 *
 * Kept as a pure function rather than inlined into the component because it is
 * the part where a wrong transition shows the operator a passing test suite
 * that never ran.
 */
export function applyMeasureEvent(state: LiveLaneState, event: MeasureEvent): LiveLaneState {
  switch (event.type) {
    case "diff": {
      const { type, ...diff } = event;
      return {
        ...state,
        // The diff arrives in milliseconds; what follows is the slow part.
        status: state.checks.length > 0 ? "checking" : state.status,
        measurement: { ...diff, checks: state.measurement?.checks ?? [] },
      };
    }
    case "check-start":
      return {
        ...state,
        status: "checking",
        checks: state.checks.map((check) =>
          check.name === event.name && check.state === "pending" ? { ...check, state: "running" } : check,
        ),
      };
    case "check": {
      const settled: LiveCheck = {
        name: event.name,
        command: event.command,
        state: event.passed ? "passed" : "failed",
        durationMs: event.durationMs,
        output: event.output,
      };
      const known = state.checks.some((check) => check.name === event.name);
      return {
        ...state,
        checks: known
          ? state.checks.map((check) => (check.name === event.name ? settled : check))
          : [...state.checks, settled],
      };
    }
    case "result":
      return {
        ...state,
        status: "done",
        measurement: event.measurement,
        // The server's final list is authoritative: a check that was skipped
        // because the run was stopped is simply not in it.
        checks: event.measurement.checks.map((check) => ({
          name: check.name,
          command: check.command,
          state: check.passed ? "passed" : "failed",
          durationMs: check.durationMs,
          output: check.output,
        })),
      };
    case "error":
      return { ...state, status: "failed" };
    default:
      return state;
  }
}

/** A running clock. Seconds while it is short, m:ss once it is not. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

/**
 * The tail of a transcript, for a box that is following along live.
 *
 * The head of a long agent transcript is the part nobody is reading — the
 * interesting line is always the last one — and holding the whole thing in the
 * DOM of a 130px box is what makes a live view stutter after ten minutes.
 */
export function tailOf(text: string, max = 12_000): string {
  return text.length <= max ? text : `…\n${text.slice(-max)}`;
}
