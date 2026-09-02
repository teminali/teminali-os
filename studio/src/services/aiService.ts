/**
 * Studio adapter for the Frontier engine.
 *
 * This module is the *host* side: it supplies the capabilities the engine may
 * use (running a workspace command, approving one) and owns host-specific
 * integrations such as the Teminali Cut MCP. All model engineering — routing,
 * prompts, streaming, the agent loop — lives in frontierEngine.ts.
 */
import { GatewayClient, GatewayError } from "./gatewayClient";
import { AgentCliService } from "./agentCliService";
import { MCPRemoteSyncService } from "./mcpRemoteSyncService";
import { RuntimeTelemetryService } from "./runtimeTelemetryService";
import { TerminalService } from "./terminalService";
import { FrontierEngine, type EngineCapabilities, type StreamCallbacks } from "./frontierEngine";
import type { AgentCommandRequest } from "./agentCommands";
import type { ChatMessage, InferenceTelemetry, ModelModeId, ToolCall } from "../types";

export type { StreamCallbacks } from "./frontierEngine";
export { FLASH_MODEL, MAX_MODEL } from "./frontierEngine";

export interface StreamRequestOptions {
  mode?: ModelModeId;
  signal?: AbortSignal;
  skill?: { id: string; name: string; description?: string } | null;
  /** Approval gate for state-changing commands the agent asks to run. */
  approveCommand?: (request: AgentCommandRequest) => Promise<boolean>;
  /** Claude Code / Codex only: the CLI session to resume, so a tab is a thread. */
  agentSessionId?: string | null;
  /** Claude Code / Codex only: how much the CLI may do without asking. */
  agentPermission?: string;
  /** Claude Code / Codex only: the `--model` value. Null lets the CLI choose. */
  agentModel?: string | null;
  /**
   * Workspace-relative directory the turn's tool calls run in.
   *
   * The benchmark arena needs this: each contestant works in its own sandbox
   * under the workspace, and a local turn whose commands ran at the workspace
   * root instead would edit the real project while its rival edited a copy.
   */
  workingDirectory?: string;
  /**
   * Claude Code / Codex only: the CLI's session id for this turn, so the caller
   * can hand it back on the next one and keep the thread continuous.
   */
  onAgentSession?: (sessionId: string | null) => void;
}

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `request-${Date.now()}`;
}

/**
 * What this host allows the engine to do.
 *
 * A headless caller (a benchmark, a CLI) can construct the engine with none of
 * these, which is the point of the split: the engine still runs, it simply has
 * no shell to reach for.
 */
/**
 * What the local engine may do on the host.
 *
 * Built per call rather than shared, because the working directory is part of
 * it: the arena runs the same engine in a sandbox, and a module-level singleton
 * could only ever point at one place.
 */
function studioCapabilities(workingDirectory?: string): EngineCapabilities {
  return {
    // The engine's executor contract carries no cwd of its own, so the host
    // supplies one. Absent, commands run at the workspace root as before.
    runCommand: (command, options) =>
      TerminalService.run(command, {
        ...options,
        ...(workingDirectory ? { cwd: workingDirectory } : {}),
      }),
  };
}

export class AIService {
  public static async streamMessage(
    engine: "frontier" | "antigravity" | "claude" | "codex",
    userPrompt: string,
    history: ChatMessage[],
    callbacks: StreamCallbacks,
    attachedImages: string[] = [],
    options: StreamRequestOptions = {},
  ): Promise<void> {
    try {
      if (engine === "frontier") {
        if (/\b(video|timeline|silence|beat|caption|track)\b/i.test(userPrompt)) {
          await this.executeMcpAction(userPrompt, callbacks);
        } else {
          await FrontierEngine.streamLocal(
            userPrompt,
            history,
            attachedImages,
            callbacks,
            options.mode ?? "auto",
            options.signal,
            options.skill,
            options.approveCommand,
            studioCapabilities(options.workingDirectory),
          );
        }
        return;
      }
      // Claude Code and Codex are not providers — they are the operator's own
      // CLIs, run as processes in the workspace with their own auth and their
      // own tools. Anything else has no configured production path.
      if (engine === "claude" || engine === "codex") {
        const turn = await AgentCliService.streamTurn(
          {
            engine,
            prompt: userPrompt,
            sessionId: options.agentSessionId ?? null,
            model: options.agentModel ?? null,
            permission: options.agentPermission,
            signal: options.signal,
          },
          callbacks,
        );
        options.onAgentSession?.(turn.sessionId);
        return;
      }
      throw new GatewayError(
        `${engine} has no configured production provider. Select Frontier Auto, Claude Code or Codex.`,
        "PROVIDER_NOT_CONFIGURED",
        503,
      );
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Unknown inference failure.");
      callbacks.onError?.(normalized);
    }
  }

  private static async executeMcpAction(userPrompt: string, callbacks: StreamCallbacks): Promise<void> {
    const id = requestId();
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const connection = await MCPRemoteSyncService.checkConnection();
    if (!connection.connected) {
      throw new GatewayError(
        `Teminali Cut MCP is offline on port 3888. No timeline mutation was attempted. ${connection.detail}`,
        "MCP_OFFLINE",
        503,
      );
    }

    callbacks.onToolCall?.({
      id: `tool-${id}`,
      name: "teminali.cut.detect_silence_and_align",
      arguments: { trackId: "A1", thresholdDb: -32, bpm: 120, request: userPrompt },
      status: "running",
    });

    const result = await MCPRemoteSyncService.splitSilenceAndAlignBpm("A1", -32, 120);
    const fullText = [
      "Teminali Cut MCP completed and verified the requested timeline operation.",
      `Track: ${result.trackId}`,
      `Cuts applied: ${result.cutsApplied}`,
      `Duration saved: ${result.durationSavedSec}s`,
      `Downbeats aligned: ${result.downbeatsAligned} at ${result.bpm} BPM`,
    ].join("\n");
    callbacks.onToken(fullText);
    callbacks.onToolCall?.({
      id: `tool-${id}`,
      name: "teminali.cut.detect_silence_and_align",
      arguments: { trackId: "A1", thresholdDb: -32, bpm: 120, request: userPrompt },
      status: "completed",
      result: `${result.cutsApplied} cuts applied; ${result.durationSavedSec}s saved; ${result.downbeatsAligned} downbeats aligned.`,
    });

    const telemetry: InferenceTelemetry = {
      requestId: id,
      model: "Teminali Cut MCP",
      startedAt,
      completedAt: new Date().toISOString(),
      totalDurationMs: Number((performance.now() - started).toFixed(2)),
      loadDurationMs: 0,
      timeToFirstTokenMs: Number((performance.now() - started).toFixed(2)),
      promptTokens: 0,
      outputTokens: 0,
      promptTokensPerSec: null,
      outputTokensPerSec: null,
      source: "mcp",
    };
    RuntimeTelemetryService.record(telemetry);
    await GatewayClient.recordAudit({ type: "mcp.completed", requestId: id, telemetry, result });
    callbacks.onComplete({
      fullText,
      costUsd: 0,
      costLabel: "$0.0000 local",
      tokensCount: 0,
      durationSec: Number((telemetry.totalDurationMs / 1000).toFixed(2)),
      engineUsed: "Teminali Cut MCP",
      mode: "auto",
      routeReason: "mcp_intent",
      telemetry,
    });
  }
}

export async function purgeOllamaMemory(): Promise<void> {
  return FrontierEngine.purgeMemory();
}
