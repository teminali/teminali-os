/**
 * Studio adapter for the Frontier engine.
 *
 * This module is the *host* side: it supplies the capabilities the engine may
 * use (running a workspace command, approving one, editing the video timeline)
 * and owns host-specific integrations such as the Teminali Cut editor panel.
 * All model engineering — routing, prompts, streaming, the agent loop — lives
 * in frontierEngine.ts.
 */
import { GatewayError } from "./gatewayClient";
import { AgentCliService } from "./agentCliService";
import { TerminalService } from "./terminalService";
import { FrontierEngine, type EngineCapabilities, type StreamCallbacks, type VideoToolSummary } from "./frontierEngine";
import { executeTool, getToolManifest } from "../video/mcp/toolRegistry";
import type { AgentCommandRequest } from "./agentCommands";
import type { TurnOrigin } from "./voice/types";
import type { ChatMessage, ModelModeId } from "../types";

export type { StreamCallbacks } from "./frontierEngine";
export { FLASH_MODEL, MAX_MODEL } from "./frontierEngine";

export interface StreamRequestOptions {
  mode?: ModelModeId;
  signal?: AbortSignal;
  /**
   * Where the user's words came from. Defaults to "text"; "voice" tells the
   * engine the prompt is a transcript and may have misheard names in it.
   */
  origin?: TurnOrigin;
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
    videoTools: videoToolSummaries(),
    /*
      No transport. The ported editor's Zustand stores live in this renderer,
      so a tool call is a function call — which is why P2 needed no bridge,
      no RPC and no second process. `executeTool` validates against the same
      Zod schemas advertised above and never throws.
    */
    runVideoTool: (tool, args) => executeTool(tool, args, "Teminali Code chat"),
  };
}

/**
 * The editor tool catalogue in the shape the engine's prompt wants.
 *
 * Flattened from the tools' own Zod schemas rather than written out here, so
 * a tool whose arguments change cannot go on being advertised with the old
 * ones — the failure that a hand-maintained list makes invisible.
 */
function videoToolSummaries(): VideoToolSummary[] {
  return getToolManifest().map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    const required = new Set(schema.required ?? []);
    return {
      name: tool.name,
      description: tool.description,
      parameters: Object.keys(schema.properties ?? {}).map((key) => (required.has(key) ? key : `${key}?`)),
    };
  });
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
        /*
          Video prompts used to be intercepted here and answered by one
          hardcoded call to the Cut running as a separate process on port 3888
          — every prompt matching /video|timeline|silence|beat|caption|track/
          got the same silence-split, reported as "completed and verified"
          whatever had been asked for. The editor's stores are in THIS renderer
          now, so the engine gets the real tools instead and the intercept is
          gone. MCPRemoteSyncService still speaks to a remote Cut, which is a
          different thing and still a supported one.
        */
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
          options.origin ?? "text",
        );
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
}

export async function purgeOllamaMemory(): Promise<void> {
  return FrontierEngine.purgeMemory();
}
