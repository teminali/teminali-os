/**
 * The live agent run, as something the narrator can read.
 *
 * `progressNarration` and `coRunner` both speak `RunProgress` — a shape that
 * predates the realtime tier and was written against the chat engine's tool
 * calls. The Teminali OS assistant that Temi hands work to reports through
 * `assistantActivityStore` instead: the same events, a different vocabulary,
 * because that store also feeds the process line under the orb.
 *
 * This is the translation, and it is the only place the two vocabularies meet.
 * Pure on purpose — it takes the items, not the store, so a test can hand it
 * three objects and the router can be exercised without a renderer.
 */

import type { AssistantActivityItem } from "../../store/assistantActivityStore.ts";
import type { NarratableToolCall, RunProgress } from "./progressNarration.ts";

/**
 * Activity types name what happened; tool names name what did it. The narrator
 * keys its verbs off the tool name, so the mapping has to land on names it
 * already knows — `describeToolCall` says "editing" for Edit and "running" for
 * Bash, and would say nothing at all for "edit".
 */
const TOOL_FOR_TYPE: Record<AssistantActivityItem["type"], string> = {
  cmd: "Bash",
  test: "Bash",
  edit: "Edit",
  read: "Read",
};

/** A create is a Write, not an Edit — the narrator distinguishes them and so does the operator. */
function toolName(item: AssistantActivityItem): string {
  if (item.type === "edit" && item.badge === "create") return "Write";
  return TOOL_FOR_TYPE[item.type] ?? "Bash";
}

function statusOf(item: AssistantActivityItem): NarratableToolCall["status"] {
  if (item.status === "failed") return "error";
  if (item.status === "success") return "completed";
  // No status is something that has just started. The ticker made the same
  // choice for the same reason: a step is reported the moment it begins.
  return "running";
}

function argumentsOf(item: AssistantActivityItem): Record<string, unknown> {
  if (item.file) return { file_path: item.file };
  if (item.cmd) return { command: item.cmd };
  return {};
}

export interface RunProgressFromActivityOptions {
  /** Wording only — "the claude agent has been running for…". */
  engine?: string;
  /** Defaults to the oldest item's timestamp, then to `now`. */
  startedAt?: number;
  /** The assistant's own prose, if the run has offered any. */
  lastText?: string | null;
  finishedAt?: number;
  now?: number;
}

/**
 * Build a `RunProgress` from the activity the assistant has logged.
 *
 * Items are assumed to arrive oldest-first, which is how the store appends
 * them; they are sorted anyway, because a digest that reports the steps in the
 * wrong order is worse than one that costs a sort.
 */
export function runProgressFromActivity(
  items: readonly AssistantActivityItem[],
  options: RunProgressFromActivityOptions = {},
): RunProgress {
  const now = options.now ?? Date.now();
  const ordered = [...items].sort((a, b) => a.timestamp - b.timestamp);
  const toolCalls: NarratableToolCall[] = ordered.map((item) => ({
    id: item.id,
    name: toolName(item),
    arguments: argumentsOf(item),
    status: statusOf(item),
    result: item.result,
  }));
  const startedAt = options.startedAt ?? ordered[0]?.timestamp ?? now;
  const run: RunProgress = {
    startedAt,
    engine: options.engine ?? "Teminali",
    toolCalls,
    lastText: (options.lastText ?? "").trim(),
  };
  if (options.finishedAt !== undefined) run.finishedAt = options.finishedAt;
  return run;
}
