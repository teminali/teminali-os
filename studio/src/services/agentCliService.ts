import { GatewayClient } from "./gatewayClient";
import { answerCameraRequest } from "./cameraFrame";
import { answerPlayerFrameRequest } from "./playerFrame";
import { answerBrowserRequest } from "./browserAgent";
import type { BrowserCdpOp, BrowserCdpParams } from "./browserView";
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
  /**
   * How hard this CLI can be told to work, weakest first, in its own
   * vocabulary — the two do not share one. Null default means "say nothing and
   * let the operator's own CLI config stand". Read from the gateway rather
   * than hard-coded here so the picker can never offer a level the installed
   * binary would reject. See server/agent-cli.js `AGENTS`.
   */
  efforts: string[];
  defaultEffort: string | null;
  /** How much reasoning comes back on the stream. Empty when the CLI has no
   *  such knob — Claude Code's effort level is its thinking budget. */
  thinking: string[];
  defaultThinking: string | null;
}

/** One thing the agent will or will not have in its hands on the next turn. */
export interface AgentCapability {
  id: string;
  /** The MCP server that carries it, as the CLI will see it named. */
  server: string;
  label: string;
  detail: string;
  tools: string[];
  available: boolean;
  /** Why not, in words that name the thing to change. Null when available. */
  reason: string | null;
}

/** An MCP server the CLI carries of its own, read from the CLI, never guessed. */
export interface AgentMcpServer {
  name: string;
  transport: string;
  /** The CLI's own word for its health, e.g. "Connected". Null when it says nothing. */
  status: string | null;
  enabled: boolean;
}

export interface AgentPlugin {
  name: string;
  version: string | null;
  enabled: boolean;
  /** How many MCP servers this plugin brings with it. */
  servers: number;
}

/**
 * What an agent brings into a turn.
 *
 * `mcp` and `plugins` are null when the CLI could not be read — a missing
 * binary, a hang, an unrecognised shape. Null and empty mean different things
 * here and the UI must not collapse them: an empty array is the CLI saying
 * "none", null is us saying "we do not know".
 */
export interface AgentInventory {
  engine: AgentEngine;
  label: string;
  studio: AgentCapability[];
  mcp: AgentMcpServer[] | null;
  plugins: AgentPlugin[] | null;
  /** Surfaces this inventory knowingly does not cover. */
  unlisted: string[];
}

export interface AgentTurnOptions {
  engine: AgentEngine;
  prompt: string;
  /** Workspace-relative. Empty means the workspace root. */
  cwd?: string;
  /**
   * Attached images, as base64 data URLs.
   *
   * Neither CLI can be handed bytes: the prompt is argv. The gateway writes
   * these to disk inside the agent's own working directory and then either
   * passes the files to `codex exec --image=` or names their paths to Claude
   * Code, which reads them with its Read tool. See server/agent-attachments.js.
   */
  images?: string[];
  /** Resume the CLI's own session. Null starts a fresh one. */
  sessionId?: string | null;
  /**
   * Branch `sessionId` instead of continuing it: the CLI answers from that
   * thread's history and writes the answer to a new id, leaving the thread it
   * read alone. Ignored without a `sessionId` — there is nothing to branch.
   */
  fork?: boolean;
  model?: string | null;
  permission?: string;
  /** One of the engine's own `efforts`. Null leaves the CLI's setting alone. */
  effort?: string | null;
  /** One of the engine's own `thinking` values, where it has any. */
  thinking?: string | null;
  signal?: AbortSignal;
  /** Run through Frontier Max online Gemini tier via Claude Code */
  frontierMax?: boolean;
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
  /* A tool call is waiting on the operator. The turn is not stalled by choice:
     the agent is blocked inside its own tool call until an answer is posted
     back to /api/agents/permission/resolve. */
  | { type: "permission"; id: string; toolName: string; input: Record<string, unknown>; key: string; expiresInMs: number }
  | { type: "permission-resolved"; id: string; behavior: "allow" | "deny" }
  /* The agent driving the editor it is running inside: a folder revealed in
     the file tree, a file opened into the file panel, a page shown in the
     browser panel, or the whole workspace switched to another project. The run's own stream is the only channel back
     to this window during a turn — see `emitToRun` in
     server/permission-bridge.js. */
  /* One file the agent wrote, with both sides of it, so the review dock can
     offer accept/reject for an agent turn the way it already does for the
     built-in chat. Assembled on the server beside the CLI's stdout — see
     server/agent-edits.js for why the "before" is read there and not here. */
  | { type: "edit"; path: string; before: string; after: string; existedBefore: boolean; size: number | null; modified: string | null }
  | { type: "workspace"; action: "reveal"; path: string }
  | { type: "workspace"; action: "open-file"; path: string }
  | { type: "workspace"; action: "open-folder"; path: string }
  | { type: "workspace"; action: "player"; command: { action: string; value?: number | string | boolean } }
  | { type: "workspace"; action: "open-project"; path: string; name: string; kind?: "video" | "code" }
  | { type: "workspace"; action: "browse"; url: string; newTab: boolean }
  /* The agent asking to look through the camera. Answered here rather than
     bubbled to a pane: there is no decision left to make by the time it
     arrives — the operator has already approved the tool call — and a frame is
     a frame whichever surface started the turn. See services/cameraFrame.ts. */
  | { type: "camera"; id: string; frames?: number; spanMs?: number; expiresInMs: number }
  /* The agent reading or driving the browser panel. Answered here for the same
     reason the camera is — the decision was made when the tool call was
     approved, and the panel is a view only this renderer can reach. The op is
     a name, never a CDP method. See services/browserAgent.ts. */
  | { type: "browser"; id: string; op: BrowserCdpOp; params?: BrowserCdpParams; expiresInMs: number }
  /* The agent asking to look at the video the operator is playing. Answered
     here for the same reason as both of the above, and the picture is the
     pane's own element — see services/playerFrame.ts. */
  | { type: "player-frame"; id: string; expiresInMs: number }
  // Recorded by the gateway into the plan store, not consumed here — the pane
  // shows a turn, and plan headroom outlives any one turn. Listed so the switch
  // below is exhaustive over what the stream can actually carry.
  | { type: "limits"; status: string | null; isUsingOverage: boolean; windows: { id: string; utilization: number; resetsAt: number | null }[] }
  | { type: "done"; sessionId: string | null; durationMs: number; truncated: boolean; reason: string | null; stderr: string };

/** A tool call the agent is blocked on, waiting for the operator. */
export interface PermissionRequest {
  runId: string;
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  /** What "always allow" would cover — `Bash(open)` rather than all of `Bash`. */
  key: string;
  expiresInMs: number;
}

/**
 * The agent stream carries two things the local engine's does not: a request
 * for approval, and the news that one was answered (by a timeout, or from
 * another window). Kept beside `StreamCallbacks` rather than added to it, so
 * the local engine's contract stays what it was.
 */
export type AgentStreamCallbacks = StreamCallbacks & {
  onPermission?: (request: PermissionRequest) => void;
  onPermissionResolved?: (id: string) => void;
  onWorkspace?: (event: Extract<AgentEvent, { type: "workspace" }>) => void;
  onEdit?: (event: Extract<AgentEvent, { type: "edit" }>) => void;
};

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

  /**
   * What this agent brings into a turn: the tools Teminali OS attaches, plus
   * the MCP servers and plugins the CLI carries of its own.
   *
   * Null on any failure, which the caller renders as "could not be read"
   * rather than as an agent with nothing.
   */
  public static async inventory(engine: AgentEngine, signal?: AbortSignal): Promise<AgentInventory | null> {
    try {
      const response = await GatewayClient.request(`/api/agents/inventory?engine=${encodeURIComponent(engine)}`, {
        method: "GET",
        signal,
      });
      if (!response.ok) return null;
      return (await response.json()) as AgentInventory;
    } catch {
      return null;
    }
  }

  /** Answer one approval request. Resolves false when it was already settled. */
  public static async answerPermission(
    request: { runId: string; id: string; behavior: "allow" | "deny"; remember?: boolean; message?: string },
  ): Promise<boolean> {
    try {
      const response = await GatewayClient.request("/api/agents/permission/resolve", {
        method: "POST",
        body: JSON.stringify(request),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  public static async streamTurn(
    options: AgentTurnOptions,
    callbacks: AgentStreamCallbacks,
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
        images: options.images ?? [],
        sessionId,
        fork: options.fork ?? false,
        model: options.model ?? null,
        permission: options.permission,
        effort: options.effort ?? null,
        thinking: options.thinking ?? null,
        frontierMax: options.frontierMax ?? false,
      }),
    });
    await GatewayClient.expectOk(response);
    if (!response.body) throw new Error("The gateway returned no agent stream.");
    // The gateway names every request on the way out and uses the same id as
    // the run id, so an approval can be addressed without a second round trip.
    const runId = response.headers.get("x-correlation-id") ?? "";

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // `done` is the gateway's last word on a turn. The loop below stops on it
    // rather than on the socket closing, so a response the gateway holds open
    // past that point — or never gets to end — cannot leave the turn spinning.
    let finished = false;

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
        case "permission":
          callbacks.onPermission?.({
            runId,
            id: event.id,
            toolName: event.toolName,
            input: event.input,
            key: event.key,
            expiresInMs: event.expiresInMs,
          });
          break;
        case "permission-resolved":
          callbacks.onPermissionResolved?.(event.id);
          break;
        case "workspace":
          callbacks.onWorkspace?.(event);
          break;
        case "camera":
          // Deliberately not awaited: the stream must keep being read while
          // the camera warms up, or the turn's own output stalls behind it.
          void answerCameraRequest(runId, event.id, { frames: event.frames, spanMs: event.spanMs });
          break;
        case "browser":
          // Not awaited, for the same reason: a page snapshot is a round trip
          // through main and back, and the turn's own output would stall
          // behind it.
          void answerBrowserRequest(runId, event.id, event.op, event.params ?? {});
          break;
        case "player-frame":
          // Not awaited, for the same reason: encoding a frame and posting it
          // is a round trip the turn's own output must not queue behind.
          void answerPlayerFrameRequest(runId, event.id);
          break;
        case "edit":
          callbacks.onEdit?.(event);
          break;
        case "notice":
        case "limits":
          break;
        case "done":
          if (event.reason && !failure && ok && !text) {
            failure = new Error(
              event.stderr?.trim() || `${options.engine} stopped: ${event.reason}.`,
            );
          }
          durationMs = durationMs || event.durationMs;
          sessionId = event.sessionId ?? sessionId;
          finished = true;
          break;
        default:
          break;
      }
    };

    try {
      for (;;) {
        if (finished) {
          void reader.cancel().catch(() => {});
          break;
        }
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
      if (!finished && buffer.trim()) consume(buffer);
    } finally {
      reader.releaseLock();
    }

    if (failure) {
      callbacks.onError?.(failure);
      throw failure;
    }

    const actionMatch = text.match(/<workspace-action\s+action=["']([^"']+)["']\s+path=["']([^"']+)["']\s*\/?>/i);
    if (actionMatch) {
      const [, action, targetPath] = actionMatch;
      callbacks.onWorkspace?.({
        type: "workspace",
        action: action as any,
        path: targetPath,
      });
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
      engineUsed: options.frontierMax ? "Frontier Max (Gemini)" : options.engine === "claude" ? "Claude Code" : "Codex",
      mode: options.frontierMax ? "max" : "auto",
      routeReason: options.frontierMax ? "frontier_max_gemini" : (reasoning ? "agent_cli_with_reasoning" : "agent_cli"),
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
