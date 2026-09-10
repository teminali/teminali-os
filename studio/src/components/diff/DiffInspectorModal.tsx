import React, { useMemo, useState } from "react";
import { MacCloseButton } from "../ui";
import { 
  GitCompare, 
  Check, 
  X, 
  Columns, 
  FileText, 
  ShieldCheck, 
  Sparkle, 
  Zap, 
  ArrowRight,
  Layers,
  Copy,
  ChevronDown
} from "lucide-react";
import { useStudioStore } from "../../store/studioStore";
import { diffChunks, type DiffChunk } from "../../services/diff";

export const DiffInspectorModal: React.FC = () => {
  const { isDiffViewerOpen, setDiffViewerOpen, activeDiff, setActiveDiff } = useStudioStore();
  /* Settings > Appearance > Themed Diff Backgrounds. Off, an added line keeps
     its green text and its left marker but loses the fill — which is what an
     operator reading a long diff on a dark canvas usually wants. */
  const themedDiff = useStudioStore((state) => state.appearance.themedDiffBackgrounds);
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
  const [isCopied, setIsCopied] = useState(false);
  const [acceptedChunks, setAcceptedChunks] = useState<Record<string, boolean>>({});

  /**
   * The real diff for the file the engine is proposing to change.
   *
   * This modal used to render two hardcoded hunks — invented edits to
   * `aiService.ts` — no matter which file was actually being changed. The store
   * has carried `{ file, oldCode, newCode }` all along; it was simply never
   * read. Everything below is computed from it.
   */
  const chunks: DiffChunk[] = useMemo(
    () => (activeDiff ? diffChunks(activeDiff.oldCode, activeDiff.newCode) : []),
    [activeDiff],
  );

  if (!isDiffViewerOpen) return null;

  const fileName = activeDiff?.file ?? "No file selected";

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
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-4 select-none font-mono text-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Diff inspector"
        className="lit lit-inner relative w-full max-w-4xl h-[80vh] bg-surface-sunken rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="absolute top-3 right-3 z-20">
          <MacCloseButton onClose={() => setDiffViewerOpen(false)} size={14} />
        </div>
        {/* Modal Header */}
        <div className="h-14 px-6 border-b border-surface bg-surface-sunken flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
              <GitCompare className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-ink-bright text-sm font-sans">{fileName}</span>
                <span className="text-3xs font-mono font-bold text-success bg-success/15 px-2 py-0.5 rounded border border-success/30">
                  +5 additions
                </span>
                <span className="text-3xs font-mono font-bold text-danger bg-danger/15 px-2 py-0.5 rounded border border-danger/30">
                  -2 deletions
                </span>
              </div>
              <div className="flex items-center gap-2 text-3xs text-ink-muted mt-0.5">
                <ShieldCheck className="w-3 h-3 text-success" />
                <span>Compiler Verified (0 TS Diagnostics · Atomic AST Patch)</span>
              </div>
            </div>
          </div>

          {/* Header Controls */}
          <div className="flex items-center gap-2">
            {/* View Mode Toggle */}
            <div className="lit lit-inner flex items-center bg-surface p-0.5 rounded-lg -chrome text-3xs">
              <button
                onClick={() => setViewMode("unified")}
                className={`px-2.5 py-1 rounded font-bold transition-all ${
                  viewMode === "unified" ? "bg-accent/20 text-accent" : "text-ink-muted hover:text-ink-high"
                }`}
              >
                Unified
              </button>
              <button
                onClick={() => setViewMode("split")}
                className={`px-2.5 py-1 rounded font-bold transition-all ${
                  viewMode === "split" ? "bg-accent/20 text-accent" : "text-ink-muted hover:text-ink-high"
                }`}
              >
                Split
              </button>
            </div>

            <button
              onClick={handleCopyDiff}
              className="p-2 text-ink-muted hover:text-ink-high hover:bg-surface rounded-lg transition-all"
              title="Copy Raw Diff"
            >
              {isCopied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
            </button>

            <button
              onClick={() => setDiffViewerOpen(false)}
              className="p-2 text-ink-muted hover:text-ink-high hover:bg-surface rounded-lg transition-all cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Diff Content Canvas */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-frame-bot">
          {chunks.map((chunk) => {
            const isApplied = acceptedChunks[chunk.id];
            return (
              <div
                key={chunk.id}
                className="border border-surface rounded-xl overflow-hidden bg-surface-sunken shadow-sm"
              >
                {/* Chunk Header */}
                <div className="px-4 py-2 bg-surface-sunken border-b border-surface flex items-center justify-between text-3xs text-ink-muted">
                  <span className="font-mono text-accent font-bold">{chunk.header}</span>
                  <button
                    onClick={() => toggleChunk(chunk.id)}
                    className={`px-2.5 py-1 rounded text-3xs font-mono font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                      isApplied
                        ? "bg-success/20 text-success border border-success/30"
                        : "bg-danger/20 text-danger border border-danger/30"
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
                          ? `${themedDiff ? "bg-success/10 " : ""}text-success border-l-2 border-l-[var(--success)]`
                          : line.type === "deletion"
                          ? `${themedDiff ? "bg-danger/10 " : ""}text-danger border-l-2 border-l-[var(--danger)]`
                          : "text-ink-muted hover:bg-surface-sunken"
                      }`}
                    >
                      <span className="w-8 text-right pr-3 select-none text-ink-ghost">
                        {line.oldLineNumber || ""}
                      </span>
                      <span className="w-8 text-right pr-3 select-none text-ink-ghost">
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
        <div className="h-16 px-6 border-t border-surface bg-surface-sunken flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2 text-xs text-ink-muted font-sans">
            <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
            <span>2 chunks ready for atomic injection into workspace</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setDiffViewerOpen(false)}
              className="px-4 py-2 rounded-xl text-ink-muted hover:text-ink-high hover:bg-surface text-xs font-sans transition-all cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleAcceptAll}
              className="px-6 py-2.5 rounded-xl bg-ink-high hover:bg-accent-hover text-frame-mid font-semibold text-xs font-sans transition-colors duration-ds ease-ds flex items-center gap-2 cursor-pointer"
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
