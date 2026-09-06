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
import { AgentCliService, type AgentStreamCallbacks, type PermissionRequest } from "./agentCliService";
import { TerminalService } from "./terminalService";
import { FrontierEngine, type EngineCapabilities, type StreamCallbacks, type VideoToolSummary } from "./frontierEngine";
import { executeTool, getToolManifest } from "../video/mcp/toolRegistry";
import { dispatchPlayerCommand, type PlayerCommand, type PlayerSnapshot } from "./playerControl";
import { describeLivePlayer, LOCAL_PLAYER_ACTIONS, PLAYER_READ_ACTION } from "./playerToolCalls";
import type { AskExecutor } from "./askToolCalls";
import { usePlayerStore } from "../store/playerStore";
import type { AgentCommandRequest } from "./agentCommands";
import type { TurnOrigin } from "./voice/types";
import type { ChatMessage, ModelModeId } from "../types";

export type { StreamCallbacks } from "./frontierEngine";
export { FLASH_MODEL, MAX_MODEL } from "./frontierEngine";

/**
 * A CLI permission request, as one line an operator can judge.
 *
 * The approval gate is keyed on the head of this string, so the tool name has
 * to lead: "always allow" must mean the tool, not the particular path it was
 * pointed at this time. `key` is what the gateway itself would remember —
 * `Bash(open)` rather than all of `Bash` — so it is preferred when present.
 */
function describePermission(request: PermissionRequest): string {
  const command = typeof request.input?.command === "string" ? request.input.command : null;
  const path = typeof request.input?.path === "string" ? request.input.path : null;
  const detail = command ?? path;
  const head = request.key || request.toolName;
  return detail ? `${head}: ${detail}` : head;
}

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
  /**
   * Local lane only: puts the agent's question to the operator and resolves
   * with what they chose. Absent, the lane is never told the fence exists —
   * a host with no picker on screen must not advertise one.
   */
  askOperator?: AskExecutor;
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
  /**
   * Claude Code / Codex only: the agent moving the workspace around the chat.
   *
   * Without these two the CLI's workspace tools are wired on the gateway side
   * and dead on this one. `reveal` and `open_project` reach the renderer as
   * events, and an event nobody subscribes to is a tool that silently does
   * nothing — which is worse than an absent tool, because the model is told it
   * worked. It then goes looking for another way to do what it was asked, and
   * the only other way it has is driving the app's own UI by pointer: eleven
   * steps and two click approvals to open a project, ending in "I can't tell
   * whether that switched the workspace".
   *
   * `AgentPane` subscribed from the start. The chat did not, and the tools are
   * the same tools.
   */
  onWorkspace?: AgentStreamCallbacks["onWorkspace"];
  /** Claude Code / Codex only: a file the agent wrote, for the review dock. */
  onEdit?: AgentStreamCallbacks["onEdit"];
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
function studioCapabilities(workingDirectory?: string, askOperator?: AskExecutor): EngineCapabilities {
  return {
    // Only present when the host mounted a picker; the engine gates the prompt
    // block on it, so a headless caller never learns the fence exists.
    ...(askOperator ? { askOperator } : {}),
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
    runVideoTool: (tool, args) => executeTool(tool, args, "Teminali OS chat"),
    /*
      The built-in player, on the same terms as the editor tools: no transport,
      because the pane that owns the `<video>` is in this renderer and listening
      on `subscribePlayerCommands`. The agent CLI lane reaches the same pane the
      long way round — gateway route, run stream, `dispatchPlayerCommand` — and
      lands on the identical listener, so both lanes drive one player.
    */
    playerActions: LOCAL_PLAYER_ACTIONS,
    playerState: () => describeLivePlayer(usePlayerStore.getState().live),
    runPlayer: async (command) => {
      // The read never reaches a pane. Dispatching it would ask the player to
      // perform "status", which no pane implements, and the honest answer is
      // already in the store.
      if (command.action === PLAYER_READ_ACTION) {
        return { delivered: true, snapshot: usePlayerStore.getState().live };
      }
      // Narrowed by the return above: everything past it is one of the pane's
      // own actions, which is what `PlayerCommand` means.
      const delivered = dispatchPlayerCommand(command as PlayerCommand);
      if (!delivered) {
        return {
          delivered: false,
          snapshot: null,
          error: "No player is mounted, so nothing took the command — the operator has no media open. "
            + "Say so plainly; do not look for the file on the Teminali Cut timeline.",
        };
      }
      return { delivered: true, snapshot: await settledPlayerState() };
    },
  };
}

/**
 * The player's state once it has actually moved.
 *
 * `play()` resolves before the element is playing and the pane republishes on
 * the media event, not the call, so reading the store straight after a dispatch
 * reports the state the command was meant to change. Waiting for the next
 * publish — and giving up quickly if none comes, as `pause` on an already
 * paused file produces none — is what makes the sentence the model reads next
 * true rather than one tick stale.
 */
const PLAYER_SETTLE_MS = 600;

function settledPlayerState(): Promise<PlayerSnapshot | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(usePlayerStore.getState().live);
    };
    const unsubscribe = usePlayerStore.subscribe((state, previous) => {
      if (state.live !== previous.live) finish();
    });
    const timer = setTimeout(finish, PLAYER_SETTLE_MS);
  });
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
          studioCapabilities(options.workingDirectory, options.askOperator),
          options.origin ?? "text",
        );
        return;
      }
      // Claude Code and Codex are not providers — they are the operator's own
      // CLIs, run as processes in the workspace with their own auth and their
      // own tools. Anything else has no configured production path.
      if (engine === "claude" || engine === "codex") {
        /*
         * Put the CLI's permission prompts in front of the operator.
         *
         * The gateway emits a `permission` event and then blocks the agent
         * inside its own tool call until an answer is posted, auto-denying
         * after APPROVAL_TIMEOUT_MS (5 minutes). Only AgentPane ever
         * subscribed, so a turn started from chat asked a question nobody
         * could see and then sat there for the full five minutes — measured:
         * a `cd` outside the workspace stalled a turn for 4m41s before the
         * timeout denied it and the model narrated "the listing needed
         * approval and timed out".
         *
         * The chat already owns an approval gate for the in-app agent, and it
         * already renders whatever is pending, so the CLI's request is asked
         * through that same gate rather than growing a second surface. With no
         * gate wired the request is denied at once: refusing in a second is a
         * far better answer than refusing in five minutes.
         */
        const turn = await AgentCliService.streamTurn(
          {
            engine,
            prompt: userPrompt,
            sessionId: options.agentSessionId ?? null,
            model: options.agentModel ?? null,
            permission: options.agentPermission,
            signal: options.signal,
          },
          {
            ...callbacks,
            onPermission: (request) => {
              void (async () => {
                const approve = options.approveCommand;
                const approved = approve
                  ? await approve({
                      command: describePermission(request),
                      risk: "confirm",
                      reason: `${engine === "claude" ? "Claude Code" : "Codex"} is asking to use ${request.toolName}.`,
                    })
                  : false;
                await AgentCliService.answerPermission({
                  runId: request.runId,
                  id: request.id,
                  behavior: approved ? "allow" : "deny",
                  // The gate's own "remember" already suppresses the next
                  // identical ask on this side, so the answer posted to the
                  // gateway stays a single decision about a single request.
                  remember: false,
                });
              })();
            },
            onWorkspace: options.onWorkspace,
            onEdit: options.onEdit,
          },
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
