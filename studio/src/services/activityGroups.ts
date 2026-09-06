/**
 * What a turn actually did, one call at a time.
 *
 * This module used to fold consecutive calls of a kind into one row — "Ran 6
 * commands", "Explored 3 files, 1 search" — on the argument that eight rows is
 * a wall. It is, and the wall was the point: folding cost two clicks to answer
 * "what is it doing right now?", which is the only question this strip exists
 * to answer. `ProcessWatcher` renders every call in the order it happened, so
 * what is left here is per-call: which glyph a call wears (`classifyCall`),
 * what its row says (`describeCall`), and which file it touched (`pathOf`).
 *
 * Pure so it can be tested without a renderer — see tests/change-review.test.mjs.
 */

import type { ToolCall } from "../types";

export type ActivityKind = "run" | "explore" | "edit" | "web" | "task" | "other";

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
