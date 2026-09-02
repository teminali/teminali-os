import React, { useState } from "react";
import { AlertCircle, Check, ChevronRight, FileDiff, Loader2, Minus, Plus, Terminal, Wrench } from "lucide-react";
import type { ToolCall } from "../../types";

/**
 * The work of a turn, as a checklist that fills in live.
 *
 * Each step appears the moment the assistant starts it, spinning; it ticks when
 * it finishes and turns red if it fails. By the end of a turn the list reads as
 * a record of what was actually done — which is the difference between a reply
 * that claims it edited four files and one that shows the four edits.
 *
 * Only real steps appear. Nothing here is invented to make the interface look
 * busy: if the model made no tool calls, there is no checklist.
 */

const GLYPHS: Record<string, React.ReactNode> = {
  run: <Terminal size={10} />,
  bash: <Terminal size={10} />,
  terminal: <Terminal size={10} />,
  edit: <FileDiff size={10} />,
  write: <FileDiff size={10} />,
  patch: <FileDiff size={10} />,
};

function glyphFor(name: string): React.ReactNode {
  const key = Object.keys(GLYPHS).find((entry) => name.toLowerCase().includes(entry));
  return key ? GLYPHS[key] : <Wrench size={10} />;
}

/** A step's headline: what it did, in a few words, not its raw JSON. */
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
  const path = first(["path", "file", "filePath", "filename"]);
  if (path) return path;
  const query = first(["query", "pattern", "search"]);
  if (query) return `“${query}”`;
  return call.name;
}

export const WorkTimeline: React.FC<{ calls: ToolCall[]; compact?: boolean }> = ({ calls, compact = false }) => {
  if (!calls || calls.length === 0) return null;

  const done = calls.filter((call) => call.status === "completed").length;
  const failed = calls.some((call) => call.status === "error");
  const working = calls.some((call) => call.status === "running");

  return (
    <div className={`lit lit-inner rounded-lg bg-surface-sunken ${compact ? "px-2.5 py-2" : "px-3 py-2.5"}`}>
      <div className="flex items-center gap-2 pb-1.5">
        <span className="text-2xs text-ink-faint">
          {working ? "Working" : failed ? "Finished with errors" : "Done"}
        </span>
        <span className="font-mono text-3xs text-ink-disabled tabular-nums">
          {done}/{calls.length}
        </span>
        {/* A thin progress bar: at a glance, how much of the turn is left. */}
        <span className="flex-1 h-px bg-edge-chrome rounded-full overflow-hidden">
          <span
            className={`block h-full transition-[width] duration-slow ease-ds ${failed ? "bg-danger" : "bg-success"}`}
            style={{ width: `${(done / calls.length) * 100}%` }}
          />
        </span>
      </div>

      <ol className="flex flex-col gap-0.5" role="list">
        {calls.map((call, index) => (
          <ChecklistStep key={call.id ?? index} call={call} />
        ))}
      </ol>
    </div>
  );
};

const ChecklistStep: React.FC<{ call: ToolCall }> = ({ call }) => {
  const [open, setOpen] = useState(false);
  const running = call.status === "running";
  const failed = call.status === "error";

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left group rounded px-1 -mx-1 py-0.5 hover:bg-surface-chip transition-colors duration-ds ease-ds"
      >
        {/* The checkbox. Square rather than round, because that is what reads
            as "a thing to be completed" rather than "a status light". */}
        <span
          className={`w-3.5 h-3.5 rounded-[4px] flex items-center justify-center flex-shrink-0 border transition-colors duration-ds ease-ds ${
            running
              ? "border-accent/50 bg-accent/10 text-accent"
              : failed
                ? "border-danger/45 bg-danger/12 text-danger"
                : "border-success/40 bg-success/15 text-success"
          }`}
        >
          {running ? (
            <Loader2 size={8} className="animate-spin" />
          ) : failed ? (
            <AlertCircle size={9} />
          ) : (
            <Check size={9} strokeWidth={3.5} />
          )}
        </span>

        <span className="text-ink-disabled flex-shrink-0">{glyphFor(call.name)}</span>

        <span
          className={`font-mono text-2xs truncate transition-colors duration-ds ease-ds ${
            running ? "text-ink-high" : failed ? "text-danger" : "text-ink-muted group-hover:text-ink-dim"
          }`}
        >
          {describeCall(call)}
        </span>

        {call.diff && (
          <span className="flex items-center gap-1.5 font-mono text-3xs flex-shrink-0">
            <span className="text-success flex items-center gap-0.5">
              <Plus size={8} />
              {call.diff.additions}
            </span>
            <span className="text-danger flex items-center gap-0.5">
              <Minus size={8} />
              {call.diff.deletions}
            </span>
          </span>
        )}

        <span className="flex-1" />
        <ChevronRight
          size={10}
          className={`text-ink-disabled flex-shrink-0 opacity-0 group-hover:opacity-100 transition-all duration-ds ease-ds ${open ? "rotate-90 opacity-100" : ""}`}
        />
      </button>

      {open && (
        <div className="ml-5 mt-1 mb-1 rounded-md bg-frame-bot px-2.5 py-2 animate-reveal">
          <div className="font-mono text-3xs text-ink-faint mb-1">{call.name}</div>
          {Object.keys(call.arguments ?? {}).length > 0 && (
            <pre className="font-mono text-3xs text-ink-code whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {JSON.stringify(call.arguments, null, 2)}
            </pre>
          )}
          {call.result && (
            <pre
              className={`font-mono text-3xs whitespace-pre-wrap break-words max-h-48 overflow-y-auto mt-1.5 pt-1.5 border-t border-edge-chrome ${
                failed ? "text-danger" : "text-ink-code"
              }`}
            >
              {call.result}
            </pre>
          )}
          {call.diff?.diffText && (
            <pre className="font-mono text-3xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto mt-1.5 pt-1.5 border-t border-edge-chrome">
              {call.diff.diffText.split("\n").map((line, index) => (
                <div
                  key={index}
                  className={
                    line.startsWith("+") && !line.startsWith("+++")
                      ? "text-success"
                      : line.startsWith("-") && !line.startsWith("---")
                        ? "text-danger"
                        : "text-ink-muted"
                  }
                >
                  {line}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}
    </li>
  );
};
