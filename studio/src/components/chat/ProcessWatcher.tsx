import React, { useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
import type { ToolCall } from "../../types";

export interface ProcessWatcherProps {
  engine?: string;
  mode?: string;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  charCount?: number;
  tokensCount?: number;
  durationSec?: number;
  onJumpToFile?: (path: string, code: string) => void;
  compact?: boolean;
}

export const ProcessWatcher: React.FC<ProcessWatcherProps> = ({
  toolCalls = [],
  isStreaming = false,
  durationSec,
  onJumpToFile,
  compact = false,
}) => {
  // Default to expanded while actively streaming tool calls, collapsed when finished
  const [expanded, setExpanded] = useState(isStreaming);

  const totalSteps = toolCalls.length;
  if (!isStreaming && totalSteps === 0) return null;

  return (
    <div className="my-1 select-none">
      {/* Sleek, minimal collapsible header */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink-high transition-colors font-medium group py-0.5"
      >
        {isStreaming ? (
          <Loader2 size={12} className="animate-spin text-ink-soft flex-shrink-0" />
        ) : (
          <Brain size={12} className="text-ink-faint group-hover:text-ink-soft transition-colors flex-shrink-0" />
        )}

        <span>
          {isStreaming
            ? "Thinking…"
            : `Thought for ${durationSec ? `${durationSec.toFixed(1)}s` : "a few seconds"}`}
        </span>

        {totalSteps > 0 && (
          <span className="text-3xs text-ink-faint font-mono">
            · {totalSteps} {totalSteps === 1 ? "step" : "steps"}
          </span>
        )}

        {expanded ? (
          <ChevronDown size={11} className="text-ink-faint ml-0.5" />
        ) : (
          <ChevronRight size={11} className="text-ink-faint ml-0.5" />
        )}
      </button>

      {/* Clean, monochrome step list */}
      {expanded && totalSteps > 0 && (
        <div className="mt-1 pl-2 border-l border-edge/30 space-y-1">
          {toolCalls.map((call, idx) => {
            const args = call.arguments ?? {};
            const filePath = (args.path || args.file || args.filePath || args.filename) as string | undefined;
            const command = (args.command || args.cmd || args.script) as string | undefined;
            const query = (args.query || args.pattern || args.search) as string | undefined;
            const isCallRunning = call.status === "running";
            const isCallError = call.status === "error";

            return (
              <div
                key={call.id || idx}
                className="flex items-center justify-between gap-2 py-0.5 text-2xs font-mono text-ink-muted"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  {isCallRunning ? (
                    <Loader2 size={11} className="animate-spin text-ink-soft flex-shrink-0" />
                  ) : isCallError ? (
                    <span className="text-danger font-bold text-3xs flex-shrink-0">!</span>
                  ) : (
                    <Check size={11} className="text-success/70 flex-shrink-0" strokeWidth={2} />
                  )}

                  <span className="truncate">
                    {filePath ? (
                      <button
                        type="button"
                        onClick={() => onJumpToFile?.(filePath, "")}
                        className="hover:underline text-left text-ink-prose"
                      >
                        {filePath}
                      </button>
                    ) : command ? (
                      <span className="text-ink-prose">$ {command}</span>
                    ) : query ? (
                      <span>search &ldquo;{query}&rdquo;</span>
                    ) : (
                      <span>{call.name}</span>
                    )}
                  </span>
                </div>

                {call.result && (
                  <span className="text-3xs text-ink-faint truncate max-w-[140px]">
                    {call.result}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
