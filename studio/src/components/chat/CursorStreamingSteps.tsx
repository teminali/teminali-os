import React, { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Brain,
  Search,
  CheckCircle2,
  Loader2,
  Sparkles,
} from "lucide-react";

export interface StepItem {
  id: string;
  type: "thought" | "explore" | "plan" | "tool";
  title: string;
  detail?: string;
  status: "running" | "completed";
}

export const CursorStreamingSteps: React.FC<{
  steps?: StepItem[];
  elapsedSeconds?: number;
  isStreaming?: boolean;
  introText?: string;
}> = ({
  steps = [],
  elapsedSeconds = 0,
  isStreaming = false,
  introText,
}) => {
  // Streaming: open by default if requested; Finished: closed by default to avoid clutter
  const [isOpen, setIsOpen] = useState(isStreaming);

  // If not streaming and no elapsed time, return null
  if (!isStreaming && elapsedSeconds <= 0 && !introText) return null;

  return (
    <div className="my-2 font-sans text-xs select-none space-y-1.5">
      {/* Collapsible Header */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors font-medium py-1 px-2 rounded-lg hover:bg-white/5"
      >
        {isStreaming ? (
          <div className="flex items-center gap-1.5 text-[#38bdf8]">
            <Loader2 size={12} className="animate-spin" />
            <span className="font-semibold font-mono">Thinking · {elapsedSeconds}s</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-gray-400">
            <Sparkles size={12} className="text-[#38bdf8]" />
            <span>Worked for {elapsedSeconds > 0 ? `${elapsedSeconds}s` : "a few seconds"}</span>
          </div>
        )}
        {isOpen ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />}
      </button>

      {/* Expanded Details */}
      {isOpen && (
        <div className="pl-3 py-1 space-y-1.5 border-l border-white/10 ml-3 text-xs text-gray-400 bg-white/[0.02] rounded-r-lg p-2">
          {introText && (
            <div className="text-gray-300 leading-relaxed font-normal text-xs">
              {introText}
            </div>
          )}

          <div className="space-y-1">
            {isStreaming ? (
              <div className="flex items-center gap-2 text-[#38bdf8] text-xs">
                <Loader2 size={11} className="animate-spin" />
                <span>Generating code and verifying components...</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-gray-400 text-3xs font-mono">
                <CheckCircle2 size={11} className="text-emerald-400" />
                <span>Generation finished</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
