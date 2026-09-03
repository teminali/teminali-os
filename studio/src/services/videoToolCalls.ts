// Video tool-call protocol and runner.
//
// The shell counterpart of this file is agentCommands.ts, and the two are
// deliberately shaped alike: parse an explicit fence, execute through an
// injected capability, and hand the model back what actually happened.
//
// There is no approval gate here, unlike the shell path. A shell command can
// delete a file; these three tools write to two in-memory Zustand stores that
// nothing persists to disk, every call lands as exactly ONE entry on the
// editor's undo stack, and the panel the stores drive is on screen while it
// happens. Import and export are the tools that will need a gate — they touch
// the filesystem — and they are not ported yet.
import type { ToolCall } from "../types";

export interface VideoToolRequest {
  tool: string;
  arguments: Record<string, unknown>;
}

/**
 * Only an explicit opt-in fence is executed, for the same reason the shell
 * runner insists on one: a model routinely prints example JSON as
 * documentation, and treating that as an instruction would edit the user's
 * project because a sentence explained how editing works.
 */
const TOOL_FENCE = /```video-tool[^\n]*\n([\s\S]*?)(?:```|$)/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accepts one call, an array of calls, or one call per line.
 *
 * The array and the line-per-call forms are not generosity for its own sake:
 * a local 14B model asked for two edits emits both spellings about equally
 * often, and rejecting one of them costs a whole turn to say so.
 */
function toRequests(body: string): VideoToolRequest[] {
  const candidates: unknown[] = [];
  const whole = tryParse(body);
  if (whole !== undefined) {
    candidates.push(...(Array.isArray(whole) ? whole : [whole]));
  } else {
    for (const line of body.split("\n")) {
      const parsed = tryParse(line);
      if (parsed !== undefined) candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
  }

  const requests: VideoToolRequest[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    // `tool` is the name this protocol uses; `name` is what a model that has
    // seen an MCP schema tends to write instead.
    const tool = candidate.tool ?? candidate.name;
    if (typeof tool !== "string" || !tool.trim()) continue;
    const args = candidate.arguments ?? candidate.args ?? candidate.input ?? {};
    requests.push({ tool: tool.trim(), arguments: isRecord(args) ? args : {} });
  }
  return requests;
}

function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Extracts the editor tool calls a model explicitly asked for, in order. */
export function parseVideoToolCalls(text: string): VideoToolRequest[] {
  const requests: VideoToolRequest[] = [];
  let match: RegExpExecArray | null;
  TOOL_FENCE.lastIndex = 0;
  while ((match = TOOL_FENCE.exec(text)) !== null) {
    requests.push(...toRequests(match[1]));
  }
  return requests;
}

export function hasVideoToolCalls(text: string): boolean {
  return parseVideoToolCalls(text).length > 0;
}

export interface VideoToolExecution {
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  /** JSON of what the tool returned, already capped for the next prompt. */
  output: string;
  truncated: boolean;
  error?: string;
  durationMs: number;
}

/** Executes one tool against the editor and reports what happened. */
export type VideoToolExecutor = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ success: boolean; data?: unknown; error?: string; durationMs: number }>;

export interface RunVideoToolCallsOptions {
  /** Injected so the runner needs no editor import and stays testable. */
  execute: VideoToolExecutor;
  signal?: AbortSignal;
  onToolCall?: (toolCall: ToolCall) => void;
  maxCalls?: number;
  maxOutputChars?: number;
}

const DEFAULT_MAX_CALLS = 6;
/**
 * `describe_timeline` on a modest project already runs past 4,000 characters,
 * and a truncated timeline is worse than a short one: the clip ids the model
 * needs are spread through the whole structure, so cutting the tail silently
 * removes the tracks it was about to edit.
 */
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;

export async function runVideoToolCalls(
  text: string,
  options: RunVideoToolCallsOptions,
): Promise<VideoToolExecution[]> {
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const requests = parseVideoToolCalls(text).slice(0, maxCalls);
  const executions: VideoToolExecution[] = [];

  for (const request of requests) {
    if (options.signal?.aborted) break;

    const toolId = `tool-video-${Math.random().toString(36).slice(2, 10)}`;
    const emit = (status: ToolCall["status"], result?: string) =>
      options.onToolCall?.({
        id: toolId,
        name: `video.${request.tool}`,
        arguments: request.arguments,
        status,
        ...(result ? { result } : {}),
      });

    emit("running");
    const outcome = await options.execute(request.tool, request.arguments);

    if (!outcome.success) {
      const error = outcome.error ?? `${request.tool} failed without a message.`;
      emit("error", error);
      executions.push({
        tool: request.tool,
        arguments: request.arguments,
        ok: false,
        output: "",
        truncated: false,
        error,
        durationMs: outcome.durationMs,
      });
      continue;
    }

    const serialized = stringify(outcome.data);
    const truncated = serialized.length > maxOutputChars;
    emit("completed", summarize(request.tool, outcome.data, outcome.durationMs));
    executions.push({
      tool: request.tool,
      arguments: request.arguments,
      ok: true,
      output: truncated ? `${serialized.slice(0, maxOutputChars)}\n…` : serialized,
      truncated,
      durationMs: outcome.durationMs,
    });
  }

  return executions;
}

function stringify(data: unknown): string {
  if (data === undefined) return "(no result)";
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/**
 * The one-line result the chat's tool card shows.
 *
 * The full JSON goes to the model, not to the user: a reader watching the
 * panel change wants to know that four properties moved, not to read the
 * project back as a wall of braces.
 */
function summarize(tool: string, data: unknown, durationMs: number): string {
  const suffix = `${durationMs} ms`;
  if (!isRecord(data)) return suffix;

  if (Array.isArray(data.tracks)) {
    const clips = data.tracks.reduce(
      (total: number, track: unknown) =>
        total + (isRecord(track) && Array.isArray(track.clips) ? track.clips.length : 0),
      0,
    );
    return `${data.tracks.length} tracks · ${clips} clips · ${suffix}`;
  }
  if (Array.isArray(data.changes)) {
    const changed = data.changes
      .filter(isRecord)
      .map((change) => `${String(change.path)} → ${JSON.stringify(change.to)}`)
      .join(", ");
    return changed ? `${changed} · ${suffix}` : `nothing changed · ${suffix}`;
  }
  if (typeof data.param === "string") {
    return `${String(data.effect)}.${data.param} = ${JSON.stringify(data.value)} · ${suffix}`;
  }
  return suffix;
}

/** Builds the observation the model reads on its next turn. */
export function buildVideoToolEvidence(executions: VideoToolExecution[]): string {
  if (executions.length === 0) return "";
  const blocks = executions.map((execution) => {
    const call = `${execution.tool}(${JSON.stringify(execution.arguments)})`;
    return execution.ok
      ? [
          `> ${call}`,
          "# succeeded",
          execution.output,
          execution.truncated ? "# result truncated" : "",
        ].filter(Boolean).join("\n")
      : `> ${call}\n# failed — ${execution.error}`;
  });
  return [
    "Editor tool results from the Teminali Cut panel. These are the real state of the "
      + "user's project; treat them as the only evidence of what the timeline contains and "
      + "of which edits landed.",
    ...blocks,
  ].join("\n\n");
}
