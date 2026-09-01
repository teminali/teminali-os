import React, { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Brain,
  Search,
  FileCode,
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
  elapsedSeconds = 12,
  isStreaming = false,
  introText = "I'll explore the repository structure and key docs to give you a clear project overview.",
}) => {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <div className="my-3 font-sans text-xs select-none space-y-2">
      {/* Collapsible Worked Summary Pill */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 transition-colors font-medium py-1"
      >
        <span>Worked for {elapsedSeconds}s</span>
        {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>

      {/* Expanded Steps List */}
      {isOpen && (
        <div className="pl-1 space-y-2 border-l border-white/5 ml-1 py-1 text-gray-400">
          {/* Thought line */}
          <div className="flex items-center gap-2 pl-3">
            <span className="font-medium text-gray-300">Thought</span>
            <span className="text-gray-500">briefly</span>
          </div>

          {/* Intro text */}
          {introText && (
            <div className="pl-3 text-gray-300 leading-relaxed font-normal">
              {introText}
            </div>
          )}

          {/* Dynamic Exploration & Planning Steps */}
          <div className="pl-3 space-y-1.5">
            <div className="flex items-center gap-2 text-gray-400">
              <Search size={13} className="text-gray-500" />
              <span>Explored 15 files, 7 searches</span>
            </div>

            {isStreaming ? (
              <div className="flex items-center gap-2 text-[#38bdf8] animate-pulse">
                <Loader2 size={13} className="animate-spin" />
                <span>Planning next moves...</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-gray-500">
                <CheckCircle2 size={13} className="text-[#22c55e]" />
                <span>Completed initial planning</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
