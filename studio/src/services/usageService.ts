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

  /** Records a local-engine turn. Never throws: bookkeeping must not break chat. */
  public static async record(turn: LocalTurnUsage): Promise<void> {
    try {
      await GatewayClient.request("/api/usage", { method: "POST", body: JSON.stringify(turn) });
    } catch {
      /* Best effort. */
    }
  }
}
