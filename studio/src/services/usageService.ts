import { GatewayClient } from "./gatewayClient";

/**
 * The usage ledger, read and written.
 *
 * Agent turns are recorded by the gateway itself, which sees them whether or not
 * this window is still open. The local engine counts its tokens in the renderer,
 * so a local turn is the one kind that has to be reported from here — and the
 * gateway refuses an agent engine on that route precisely so the two paths can
 * never double-count the same turn.
 */

export interface UsageBucket {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number;
  turns: number;
  /** False when no turn in this bucket reported a cost — see the panel. */
  costReported: boolean;
}

export interface UsageSummary {
  days: number;
  generatedAt: string;
  totals: UsageBucket;
  average: {
    perDay: { tokens: number; costUsd: number };
    perActiveDay: { tokens: number; costUsd: number };
    activeDays: number;
  };
  daily: (UsageBucket & { day: string })[];
  models: (UsageBucket & { id: string; engine: string })[];
  engines: (UsageBucket & { id: string })[];
}

/**
 * Plan headroom, as last reported by an agent CLI.
 *
 * Separate from the ledger above on purpose. The ledger is what this machine
 * has spent; this is what the account has left, which only the provider knows.
 * `observedAt` is load-bearing rather than decorative: these windows move only
 * when a turn runs, so the panel has to say when the reading was taken instead
 * of implying it is live.
 */
export interface PlanWindow {
  /** `five_hour`, `seven_day`, or a model-scoped window the CLI reported. */
  id: string;
  /** 0–1, as the CLI reports it. */
  utilization: number;
  /** Unix seconds, or null when the CLI did not say. */
  resetsAt: number | null;
}

export interface PlanLimits {
  observedAt: string;
  status: string | null;
  isUsingOverage: boolean;
  windows: PlanWindow[];
}

export interface PlanAccount {
  loggedIn: boolean;
  /** `claude.ai` is the only login with a plan behind it. */
  authMethod: string | null;
  email: string | null;
  organization: string | null;
  plan: string | null;
  /** Whatever the CLI said when it could not answer in fields. */
  detail: string | null;
}

export interface PlanSummary {
  accounts: Partial<Record<"claude" | "codex", PlanAccount>>;
  limits: Partial<Record<"claude" | "codex", PlanLimits>>;
}

export interface LocalTurnUsage {
  engine: string;
  model?: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  costUsd?: number | null;
  durationMs?: number | null;
}

export class UsageService {
  public static async summary(days = 7, signal?: AbortSignal): Promise<UsageSummary | null> {
    try {
      const response = await GatewayClient.request(`/api/usage?days=${days}`, { method: "GET", signal });
      if (!response.ok) return null;
      return (await response.json()) as UsageSummary;
    } catch {
      return null;
    }
  }

  /** Who the agent CLIs are signed in as, and what is left of the plan. */
  public static async plan(signal?: AbortSignal): Promise<PlanSummary | null> {
    try {
      const response = await GatewayClient.request("/api/plan", { method: "GET", signal });
      if (!response.ok) return null;
      return (await response.json()) as PlanSummary;
    } catch {
      return null;
    }
  }

  /** Records a local-engine turn. Never throws: bookkeeping must not break chat. */
  public static async record(turn: LocalTurnUsage): Promise<void> {
    try {
      await GatewayClient.request("/api/usage", { method: "POST", body: JSON.stringify(turn) });
    } catch {
      /* Best effort. */
    }
  }
}
