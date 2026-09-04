/**
 * What a turn actually did, folded into the few lines a person reads.
 *
 * A turn that touches eight files emits eight tool calls, and eight rows is a
 * wall. Consecutive calls of the same kind therefore collapse into one row —
 * "Ran 6 commands", "Explored 3 files, 1 search", "Edited main.cjs +5 −2" —
 * which the operator opens when they want the individual steps.
 *
 * Consecutive, not global: the order in which the assistant read, ran and
 * edited is itself information, and a global regroup would destroy it. Two runs
 * of commands either side of an edit stay two rows.
 *
 * Pure so it can be tested without a renderer — see tests/change-review.test.mjs.
 */

import type { ToolCall } from "../types";

export type ActivityKind = "run" | "explore" | "edit" | "web" | "task" | "other";

export interface ActivityGroup {
  id: string;
  kind: ActivityKind;
  /** The headline: what this run of calls did, in a few words. */
  label: string;
  calls: ToolCall[];
  status: "running" | "error" | "done";
  additions: number;
  deletions: number;
}

const PATTERNS: [ActivityKind, RegExp][] = [
  ["edit", /(edit|write|patch|apply|create_file|str_replace|multi_?edit|save|delete_file|mkdir)/],
  ["run", /(run|bash|shell|exec|terminal|command|npm|script)/],
  ["web", /(fetch|web|browse|http|url|crawl)/],
  ["task", /(task|agent|subagent|dispatch|spawn)/],
  ["explore", /(read|open|view|cat|list|tree|glob|grep|search|find|ripgrep|lookup|inspect)/],
];

export function classifyCall(call: ToolCall): ActivityKind {
  const name = (call.name ?? "").toLowerCase();
  for (const [kind, pattern] of PATTERNS) if (pattern.test(name)) return kind;
  // Some engines name a tool opaquely but still hand it a command or a path.
  const args = call.arguments ?? {};
  if (typeof args.command === "string" || typeof args.cmd === "string") return "run";
  if (typeof args.content === "string" && (typeof args.path === "string" || typeof args.file === "string")) return "edit";
  if (typeof args.query === "string" || typeof args.pattern === "string") return "explore";
  if (typeof args.path === "string" || typeof args.file === "string") return "explore";
  return "other";
}

/** Whether an exploring call was a search rather than a file read. */
function isSearch(call: ToolCall): boolean {
  const name = (call.name ?? "").toLowerCase();
  if (/(grep|search|find|glob|ripgrep)/.test(name)) return true;
  const args = call.arguments ?? {};
  return typeof args.query === "string" || typeof args.pattern === "string";
}

/** A step's own headline: what it did, not its raw JSON. */
export function describeCall(call: ToolCall): string {
  const args = call.arguments ?? {};
  const first = (keys: string[]) => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };

  const command = first(["command", "cmd", "script"]);
  if (command) return command.length > 90 ? `${command.slice(0, 90)}…` : command;
  const path = first(["path", "file", "filePath", "filename", "file_path"]);
  if (path) return path;
  const query = first(["query", "pattern", "search"]);
  if (query) return `“${query}”`;
  const prompt = first(["prompt", "description", "task"]);
  if (prompt) return prompt.length > 70 ? `${prompt.slice(0, 70)}…` : prompt;
  return call.name;
}

/** The file a call touched, when it touched one. Used for the edit label. */
export function pathOf(call: ToolCall): string | null {
  const args = call.arguments ?? {};
  for (const key of ["path", "file", "filePath", "filename", "file_path"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return call.diff?.file ?? null;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Past for what is done, present for what is happening. Both are one word. */
const VERBS: Record<ActivityKind, [past: string, present: string]> = {
  run: ["Ran", "Running"],
  edit: ["Edited", "Editing"],
  explore: ["Explored", "Exploring"],
  web: ["Fetched", "Fetching"],
  task: ["Delegated", "Delegating"],
  other: ["", ""],
};

function labelFor(kind: ActivityKind, calls: ToolCall[], running: boolean): string {
  const single = calls.length === 1;
  const verb = VERBS[kind][running ? 1 : 0];
  switch (kind) {
    case "run":
      return single ? `${verb} ${describeCall(calls[0])}` : `${verb} ${plural(calls.length, "command")}`;
    case "edit": {
      const paths = new Set(calls.map((call) => pathOf(call)).filter(Boolean) as string[]);
      if (paths.size === 1) return `${verb} ${[...paths][0].split("/").pop()}`;
      return `${verb} ${plural(paths.size || calls.length, "file")}`;
    }
    case "explore": {
      const searches = calls.filter(isSearch).length;
      const reads = calls.length - searches;
      const parts: string[] = [];
      if (reads > 0) parts.push(plural(reads, "file"));
      if (searches > 0) parts.push(plural(searches, "search", "searches"));
      return `${verb} ${parts.join(", ")}`;
    }
    case "web":
      return single ? `${verb} ${describeCall(calls[0])}` : `${verb} ${plural(calls.length, "page")}`;
    case "task":
      return single ? `${verb} ${describeCall(calls[0])}` : `${verb} ${plural(calls.length, "task")}`;
    default:
      return single ? describeCall(calls[0]) : `${plural(calls.length, "step")}`;
  }
}

export function groupActivity(calls: ToolCall[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];

  for (const call of calls ?? []) {
    const kind = classifyCall(call);
    const last = groups[groups.length - 1];
    if (last && last.kind === kind) last.calls.push(call);
    else groups.push({ id: call.id ?? `group-${groups.length}`, kind, label: "", calls: [call], status: "done", additions: 0, deletions: 0 });
  }

  for (const group of groups) {
    group.status = group.calls.some((call) => call.status === "running")
      ? "running"
      : group.calls.some((call) => call.status === "error")
        ? "error"
        : "done";
    group.label = labelFor(group.kind, group.calls, group.status === "running");
    group.additions = group.calls.reduce((total, call) => total + (call.diff?.additions ?? 0), 0);
    group.deletions = group.calls.reduce((total, call) => total + (call.diff?.deletions ?? 0), 0);
  }

  return groups;
}
