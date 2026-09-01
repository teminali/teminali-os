import React, { useState } from "react";
import { 
  GitCompare, 
  Check, 
  X, 
  Columns, 
  FileText, 
  ShieldCheck, 
  Sparkles, 
  Zap, 
  ArrowRight,
  Layers,
  Copy,
  ChevronDown
} from "lucide-react";
import { useStudioStore } from "../../store/studioStore";

interface DiffLine {
  type: "addition" | "deletion" | "context";
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

interface DiffChunk {
  id: string;
  header: string;
  lines: DiffLine[];
  isApplied: boolean;
}

export const DiffInspectorModal: React.FC = () => {
  const { isDiffViewerOpen, setDiffViewerOpen, activeDiff, setActiveDiff } = useStudioStore();
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
  const [isCopied, setIsCopied] = useState(false);
  const [acceptedChunks, setAcceptedChunks] = useState<Record<string, boolean>>({
    chunk_1: true,
    chunk_2: true,
  });

  if (!isDiffViewerOpen) return null;

  const fileName = activeDiff?.file || "src/services/aiService.ts";

  const chunks: DiffChunk[] = [
    {
      id: "chunk_1",
      header: "@@ -28,8 +28,14 @@ export class AIService {",
      isApplied: !!acceptedChunks["chunk_1"],
      lines: [
        { type: "context", oldLineNumber: 28, newLineNumber: 28, content: "  public static async streamMessage(" },
        { type: "context", oldLineNumber: 29, newLineNumber: 29, content: "    engine: \"frontier\" | \"antigravity\" | \"claude\"," },
        { type: "deletion", oldLineNumber: 30, content: "-   callbacks: StreamCallbacks" },
        { type: "addition", newLineNumber: 30, content: "+   callbacks: StreamCallbacks," },
        { type: "addition", newLineNumber: 31, content: "+   options?: { strictTypeChecking?: boolean; maxTries?: number }" },
        { type: "addition", newLineNumber: 32, content: "+ ): Promise<SelfHealingResult> {" },
        { type: "context", oldLineNumber: 33, newLineNumber: 33, content: "    const startTime = performance.now();" },
      ],
    },
    {
      id: "chunk_2",
      header: "@@ -84,7 +90,12 @@ export class AIService {",
      isApplied: !!acceptedChunks["chunk_2"],
      lines: [
        { type: "context", oldLineNumber: 84, newLineNumber: 90, content: "    // Execute AST self-healing pass" },
        { type: "deletion", oldLineNumber: 85, content: "-   const result = await compiler.check(code);" },
        { type: "addition", newLineNumber: 91, content: "+   const result = await SelfHealingCompilerService.analyzeAndHeal({" },
        { type: "addition", newLineNumber: 92, content: "+     \"diff.tsx\": code," },
        { type: "addition", newLineNumber: 93, content: "+   });" },
        { type: "context", oldLineNumber: 86, newLineNumber: 94, content: "    return result;" },
      ],
    },
  ];

  const toggleChunk = (chunkId: string) => {
    setAcceptedChunks((prev) => ({ ...prev, [chunkId]: !prev[chunkId] }));
  };

  const handleAcceptAll = () => {
    alert("✓ All diff chunks accepted and patched into " + fileName);
    setDiffViewerOpen(false);
  };

  const handleCopyDiff = () => {
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 1500);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 select-none font-mono text-xs">
      <div className="w-full max-w-4xl h-[80vh] bg-[#0c0d12] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="h-14 px-6 border-b border-[#1c1f26] bg-[#0e1015] flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#00f0ff]/15 border border-[#00f0ff]/30 flex items-center justify-center text-[#00f0ff]">
              <GitCompare className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-white text-sm font-sans">{fileName}</span>
                <span className="text-3xs font-mono font-bold text-[#10b981] bg-[#10b981]/15 px-2 py-0.5 rounded border border-[#10b981]/30">
                  +5 additions
                </span>
                <span className="text-3xs font-mono font-bold text-[#f43f5e] bg-[#f43f5e]/15 px-2 py-0.5 rounded border border-[#f43f5e]/30">
                  -2 deletions
                </span>
              </div>
              <div className="flex items-center gap-2 text-3xs text-slate-400 mt-0.5">
                <ShieldCheck className="w-3 h-3 text-[#10b981]" />
                <span>Compiler Verified (0 TS Diagnostics · Atomic AST Patch)</span>
              </div>
            </div>
          </div>

          {/* Header Controls */}
          <div className="flex items-center gap-2">
            {/* View Mode Toggle */}
            <div className="flex items-center bg-[#181c24] p-0.5 rounded-lg border border-white/5 text-3xs">
              <button
                onClick={() => setViewMode("unified")}
                className={`px-2.5 py-1 rounded font-bold transition-all ${
                  viewMode === "unified" ? "bg-[#00f0ff]/20 text-[#00f0ff]" : "text-slate-400 hover:text-white"
                }`}
              >
                Unified
              </button>
              <button
                onClick={() => setViewMode("split")}
                className={`px-2.5 py-1 rounded font-bold transition-all ${
                  viewMode === "split" ? "bg-[#00f0ff]/20 text-[#00f0ff]" : "text-slate-400 hover:text-white"
                }`}
              >
                Split
              </button>
            </div>

            <button
              onClick={handleCopyDiff}
              className="p-2 text-slate-400 hover:text-white hover:bg-[#181c24] rounded-lg transition-all"
              title="Copy Raw Diff"
            >
              {isCopied ? <Check className="w-4 h-4 text-[#10b981]" /> : <Copy className="w-4 h-4" />}
            </button>

            <button
              onClick={() => setDiffViewerOpen(false)}
              className="p-2 text-slate-400 hover:text-white hover:bg-[#181c24] rounded-lg transition-all cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Diff Content Canvas */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[#08090b]">
          {chunks.map((chunk) => {
            const isApplied = acceptedChunks[chunk.id];
            return (
              <div
                key={chunk.id}
                className="border border-[#1c1f26] rounded-xl overflow-hidden bg-[#0c0d12] shadow-sm"
              >
                {/* Chunk Header */}
                <div className="px-4 py-2 bg-[#12151c] border-b border-[#1c1f26] flex items-center justify-between text-3xs text-slate-400">
                  <span className="font-mono text-[#38bdf8] font-bold">{chunk.header}</span>
                  <button
                    onClick={() => toggleChunk(chunk.id)}
                    className={`px-2.5 py-1 rounded text-3xs font-mono font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                      isApplied
                        ? "bg-[#10b981]/20 text-[#10b981] border border-[#10b981]/30"
                        : "bg-[#f43f5e]/20 text-[#f43f5e] border border-[#f43f5e]/30"
                    }`}
                  >
                    {isApplied ? (
                      <>
                        <Check className="w-3 h-3" />
                        <span>Chunk Active</span>
                      </>
                    ) : (
                      <>
                        <X className="w-3 h-3" />
                        <span>Chunk Ignored</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Lines */}
                <div className="divide-y divide-white/[0.02] font-mono text-2xs leading-relaxed">
                  {chunk.lines.map((line, idx) => (
                    <div
                      key={idx}
                      className={`flex items-center py-1 px-3 ${
                        line.type === "addition"
                          ? "bg-[#10b981]/10 text-[#34d399] border-l-2 border-l-[#10b981]"
                          : line.type === "deletion"
                          ? "bg-[#f43f5e]/10 text-[#fb7185] border-l-2 border-l-[#f43f5e]"
                          : "text-slate-400 hover:bg-[#0e1015]"
                      }`}
                    >
                      <span className="w-8 text-right pr-3 select-none text-slate-600">
                        {line.oldLineNumber || ""}
                      </span>
                      <span className="w-8 text-right pr-3 select-none text-slate-600">
                        {line.newLineNumber || ""}
                      </span>
                      <span className="flex-1 whitespace-pre">{line.content}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Modal Footer Strip */}
        <div className="h-16 px-6 border-t border-[#1c1f26] bg-[#0e1015] flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2 text-xs text-slate-400 font-sans">
            <span className="w-2 h-2 rounded-full bg-[#10b981] animate-pulse" />
            <span>2 chunks ready for atomic injection into workspace</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setDiffViewerOpen(false)}
              className="px-4 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-[#181c24] text-xs font-sans transition-all cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleAcceptAll}
              className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-[#00f0ff] to-[#10b981] text-black font-bold text-xs font-sans shadow-lg shadow-[#00f0ff]/20 hover:opacity-95 transition-all flex items-center gap-2 cursor-pointer"
            >
              <Check className="w-4 h-4 stroke-[3]" />
              <span>Accept & Apply Patch (⌘↵)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
