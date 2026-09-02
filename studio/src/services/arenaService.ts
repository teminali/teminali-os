import { GatewayClient } from "./gatewayClient";
import type { AgentEngine } from "./agentCliService";
import type { MeasureEvent } from "./arenaLive";

/**
 * The benchmark arena: the same task, run by rivals who cannot see each other.
 *
 * Every run is Frontier against a challenger, because the point is to measure
 * this platform rather than to rank other people's models. The watcher is the
 * agent that is *not* competing, so a verdict is never self-graded.
 *
 * Each contestant works in its own sandbox — a private copy of the current
 * workspace with its own git — so "what did it change" is measured from disk
 * rather than taken from what the agent said it did. An agent that claims an
 * edit it never made is exactly what that catches.
 */

export type ContestantKind = "frontier" | AgentEngine;

export interface Contestant {
  /** Stable id, also the sandbox directory name. */
  id: string;
  kind: ContestantKind;
  label: string;
  /** Frontier lane, or the agent CLI's `--model`. */
  model: string | null;
}

export interface SandboxInfo {
  contestantId: string;
  relativePath: string;
  filesCopied: number;
  moduleLinks: string[];
  sharedModules: boolean;
}

export interface VerifyCheck {
  name: string;
  command: string;
}

export interface SandboxMeasurement {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  files: { status: string; path: string }[];
  diff: string;
  diffTruncated: boolean;
  checks: { name: string; command: string; passed: boolean; durationMs: number; output: string }[];
}

/** Everything one contestant did, measured and observed. */
export interface ContestantResult {
  contestant: Contestant;
  sandbox: SandboxInfo | null;
  transcript: string;
  toolCalls: number;
  durationMs: number;
  tokens: number;
  costUsd: number | null;
  error: string | null;
  measurement: SandboxMeasurement | null;
}

/** One past run, as the history keeps it. Diffs are not stored — see arena.js. */
export interface ArenaRunRecord {
  at?: string;
  runId: string | null;
  task: string;
  watcher: string | null;
  selfGraded: boolean;
  winner: string | null;
  summary: string;
  improvements: string[];
  contestants: {
    id: string;
    label: string;
    kind: string;
    model: string | null;
    completed: boolean;
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    toolCalls: number;
    durationMs: number;
    tokens: number;
    costUsd: number | null;
    checks: { name: string; passed: boolean }[];
  }[];
}

export const DEFAULT_CHECKS: VerifyCheck[] = [
  { name: "Typecheck", command: "cd studio && npx tsc --noEmit" },
  { name: "Tests", command: "cd studio && npm test" },
];

export class ArenaService {
  /** Builds one isolated copy of the workspace per contestant. */
  static async createSandboxes(runId: string, contestants: string[]): Promise<SandboxInfo[]> {
    const response = await GatewayClient.request("/api/arena/sandbox", {
      method: "POST",
      body: JSON.stringify({ runId, contestants }),
    });
    await GatewayClient.expectOk(response);
    const payload = (await response.json()) as { sandboxes: SandboxInfo[] };
    return payload.sandboxes;
  }

  static async measure(runId: string, contestantId: string, verify: VerifyCheck[]): Promise<SandboxMeasurement> {
    const response = await GatewayClient.request("/api/arena/measure", {
      method: "POST",
      body: JSON.stringify({ runId, contestantId, verify }),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as SandboxMeasurement;
  }

  /**
   * The same measurement, reported stage by stage as it happens.
   *
   * The diff lands in milliseconds; the typecheck and the test suite after it
   * take tens of seconds each. `onEvent` fires for every stage so the panel can
   * name the check that is running instead of showing an unlabelled spinner for
   * a minute — and the resolved value is the same measurement the blocking
   * route returns, so nothing downstream has to know which one was used.
   */
  static async measureStream(
    runId: string,
    contestantId: string,
    verify: VerifyCheck[],
    onEvent: (event: MeasureEvent) => void,
    signal?: AbortSignal,
  ): Promise<SandboxMeasurement> {
    const response = await GatewayClient.request("/api/arena/measure/stream", {
      method: "POST",
      signal,
      body: JSON.stringify({ runId, contestantId, verify }),
    });
    await GatewayClient.expectOk(response);
    if (!response.body) throw new Error("The gateway returned no measurement stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Held here rather than assembled from the events, so a client that missed
    // one still ends up with exactly what the server measured.
    const settled: { measurement: SandboxMeasurement | null; failure: string | null } = {
      measurement: null,
      failure: null,
    };

    const consume = (line: string) => {
      if (!line.trim()) return;
      let event: MeasureEvent;
      try {
        event = JSON.parse(line) as MeasureEvent;
      } catch {
        return;
      }
      if (event.type === "result") settled.measurement = event.measurement as SandboxMeasurement;
      if (event.type === "error") settled.failure = event.message;
      onEvent(event);
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index !== -1) {
          consume(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      }
      if (buffer.trim()) consume(buffer);
    } finally {
      reader.releaseLock();
    }

    if (settled.failure) throw new Error(settled.failure);
    if (!settled.measurement) throw new Error("The measurement stream ended without a result.");
    return settled.measurement;
  }

  /** Records a finished run. Best-effort: history must not fail the benchmark. */
  static async recordRun(run: ArenaRunRecord): Promise<void> {
    try {
      const response = await GatewayClient.request("/api/arena/history", {
        method: "POST",
        body: JSON.stringify(run),
      });
      await GatewayClient.expectOk(response);
    } catch {
      /* Best effort. */
    }
  }

  static async history(limit = 50, signal?: AbortSignal): Promise<ArenaRunRecord[]> {
    try {
      const response = await GatewayClient.request(`/api/arena/history?limit=${limit}`, { method: "GET", signal });
      if (!response.ok) return [];
      const payload = (await response.json()) as { runs: ArenaRunRecord[] };
      return payload.runs ?? [];
    } catch {
      return [];
    }
  }

  static async cleanup(runId: string): Promise<void> {
    try {
      const response = await GatewayClient.request("/api/arena/cleanup", {
        method: "POST",
        body: JSON.stringify({ runId }),
      });
      await GatewayClient.expectOk(response);
    } catch {
      // A sandbox left behind is untidy, not dangerous; it lives under
      // .frontier-arena and the next run of the same id replaces it.
    }
  }
}

export {
  eligibleWatchers,
  formatBenchmarkReport,
  isSelfGraded,
  parseVerdict,
  watcherPrompt,
  type ArenaEngine,
  type ArenaResult,
  type Verdict,
} from "./arenaVerdict";

export {
  applyMeasureEvent,
  formatElapsed,
  isLaneBusy,
  pendingChecks,
  statusLabel,
  tailOf,
  type LaneStatus,
  type LiveCheck,
  type LiveLaneState,
  type MeasureEvent,
} from "./arenaLive";
