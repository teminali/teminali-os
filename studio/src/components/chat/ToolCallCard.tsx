import React, { useState } from "react";
import { ChevronDown, ChevronRight, Terminal, CheckCircle2, AlertCircle, Loader2, FileCode, Check } from "lucide-react";
import { ToolCall } from "../../types";
import { useStudioStore } from "../../store/studioStore";

export const ToolCallCard: React.FC<{ tool: ToolCall }> = ({ tool }) => {
  const [isOpen, setIsOpen] = useState(true);
  const { openFile } = useStudioStore();

  return (
    <div className="my-2 rounded-xl glass-card border border-border/80 overflow-hidden text-xs">
      {/* Header Bar */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="px-3 py-2 bg-surfaceSunken/60 hover:bg-surfaceSunken flex items-center justify-between cursor-pointer select-none transition-all"
      >
        <div className="flex items-center gap-2">
          {tool.status === "running" && <Loader2 className="w-3.5 h-3.5 text-brand animate-spin" />}
          {tool.status === "completed" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
          {tool.status === "error" && <AlertCircle className="w-3.5 h-3.5 text-rose-400" />}

          <span className="font-mono font-semibold text-textMain">{tool.name}</span>
        </div>

        <div className="flex items-center gap-1 text-textFaint">
          <span className="text-3xs uppercase tracking-wider">{tool.status}</span>
          {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </div>
      </div>

      {/* Expanded Content */}
      {isOpen && (
        <div className="p-3 bg-surfaceSunken/30 border-t border-border/40 space-y-2">
          {tool.arguments && (
            <div>
              <span className="text-3xs font-semibold uppercase text-textFaint">Arguments</span>
              <pre className="mt-1 p-2 rounded-lg bg-surfaceSunken text-textMuted font-mono text-2xs overflow-x-auto">
                {JSON.stringify(tool.arguments, null, 2)}
              </pre>
            </div>
          )}

          {tool.diff && (
            <div className="mt-2 p-2.5 rounded-lg bg-surface border border-border">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5 text-textMain font-mono text-2xs">
                  <FileCode className="w-3.5 h-3.5 text-brand" />
                  <span>{tool.diff.file}</span>
                </div>
                <div className="flex items-center gap-1.5 text-3xs font-mono">
                  <span className="text-emerald-400">+{tool.diff.additions}</span>
                  <span className="text-rose-400">-{tool.diff.deletions}</span>
                </div>
              </div>
              <pre className="p-2 rounded bg-surfaceSunken font-mono text-2xs overflow-x-auto text-emerald-300">
                {tool.diff.diffText}
              </pre>
            </div>
          )}

          {tool.result && (
            <div>
              <span className="text-3xs font-semibold uppercase text-textFaint">Result</span>
              <pre className="mt-1 p-2 rounded-lg bg-surfaceSunken text-textMuted font-mono text-2xs overflow-x-auto whitespace-pre-wrap">
                {tool.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
