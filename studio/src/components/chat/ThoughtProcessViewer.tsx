import React, { useState } from "react";
import { 
  Sparkles, 
  ChevronDown, 
  ChevronRight, 
  CheckCircle2, 
  Terminal, 
  Clock, 
  Loader2 
} from "lucide-react";

export interface ThoughtStep {
  id: string;
  title: string;
  status: "completed" | "active" | "pending";
  durationMs: number;
  tokens: number;
  details?: string;
}

export interface ToolCallExecution {
  id: string;
  name: string;
  argsSummary: string;
  status: "completed" | "running" | "failed";
  durationMs: number;
  outputPreview?: string;
}

interface ThoughtProcessViewerProps {
  thinkingText?: string;
  steps?: ThoughtStep[];
  toolCalls?: ToolCallExecution[];
  durationSec?: number;
  tokensCount?: number;
  isStreaming?: boolean;
}

export const ThoughtProcessViewer: React.FC<ThoughtProcessViewerProps> = ({
  thinkingText,
  steps,
  toolCalls,
  durationSec = 0,
  tokensCount = 0,
  isStreaming = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const evidenceSteps: ThoughtStep[] = steps || [{
    id: "measured-request",
    title: "Runtime request",
    status: isStreaming ? "active" : "completed",
    durationMs: Math.round(durationSec * 1000),
    tokens: tokensCount,
    details: isStreaming
      ? "Waiting for the runtime to return measured completion evidence."
      : `${tokensCount} tokens reported by the runtime in ${durationSec.toFixed(2)} seconds.`,
  }];

  return (
    <div className="my-2 rounded-xl border border-white/[0.08] bg-[#0c1017] overflow-hidden shadow-sm font-sans text-xs">
      {/* 1. Ultra-Clean Header Pill */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3 py-2 flex items-center justify-between bg-[#111620] hover:bg-[#151c28] transition-all text-left group cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0">
          {isStreaming ? (
            <Loader2 size={13} className="text-cyan-400 animate-spin flex-shrink-0" />
          ) : (
            <Sparkles size={13} className="text-cyan-400 flex-shrink-0" />
          )}
          <span className="font-semibold text-slate-200 text-xs truncate">
            {isStreaming ? "Executing..." : "Execution evidence"}
          </span>
          <span className="text-[10px] font-mono text-cyan-400/90 bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/20 flex-shrink-0">
            {durationSec}s · {tokensCount} tok
          </span>
        </div>

        <div className="flex items-center gap-1 text-[11px] text-slate-400 group-hover:text-white flex-shrink-0 ml-2">
          <span>{isOpen ? "Hide" : "Inspect"}</span>
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
      </button>

      {/* 2. Expanded Timeline Steps */}
      {isOpen && (
        <div className="p-3 bg-[#080b10] border-t border-white/[0.06] space-y-3 animate-in fade-in duration-100">
          <div className="relative pl-3 space-y-3 before:absolute before:left-1 before:top-2 before:bottom-2 before:w-[1px] before:bg-cyan-500/20">
            {evidenceSteps.map((step) => (
              <div key={step.id} className="relative pl-3 space-y-1">
                {/* Timeline Dot */}
                <div className="absolute -left-[14px] top-1 w-2.5 h-2.5 rounded-full bg-[#0c1017] border border-cyan-400 flex items-center justify-center">
                  <div className={`w-1 h-1 rounded-full ${step.status === "completed" ? "bg-emerald-400" : "bg-cyan-400 animate-ping"}`} />
                </div>

                {/* Step Header */}
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-200 text-[11px]">
                    {step.title}
                  </span>
                  <span className="text-[9px] font-mono text-slate-400 bg-white/5 px-1.5 py-0.5 rounded">
                    {step.durationMs}ms
                  </span>
                </div>

                {/* Step Details */}
                {step.details && (
                  <p className="text-[10px] text-slate-400 leading-relaxed font-sans">
                    {step.details}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Tool Calls Execution */}
          {toolCalls && toolCalls.length > 0 && (
            <div className="pt-2 border-t border-white/5 space-y-1.5">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                <Terminal size={11} className="text-emerald-400" /> Executed Tool
              </div>
              {toolCalls.map((tc) => (
                <div key={tc.id} className="p-2 rounded bg-black/40 border border-white/5 font-mono text-[10px] space-y-0.5">
                  <div className="flex items-center justify-between text-emerald-400 font-semibold">
                    <span>⚡ {tc.name}</span>
                    <span>{tc.durationMs}ms</span>
                  </div>
                  {tc.outputPreview && (
                    <p className="text-slate-400 text-[9px]">{tc.outputPreview}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {thinkingText && (
            <div className="p-2 rounded bg-black/60 border border-white/5 text-slate-300 text-[10px] leading-relaxed whitespace-pre-wrap font-mono">
              {thinkingText}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
