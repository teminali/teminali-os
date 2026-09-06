// Player tool-call protocol and runner.
//
// The third sibling of agentCommands.ts and videoToolCalls.ts, shaped like
// both: parse an explicit fence, execute through an injected capability, hand
// the model back what actually happened.
//
// It exists because of a real failure. Asked to play a file that was open in
// the viewer, the local lane reached for `video-tool` — the only video-shaped
// tool it had — read back the Teminali Cut *timeline*, and told the operator
// there was no such file in their project while the file sat playing in the
// next pane. A model given no tool for a thing does not decline; it grabs the
// nearest-sounding one and reports the wrong answer with confidence. So the
// prompt this file feeds says twice, in two places, that the timeline and the
// viewer are different surfaces.
//
// No approval gate, for the same reason `player_control` is pre-approved on
// the agent CLI lane (see WORKSPACE_READ_TOOLS in server/workspace-mcp.js):
// every action here acts on a file the operator opened, in a pane they are
// looking at, and writes nothing. A prompt before every pause would make the
// tool not worth calling.
import type { ToolCall } from "../types";
import { PLAYER_ACTIONS, type PlayerAction, type PlayerSnapshot } from "./playerControl.ts";

/**
 * Only an explicit opt-in fence is executed, for the same reason the shell and
 * editor runners insist on one: a model routinely prints example JSON as
 * documentation, and treating that as an instruction would seek the operator's
 * video because a sentence explained how seeking works.
 */
const PLAYER_FENCE = /```player-tool[^\n]*\n([\s\S]*?)(?:```|$)/g;

/**
 * What a local model writes when it has half-remembered the fence name. The
 * editor runner carries the same list for the same reason: a 7B model that has
 * understood the protocol and mistyped the tag has earned its call.
 */
const FALLBACK_FENCE = /```(?:player_tool|playertool|player-control|player_control|player)[^\n]*\n([\s\S]*?)(?:```|$)/g;

/**
 * Reading the player is an action here, and it is not in `PLAYER_ACTIONS`.
 *
 * The agent CLI lane has two tools — `player` reads, `player_control` acts —
 * and one fence has no room for that split. A model given only verbs asks for
 * `{"action":"status"}`, is refused, apologises, and asks again; six times, in
 * front of the operator, before it says anything. `status` reads the snapshot
 * and changes nothing.
 */
export const PLAYER_READ_ACTION = "status";
const READ_ALIASES = new Set(["status", "state", "current", "describe", "get_state", "player"]);

/** Every action this fence accepts: the gateway's verbs, plus the read. */
export const LOCAL_PLAYER_ACTIONS = [PLAYER_READ_ACTION, ...PLAYER_ACTIONS] as const;

export type LocalPlayerAction = PlayerAction | typeof PLAYER_READ_ACTION;

export interface LocalPlayerCommand {
  action: LocalPlayerAction;
  value?: number | string | boolean;
}

/** Actions whose `value` is required, and what it has to be. */
const VALUE_RULES: Partial<Record<PlayerAction, "number" | "string" | "boolean">> = {
  seek: "number",
  seek_by: "number",
  volume: "number",
  rate: "number",
  episode: "number",
  subtitles: "string",
  fullscreen: "boolean",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** One parsed command, or the sentence explaining why it is not one. */
export interface PlayerToolRequest {
  command: LocalPlayerCommand;
}

export interface PlayerToolRejection {
  raw: unknown;
  reason: string;
}

/**
 * Checks one object from a fence.
 *
 * A rejection is returned rather than thrown, and carries a sentence the model
 * can act on — `parsePlayerCommand` in server/player-state.js makes the same
 * choice for the same reason: "bad request" tells a model nothing, so it
 * retries the identical call.
 */
export function checkPlayerCommand(raw: unknown): PlayerToolRequest | PlayerToolRejection {
  if (!isRecord(raw)) return { raw, reason: "a player command must be a JSON object" };
  // `{"tool":"player","arguments":{...}}` is the editor fence's shape, and a
  // model that has just used that one writes it here out of habit. Unwrap it
  // rather than refusing: the intent is unambiguous.
  const body = isRecord(raw.arguments) ? { ...raw.arguments, ...(raw.action ? { action: raw.action } : {}) } : raw;
  const wanted = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  // A model that wants to look writes any of half a dozen words. They all mean
  // the same thing here, and refusing five of them buys nothing but a retry.
  const action = READ_ALIASES.has(wanted) ? PLAYER_READ_ACTION : wanted;
  if (!action) return { raw, reason: `no "action" — one of: ${LOCAL_PLAYER_ACTIONS.join(", ")}` };
  if (!(LOCAL_PLAYER_ACTIONS as readonly string[]).includes(action)) {
    return { raw, reason: `"${wanted}" is not a player action. Use one of: ${LOCAL_PLAYER_ACTIONS.join(", ")}` };
  }
  const rule = VALUE_RULES[action as PlayerAction];
  if (!rule) return { command: { action: action as LocalPlayerAction } };

  let value = body.value;
  // A local model writes `"value": "30"` about as often as it writes 30, and
  // refusing that is pedantry the operator pays for in another round trip.
  if (rule === "number" && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    value = Number(value);
  }
  if (rule === "boolean" && (value === "true" || value === "false")) value = value === "true";

  if (rule === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { raw, reason: `"${action}" needs a numeric "value" (seconds for seek, 0–1 for volume, a multiplier for rate)` };
    }
  } else if (rule === "string") {
    if (typeof value !== "string" || !value.trim()) {
      return { raw, reason: `"${action}" needs a "value" — a subtitle label, or "off"` };
    }
  } else if (rule === "boolean") {
    if (typeof value !== "boolean") return { raw, reason: `"${action}" needs a boolean "value"` };
  }
  return { command: { action: action as LocalPlayerAction, value: value as number | string | boolean } };
}

function toRequests(body: string): (PlayerToolRequest | PlayerToolRejection)[] {
  const parsed = tryParse(body);
  if (parsed === null) return [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map(checkPlayerCommand);
}

function collect(text: string, pattern: RegExp): (PlayerToolRequest | PlayerToolRejection)[] {
  const out: (PlayerToolRequest | PlayerToolRejection)[] = [];
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(text)) !== null) out.push(...toRequests(match[1] ?? ""));
  return out;
}

export function parsePlayerToolCalls(text: string): (PlayerToolRequest | PlayerToolRejection)[] {
  return collect(text, PLAYER_FENCE);
}

export function parseFallbackPlayerToolCalls(text: string): (PlayerToolRequest | PlayerToolRejection)[] {
  return collect(text, FALLBACK_FENCE);
}

export function hasPlayerToolCalls(text: string): boolean {
  PLAYER_FENCE.lastIndex = 0;
  return PLAYER_FENCE.test(text);
}

export function isRejection(item: PlayerToolRequest | PlayerToolRejection): item is PlayerToolRejection {
  return "reason" in item;
}

export interface PlayerToolExecution {
  command: LocalPlayerCommand | null;
  ok: boolean;
  /** What the player was showing after the command, in a sentence. */
  note: string;
  error?: string;
  durationMs: number;
}

/**
 * Runs one command against whatever pane holds the player, and reports the
 * state it left behind.
 *
 * Injected, so this runner needs no store import and stays testable — the same
 * contract the editor runner has with `executeTool`.
 */
export type PlayerExecutor = (
  command: LocalPlayerCommand,
) => Promise<{ delivered: boolean; snapshot: PlayerSnapshot | null; error?: string }>;

export interface RunPlayerToolCallsOptions {
  execute: PlayerExecutor;
  signal?: AbortSignal;
  onToolCall?: (toolCall: ToolCall) => void;
  maxCalls?: number;
}

/**
 * Six is the editor runner's cap and it fits here too: the longest honest
 * chain is something like episode → play → subtitles → rate, and a model
 * emitting more than six playback commands in one turn has lost the thread.
 */
const DEFAULT_MAX_CALLS = 6;

/**
 * Renders a snapshot as the sentence the model reads next.
 *
 * `describePlayer` in server/player-state.js says the same thing to the agent
 * CLI lane. The two are deliberately not shared: that one addresses a remote
 * agent about "the operator's editor", this one addresses a model running
 * inside the window the player is in. `tests/player-tool-calls.test.mjs` pins
 * the part that must not drift — the action list both sides accept.
 */
export function describeLivePlayer(snapshot: PlayerSnapshot | null): string {
  if (!snapshot) return "Nothing is open in the built-in player right now.";
  if (snapshot.view === "episodes" && snapshot.series) {
    return `The gallery for "${snapshot.series.title}" is showing — ${snapshot.series.count} items, nothing playing yet. `
      + `Use action "episode" with a number to start one.`;
  }
  const what = snapshot.series && snapshot.series.index
    ? `episode ${snapshot.series.index} of ${snapshot.series.count} in "${snapshot.series.title}"`
    : `"${snapshot.title ?? snapshot.path ?? "a file"}"`;
  const state = snapshot.error
    ? `cannot play (${snapshot.error})`
    : snapshot.ended ? "finished" : snapshot.playing ? "playing" : "paused";
  const bits = [
    snapshot.subtitles.active ? `subtitles ${snapshot.subtitles.active}` : "",
    snapshot.muted ? "muted" : "",
    snapshot.rate !== 1 ? `${snapshot.rate}×` : "",
    snapshot.fullscreen ? "fullscreen" : "",
  ].filter(Boolean);
  return `The player is showing ${what}: ${state} at ${clock(snapshot.time)} of ${clock(snapshot.duration)}`
    + `${bits.length > 0 ? ` (${bits.join(", ")})` : ""}.`;
}

function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "an unknown length";
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

export async function executePlayerRequests(
  items: (PlayerToolRequest | PlayerToolRejection)[],
  options: RunPlayerToolCallsOptions,
): Promise<PlayerToolExecution[]> {
  const executions: PlayerToolExecution[] = [];
  const limit = options.maxCalls ?? DEFAULT_MAX_CALLS;
  for (const item of items.slice(0, limit)) {
    if (options.signal?.aborted) break;
    if (isRejection(item)) {
      // A refusal is still evidence: the model has to see why the call did not
      // land, or it emits the same malformed fence again.
      executions.push({ command: null, ok: false, note: "", error: item.reason, durationMs: 0 });
      continue;
    }
    const started = Date.now();
    const id = `tool-player-${started}-${executions.length}`;
    const call: ToolCall = {
      id,
      name: `player.${item.command.action}`,
      arguments: { ...item.command },
      status: "running",
    };
    options.onToolCall?.(call);
    try {
      const result = await options.execute(item.command);
      const durationMs = Date.now() - started;
      const ok = result.delivered && !result.error;
      const note = ok
        ? describeLivePlayer(result.snapshot)
        : result.error ?? "No player is mounted, so nothing took the command. The operator has no media open.";
      executions.push({ command: item.command, ok, note: ok ? note : "", error: ok ? undefined : note, durationMs });
      options.onToolCall?.({ ...call, status: ok ? "completed" : "error", result: note });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      executions.push({ command: item.command, ok: false, note: "", error: message, durationMs: Date.now() - started });
      options.onToolCall?.({ ...call, status: "error", result: message });
    }
  }
  return executions;
}

export async function runPlayerToolCalls(
  text: string,
  options: RunPlayerToolCallsOptions,
): Promise<PlayerToolExecution[]> {
  return executePlayerRequests(parsePlayerToolCalls(text), options);
}

/** Builds the observation the model reads on its next turn. */
export function buildPlayerToolEvidence(executions: PlayerToolExecution[]): string {
  if (executions.length === 0) return "";
  const blocks = executions.map((execution) => {
    const call = execution.command ? `player(${JSON.stringify(execution.command)})` : "player(malformed)";
    return execution.ok ? `> ${call}\n# done — ${execution.note}` : `> ${call}\n# failed — ${execution.error}`;
  });
  return [
    "Built-in player results. This is the real state of the pane the user is watching — "
      + "the only evidence of what is open and whether the command landed. It is not the "
      + "Teminali Cut timeline, and `describe_timeline` cannot see it.",
    ...blocks,
  ].join("\n\n");
}
