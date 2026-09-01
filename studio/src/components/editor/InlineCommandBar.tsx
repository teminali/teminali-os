import React, { useState, useEffect, useRef } from "react";
import { Sparkles, ArrowUp, X, Check, Wand2, Zap, CornerDownLeft } from "lucide-react";
import { AIService } from "../../services/aiService";

interface InlineCommandBarProps {
  isOpen: boolean;
  onClose: () => void;
  cursorPosition: { lineNumber: number; column: number };
  onApplyCode: (newCode: string) => void;
}

export const InlineCommandBar: React.FC<InlineCommandBarProps> = ({
  isOpen,
  onClose,
  cursorPosition,
  onApplyCode,
}) => {
  const [prompt, setPrompt] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedDiff, setStreamedDiff] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setPrompt("");
      setStreamedDiff("");
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleGenerate = async () => {
    if (!prompt.trim() || isStreaming) return;
    setIsStreaming(true);
    setStreamedDiff("");

    let accumulated = "";
    await AIService.streamMessage(
      "frontier",
      `Refactor or generate TypeScript code for line ${cursorPosition.lineNumber}: ${prompt}`,
      [],
      {
        onToken: (token) => {
          accumulated += token;
          setStreamedDiff(accumulated);
        },
        onComplete: (data) => {
          setIsStreaming(false);
          onApplyCode(data.fullText);
        },
        onError: () => {
          setIsStreaming(false);
        },
      }
    );
  };

  return (
    <div className="absolute top-14 left-1/2 -translate-x-1/2 z-50 w-full max-w-xl animate-in fade-in zoom-in-95 duration-150 font-sans shadow-2xl">
      <div className="bg-[#12161c]/95 backdrop-blur-xl border border-cyan-500/40 rounded-2xl p-2.5 shadow-[0_10px_35px_rgba(0,0,0,0.7)] flex flex-col gap-2">
        {/* Input Row */}
        <div className="flex items-center gap-2 px-2 py-1">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-black font-bold flex-shrink-0 shadow">
            <Sparkles className="w-3.5 h-3.5 text-black fill-black" />
          </div>

          <input
            ref={inputRef}
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleGenerate();
              }
              if (e.key === "Escape") {
                onClose();
              }
            }}
            placeholder="Edit selected code or prompt Frontier inline (⌘K)..."
            className="flex-1 bg-transparent border-0 outline-none text-xs text-white placeholder-slate-400 font-medium"
          />

          <div className="flex items-center gap-1.5">
            <button
              onClick={handleGenerate}
              disabled={isStreaming || !prompt.trim()}
              className="px-3 py-1 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-[11px] flex items-center gap-1 transition-all disabled:opacity-40 shadow cursor-pointer"
            >
              <span>Generate</span>
              <CornerDownLeft className="w-3 h-3" />
            </button>
            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/[0.05]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Live Streaming Diff Preview Box */}
        {streamedDiff && (
          <div className="p-3 bg-[#080a0e] border border-white/10 rounded-xl font-mono text-[11px] text-cyan-300 max-h-48 overflow-y-auto whitespace-pre-wrap leading-relaxed shadow-inner">
            <div className="flex items-center justify-between text-[10px] text-slate-400 font-sans mb-1 pb-1 border-b border-white/5">
              <span>⚡ Live Cursor Diff Stream</span>
              <span className="text-emerald-400 font-mono font-bold">$0.00 / Local GPU</span>
            </div>
            {streamedDiff}
          </div>
        )}
      </div>
    </div>
  );
};
