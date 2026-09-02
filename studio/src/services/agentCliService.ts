import { GatewayClient } from "./gatewayClient";
import type { StreamCallbacks } from "./frontierEngine";
import type { ToolCall } from "../types";

/**
 * Claude Code and Codex, driven as processes rather than as providers.
 *
 * The gateway runs the operator's own CLI in the workspace and streams back one
 * normalised event per line (see server/agent-cli.js). This maps that stream
 * onto the same `StreamCallbacks` the local engine uses, which is why a turn
 * from Claude Code renders with the same message block, tool timeline and
 * telemetry footer as a turn from Frontier — the surface does not need to know
 * which agent produced it.
 *
 * Session continuity is the one piece of state this holds. Each agent tab keeps
 * the id the CLI handed back and passes it to the next turn, so the tab is a
 * conversation with a resumable session behind it rather than a series of
 * unrelated one-shot invocations.
 */

export type AgentEngine = "claude" | "codex";

export interface AgentDescriptor {
  label: string;
  bin: string;
  installed: boolean;
  version: string | null;
  permissions: string[];
  defaultPermission: string;
}

export interface AgentTurnOptions {
  engine: AgentEngine;
  prompt: string;
  /** Workspace-relative. Empty means the workspace root. */
  cwd?: string;
  /** Resume the CLI's own session. Null starts a fresh one. */
  sessionId?: string | null;
  model?: string | null;
  permission?: string;
  signal?: AbortSignal;
}

/** One selectable model, and how much we actually know about it. */
export interface AgentModel {
  /** The `--model` value. Null means "let the CLI choose". */
  id: string | null;
  label: string;
  detail?: string;
  /** The concrete model id this resolves to, when known. */
  resolves: string | null;
  /**
   * Where `resolves` came from. `observed` means a turn actually reported it;
   * `config` means it was read out of the operator's own CLI config; `catalog`
   * means it is our shipped best knowledge and has not been seen happen yet.
   */
  source: "observed" | "config" | "catalog" | "unknown";
  observedAt: string | null;
}

export interface AgentModelSet {
  configured: string | null;
  models: AgentModel[];
}

/** The turn's token accounting, already summed across every model it used. */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  models: { id: string; costUsd: number | null; inputTokens: number; outputTokens: number }[];
}

export interface AgentTurnResult {
  sessionId: string | null;
  ok: boolean;
  /** Null when the agent does not report cost — not zero. See below. */
  costUsd: number | null;
  durationMs: number;
  usage: AgentUsage | null;
  permissionDenials: unknown[];
}

/** One line of the gateway's normalised stream. */
type AgentEvent =
  | { type: "session"; sessionId: string | null; model: string | null; cwd: string | null; tools: string[] }
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name?: string; input?: Record<string, unknown>; status: ToolCall["status"]; output?: string; isError?: boolean }
  | { type: "result"; ok: boolean; durationMs: number | null; costUsd: number | null; sessionId: string | null; usage: AgentUsage | null; text: string | null; permissionDenials: unknown[] }
  | { type: "error"; code: string; message: string }
  | { type: "notice"; text: string }
  | { type: "done"; sessionId: string | null; durationMs: number; truncated: boolean; reason: string | null; stderr: string };

export class AgentCliService {
  /** Which agents are installed. Never throws: "not installed" is an answer. */
  public static async available(signal?: AbortSignal): Promise<Record<AgentEngine, AgentDescriptor> | null> {
    try {
      const response = await GatewayClient.request("/api/agents", { method: "GET", signal });
      if (!response.ok) return null;
      const payload = (await response.json()) as { agents: Record<AgentEngine, AgentDescriptor> };
      return payload.agents ?? null;
    } catch {
      return null;
    }
  }

  /** The selectable models per agent. Null when the gateway is unreachable. */
  public static async models(signal?: AbortSignal): Promise<Record<AgentEngine, AgentModelSet> | null> {
    try {
      const response = await GatewayClient.request("/api/agents/models", { method: "GET", signal });
      if (!response.ok) return null;
      return (await response.json()) as Record<AgentEngine, AgentModelSet>;
    } catch {
      return null;
    }
  }

  public static async streamTurn(
    options: AgentTurnOptions,
    callbacks: StreamCallbacks,
  ): Promise<AgentTurnResult> {
    const startedAt = performance.now();
    const startedIso = new Date().toISOString();

    let text = "";
    let reasoning = "";
    let sessionId = options.sessionId ?? null;
    let model = options.model ?? null;
    let durationMs = 0;
    let ok = true;
    let firstTokenAt: number | null = null;
    // On an object rather than a bare `let`: the only writer is the stream
    // callback below, and TypeScript cannot prove that ran, so a captured
    // `let` stays narrowed to `null` at every read after the loop.
    const totals: { usage: AgentUsage | null; costUsd: number | null } = { usage: null, costUsd: null };
    let permissionDenials: unknown[] = [];
    let failure: Error | null = null;

    // The stream reports a tool twice — once running with its name and input,
    // once settled with its output. Keeping the running call here is what lets
    // the second event update a step rather than blank its own name out.
    const calls = new Map<string, ToolCall>();

    const emitCall = (event: Extract<AgentEvent, { type: "tool" }>) => {
      const existing = calls.get(event.id);
      const call: ToolCall = {
        id: event.id,
        name: event.name ?? existing?.name ?? "tool",
        arguments: event.input ?? existing?.arguments ?? {},
        status: event.status,
        ...(event.output !== undefined ? { result: event.output } : existing?.result !== undefined ? { result: existing.result } : {}),
      };
      calls.set(event.id, call);
      callbacks.onToolCall?.(call);
    };

    const response = await GatewayClient.request("/api/agents/run", {
      method: "POST",
      signal: options.signal,
      body: JSON.stringify({
        engine: options.engine,
        prompt: options.prompt,
        cwd: options.cwd ?? "",
        sessionId,
        model: options.model ?? null,
        permission: options.permission,
      }),
    });
    await GatewayClient.expectOk(response);
    if (!response.body) throw new Error("The gateway returned no agent stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const consume = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: AgentEvent;
      try {
        event = JSON.parse(trimmed) as AgentEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case "session":
          sessionId = event.sessionId ?? sessionId;
          model = event.model ?? model;
          break;
        case "token":
          if (firstTokenAt === null) firstTokenAt = performance.now();
          text += event.text;
          callbacks.onToken(event.text);
          break;
        case "reasoning":
          reasoning += event.text;
          break;
        case "tool":
          emitCall(event);
          break;
        case "result":
          ok = event.ok;
          sessionId = event.sessionId ?? sessionId;
          totals.costUsd = event.costUsd;
          durationMs = event.durationMs ?? 0;
          totals.usage = event.usage;
          permissionDenials = event.permissionDenials ?? [];
          // A failed turn's explanation arrives as the result text. Without
          // this, a refusal or a usage limit would render as an empty reply.
          if (!event.ok && event.text && !text) text = event.text;
          break;
        case "error":
          failure = new Error(event.message);
          break;
        case "notice":
          break;
        case "done":
          if (event.reason && !failure && ok && !text) {
            failure = new Error(
              event.stderr?.trim() || `${options.engine} stopped: ${event.reason}.`,
            );
          }
          durationMs = durationMs || event.durationMs;
          sessionId = event.sessionId ?? sessionId;
          break;
        default:
          break;
      }
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

    if (failure) {
      callbacks.onError?.(failure);
      throw failure;
    }

    const wallMs = performance.now() - startedAt;
    const usage = totals.usage;
    const outputTokens = usage?.outputTokens ?? 0;
    // Prompt tokens are everything the model was given: fresh input, tokens read
    // from cache, and tokens written to it. They are billed at different rates,
    // which is the cost figure's business — counting only the fresh ones would
    // describe a much smaller turn than the one that actually ran.
    const promptTokens =
      (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheCreationTokens ?? 0);

    callbacks.onComplete({
      fullText: text,
      costUsd: totals.costUsd ?? 0,
      // An agent that does not report cost is not an agent that cost nothing.
      // Claude Code returns a real figure; Codex bills against the ChatGPT
      // subscription and reports none, so it says so rather than showing $0.00.
      costLabel: totals.costUsd === null ? "cost not reported" : `$${totals.costUsd.toFixed(4)}`,
      // Prompt + output, matching what the local engine counts, so the number
      // under a turn means the same thing whichever engine produced it.
      tokensCount: promptTokens + outputTokens,
      durationSec: (durationMs || wallMs) / 1000,
      engineUsed: options.engine === "claude" ? "Claude Code" : "Codex",
      mode: "auto",
      routeReason: reasoning ? "agent_cli_with_reasoning" : "agent_cli",
      telemetry: {
        requestId: sessionId ?? "agent",
        model: model ?? options.engine,
        startedAt: startedIso,
        completedAt: new Date().toISOString(),
        totalDurationMs: durationMs || wallMs,
        loadDurationMs: 0,
        timeToFirstTokenMs: firstTokenAt === null ? null : Math.round(firstTokenAt - startedAt),
        promptTokens,
        outputTokens,
        promptTokensPerSec: null,
        outputTokensPerSec: outputTokens && durationMs ? outputTokens / (durationMs / 1000) : null,
        source: "agent-cli",
      },
    });

    return { sessionId, ok, costUsd: totals.costUsd, durationMs: durationMs || wallMs, usage, permissionDenials };
  }
}
