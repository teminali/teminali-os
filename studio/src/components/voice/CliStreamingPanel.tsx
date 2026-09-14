/**
 * Expandable CLI live streaming & tool calls drawer for Teminali OS.
 *
 * Implements the exact Gemini / Antigravity execution trace design:
 * - Mounted directly into the tab on top of the message box.
 * - Single continuous sliding drawer component.
 * - Single Star AI icon for standing by state.
 * - Interactive step items with rich command terminal inspector and diff badges.
 * - Bottom review bar: "← 📄 N Files With Changes" and "📑 Review Changes".
 */

import React, { useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileCode2,
  FileText,
  Layers,
  Loader2,
  Search,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import { SpokenApprovalPrompt } from "./SpokenApprovalPrompt";

/** 4-pointed Gemini diamond star (✦) matching Gemini & Antigravity execution trace design */
export const GeminiDiamondStar: React.FC<{ size?: number; className?: string }> = ({
  size = 16,
  className = "",
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    aria-hidden="true"
  >
    <path d="M12 2C12 7.52285 7.52285 12 2 12C7.52285 12 12 16.4771 12 22C12 16.4771 16.4771 12 22 12C16.4771 12 12 7.52285 12 2Z" />
  </svg>
);

/**
 * Canonical resting Temi mark: eyes and mouth (`> _ <`)
 * Not animated, no background, no borders.
 */
export const TemiFace: React.FC<{ size?: number; className?: string }> = ({
  size = 36,
  className = "text-emerald-400",
}) => (
  <svg
    width={size}
    height={Math.round((size * 52) / 80)}
    viewBox="0 0 80 52"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    {/* Left eye: > */}
    <path
      d="M 12 10 L 26 24 L 12 38"
      stroke="currentColor"
      strokeWidth="5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    {/* Mouth: _ */}
    <rect
      x="31"
      y="32"
      width="18"
      height="5.5"
      rx="2.75"
      fill="currentColor"
    />
    {/* Right eye: < */}
    <path
      d="M 68 10 L 54 24 L 68 38"
      stroke="currentColor"
      strokeWidth="5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Atom / React icon in cyan matching Gemini / Antigravity execution trace */
export const AtomIcon: React.FC<{ size?: number; className?: string }> = ({
  size = 14,
  className = "text-[#38bdf8]",
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(0 12 12)" />
    <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(120 12 12)" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </svg>
);

import { useAssistantActivityStore } from "../../store/assistantActivityStore";
import { useApprovalStore } from "../../store/approvalStore";
import { useChangeStore } from "../../store/changeStore";
import { useStudioStore } from "../../store/studioStore";

/** Determines file type icon matching Gemini's visual language */
function getFileVisual(filename: string): { icon: string; label: string } {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) {
    return { icon: "⚛️", label: "React Component" };
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.includes("walkthrough")) {
    return { icon: "📖", label: "Documentation" };
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return { icon: "🌐", label: "HTML Document" };
  }
  if (lower.endsWith(".css") || lower.endsWith(".scss")) {
    return { icon: "🎨", label: "Styles" };
  }
  if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return { icon: "⚙️", label: "Configuration" };
  }
  return { icon: "📄", label: "File" };
}

/** Formats diff numbers: +X in green, -Y in red or muted */
const DiffBadge: React.FC<{ plus?: string; minus?: string }> = ({ plus, minus }) => {
  const cleanPlus = plus ? plus.replace(/[^0-9]/g, "") : null;
  const cleanMinus = minus ? minus.replace(/[^0-9]/g, "") : null;

  return (
    <span className="inline-flex items-center gap-1 font-mono text-[11px] font-medium leading-none">
      {cleanPlus !== null && cleanPlus !== "" && (
        <span className="text-[#4ade80]">+{cleanPlus}</span>
      )}
      {cleanMinus !== null && cleanMinus !== "" && (
        <span className={cleanMinus === "0" ? "text-zinc-500" : "text-[#f87171]"}>
          -{cleanMinus}
        </span>
      )}
    </span>
  );
};

/** Helper to render thought text with inline code tags */
function renderThoughtText(text: string) {
  const parts = text.split(/(`[^`]+`|\b(?:measure|\d+)\b)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      const code = part.slice(1, -1);
      return (
        <span
          key={index}
          className="mx-0.5 rounded bg-[#28292d] px-1.5 py-0.5 font-mono text-[11px] text-zinc-300"
        >
          {code}
        </span>
      );
    }
    if (part === "measure" || /^\d+$/.test(part)) {
      return (
        <span
          key={index}
          className="mx-0.5 rounded bg-[#28292d] px-1.5 py-0.5 font-mono text-[11px] text-zinc-300"
        >
          {part}
        </span>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

export interface CliStreamingPanelProps {
  /** Callback to trigger when the user clicks 'Review Changes' */
  onReviewChanges?: () => void;
  className?: string;
}

export const CliStreamingBody: React.FC<CliStreamingPanelProps> = ({
  onReviewChanges,
  className = "",
}) => {
  const items = useAssistantActivityStore((state) => state.items);
  const isTaskRunning = useAssistantActivityStore((state) => state.isTaskRunning);
  const currentTaskPrompt = useAssistantActivityStore((state) => state.currentTaskPrompt);

  const pendingApproval = useApprovalStore((state) => state.pending);
  const changes = useChangeStore((state) => state.changes);
  const setChangeExpanded = useChangeStore((state) => state.setExpanded);
  const showFile = useStudioStore((state) => state.showFile);

  // Local state for expanded step rows & copied feedback
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleThought = (id: string) => {
    setExpandedThoughts((prev) => ({ ...prev, [id]: prev[id] === false ? true : false }));
  };

  const copyToClipboard = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  // Sort chronological (oldest to newest) so the live feed reads top-to-bottom like Gemini IDE
  const chronologicalItems = useMemo(() => {
    return [...items].reverse();
  }, [items]);

  // Auto-scroll the steps feed whenever new items arrive, task status updates, or approvals appear
  React.useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [chronologicalItems.length, isTaskRunning, pendingApproval, changes.length]);

  const handleReviewClick = () => {
    if (onReviewChanges) {
      onReviewChanges();
    } else {
      setChangeExpanded(true);
    }
  };

  return (
    <div className={`flex flex-col text-[#e3e3e3] ${className}`}>
      {/* ── Scrollable Steps Feed ──────────────────────────────────── */}
      <div
        ref={scrollContainerRef}
        className="custom-scrollbar max-h-[360px] overflow-y-auto px-4 py-3 space-y-1.5 text-[13px]"
      >
        {/* 1. Prompt Capsule (Matches exact Gemini capsule design) */}
        {currentTaskPrompt ? (
          <div className="mb-3 rounded-xl border border-[#373839] bg-[#28292a] px-3.5 py-2.5 text-[13px] text-[#e3e3e3] shadow-sm transition-all">
            <span className="line-clamp-2 leading-relaxed tracking-wide font-normal">
              {currentTaskPrompt}
            </span>
          </div>
        ) : null}

        {/* 2. Empty State with Temi's Eyes & Mouth (not animated, no background, no borders) */}
        {chronologicalItems.length === 0 && !isTaskRunning && !pendingApproval && (
          <div className="flex flex-col items-center justify-center py-8 text-center select-none">
            <div className="mb-2.5">
              <TemiFace size={42} className="text-emerald-400" />
            </div>
            <span className="text-[13px] font-medium text-zinc-200 tracking-tight">
              Autonomous Agent Execution Trace
            </span>
            <p className="mt-1 max-w-[320px] text-[12px] text-zinc-500 leading-relaxed">
              Real-time terminal execution, file explorations, and code edits
            </p>
          </div>
        )}

        {/* 3. Steps List (Exact Gemini IDE design: clean borderless rows) */}
        {chronologicalItems.map((item) => {
          const isExpanded = !!expandedRows[item.id];
          const isFailed = item.status === "failed";

          if (item.type === "cmd") {
            const cmdStr = item.cmd || "command";
            const isTruncated = cmdStr.length > 56;
            const displayCmd = isTruncated && !isExpanded ? `${cmdStr.substring(0, 54)}...` : cmdStr;

            return (
              <div key={item.id} className="group transition-colors">
                <button
                  type="button"
                  onClick={() => toggleRow(item.id)}
                  className="flex w-full items-center justify-between px-2 py-1 text-left text-[13px] text-zinc-400 transition-colors hover:text-white rounded-md"
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="text-zinc-400">Ran</span>
                    <span className="font-semibold text-zinc-200">{displayCmd}</span>
                  </div>
                  <span className="ml-2 flex-shrink-0 text-zinc-400 transition-transform duration-150">
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                </button>

                {isExpanded && (
                  <div className="mt-1 mb-2.5 rounded-lg border border-[#2a2b2e] bg-[#131416] overflow-hidden text-xs font-mono shadow-sm animate-in fade-in duration-150">
                    {/* Clean Terminal Window Header: studio $ <cmd> */}
                    <div className="flex items-center justify-between border-b border-[#222326] bg-[#18191c] px-3.5 py-1.5 text-zinc-400">
                      <div className="flex items-center gap-1.5 text-[12px]">
                        <span className="text-zinc-400">studio</span>
                        <span className="text-zinc-500 font-semibold">$</span>
                        <span className="text-[#fde047] font-medium">{cmdStr}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(item.id, `${cmdStr}\n${item.result || ""}`)}
                        className="flex items-center gap-1 text-[10.5px] text-zinc-400 hover:text-zinc-200 transition-colors"
                        title="Copy command and output"
                      >
                        {copiedId === item.id ? (
                          <Check size={11} className="text-emerald-400" />
                        ) : (
                          <Copy size={11} />
                        )}
                        <span>{copiedId === item.id ? "Copied" : "Copy"}</span>
                      </button>
                    </div>

                    <div className="p-3.5 font-mono space-y-1 text-zinc-300 whitespace-pre-wrap leading-relaxed text-[11.5px]">
                      {item.result ? (
                        <div className={isFailed ? "text-rose-400" : "text-zinc-300"}>
                          {item.result}
                        </div>
                      ) : (
                        <div className="text-zinc-500 italic">No output produced</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          }

          if (item.type === "edit") {
            const filename = item.file ? item.file.split("/").pop() || item.file : "file.ts";

            return (
              <div
                key={item.id}
                onClick={() => {
                  if (item.file) void showFile(item.file);
                }}
                className="group flex items-center justify-between px-2 py-1 text-left text-[13px] text-zinc-400 rounded-md transition-colors hover:bg-zinc-800/40 hover:text-white cursor-pointer"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="text-zinc-400">Edited</span>
                  <AtomIcon size={14} className="text-[#38bdf8]" />
                  <span className="font-medium text-white truncate">{filename}</span>
                  <DiffBadge plus={item.plus} minus={item.minus} />
                </div>
              </div>
            );
          }

          if (item.type === "read") {
            const count = item.count ?? 1;
            const filename = item.file ? item.file.split("/").pop() || item.file : "";
            const lineRange = item.desc?.match(/#L[\d-]+/)?.[0] || item.details?.match(/#L[\d-]+/)?.[0] || "";
            const thoughtNarrative =
              item.desc?.replace(/#L[\d-]+/, "").trim() ||
              item.details?.replace(/#L[\d-]+/, "").trim() ||
              "";

            return (
              <div key={item.id} className="group transition-colors">
                <button
                  type="button"
                  onClick={() => toggleRow(item.id)}
                  className="flex w-full items-center justify-between px-2 py-1 text-left text-[13px] text-zinc-400 transition-colors hover:text-white rounded-md"
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="text-zinc-400">Explored</span>
                    <span className="font-semibold text-zinc-200">
                      {count} {count === 1 ? "file" : "files"}
                    </span>
                  </div>
                  <span className="ml-2 flex-shrink-0 text-zinc-400 transition-transform duration-150">
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                </button>

                {isExpanded && (
                  <div className="pl-5 pt-1 pb-1 space-y-1.5 text-[12.5px] animate-in fade-in duration-150">
                    {/* Analyzed file row */}
                    {filename && (
                      <div className="flex items-center gap-1.5 text-zinc-300">
                        <span className="text-zinc-400">Analyzed</span>
                        <AtomIcon size={14} className="text-[#38bdf8]" />
                        <span className="font-medium text-white">{filename}</span>
                        {lineRange && (
                          <span className="text-zinc-500 font-mono text-[11.5px]">{lineRange}</span>
                        )}
                      </div>
                    )}

                    {/* Thought row */}
                    {thoughtNarrative && (
                      <div className="space-y-1 text-zinc-400">
                        <div
                          onClick={() => toggleThought(item.id)}
                          className="flex items-center gap-1 cursor-pointer text-zinc-400 hover:text-zinc-200 text-xs font-normal select-none"
                        >
                          <span>Thought for 1s</span>
                          {expandedThoughts[item.id] !== false ? (
                            <ChevronDown size={13} />
                          ) : (
                            <ChevronRight size={13} />
                          )}
                        </div>
                        {expandedThoughts[item.id] !== false && (
                          <p className="pl-3.5 text-xs text-zinc-400/90 leading-relaxed">
                            {renderThoughtText(thoughtNarrative)}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          }

          return (
            <div key={item.id} className="flex items-center justify-between px-2 py-1 text-[13px] text-zinc-400">
              <span>{item.desc || item.cmd || item.file || "Execution step"}</span>
              <span className="text-[11px] text-zinc-500">{item.timeLabel}</span>
            </div>
          );
        })}

        {/* 4. Active In-Progress Task (Matches "Working") */}
        {isTaskRunning && (
          <div className="flex items-center gap-2 px-2 py-1 text-[13px] text-zinc-400 font-normal">
            <span>Working</span>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          </div>
        )}

        {/* 5. Pre-review Changes Pills (Matches [⚬] +16 -1 TemiVoiceStage.tsx studio/...) */}
        {changes.length > 0 && (
          <div className="pt-2 space-y-1.5">
            {changes.map((change) => {
              const filename = change.path.split("/").pop() || change.path;
              return (
                <div
                  key={change.path}
                  onClick={() => showFile(change.path)}
                  className="flex items-center gap-2.5 rounded-lg border border-[#2a2b2e] bg-[#1c1d1f] px-3 py-2 text-[12.5px] text-zinc-200 hover:bg-[#242528] cursor-pointer transition-colors"
                >
                  <div className="flex h-4 w-4 items-center justify-center rounded border border-amber-500/70 bg-amber-500/15 text-[8px] text-amber-400 flex-shrink-0">
                    ●
                  </div>
                  <span className="font-mono text-xs flex-shrink-0">
                    <span className="text-[#4ade80] font-semibold">+{change.additions}</span>{" "}
                    <span className="text-[#f87171] font-semibold">-{change.deletions}</span>
                  </span>
                  <span className="font-medium text-white flex-shrink-0">{filename}</span>
                  <span className="truncate text-xs text-zinc-500">{change.path}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* 6. Inline Approval Gate */}
        {pendingApproval && (
          <div className="my-2">
            <SpokenApprovalPrompt pending={pendingApproval} />
          </div>
        )}
      </div>

      {/* ── Bottom Bar: "← 📄 N Files With Changes" & "Reject all" / "Accept all ⌵" ── */}
      <div className="flex h-9 items-center justify-between border-t border-[#26272b] bg-[#161719] px-3.5 text-[12px]">
        <button
          type="button"
          onClick={handleReviewClick}
          className="group flex items-center gap-1.5 text-zinc-300 hover:text-white transition-colors text-[11.5px]"
        >
          <span className="text-zinc-400 transition-transform group-hover:-translate-x-0.5 text-xs">←</span>
          <span className="text-sm leading-none">📄</span>
          <span className="font-medium text-zinc-200">
            {changes.length} {changes.length === 1 ? "File" : "Files"} With Changes
          </span>
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void useChangeStore.getState().rejectAll()}
            disabled={changes.length === 0}
            className="text-zinc-400 hover:text-zinc-200 text-[11px] font-medium transition-colors disabled:opacity-40 disabled:hover:text-zinc-400 px-2 py-0.5"
          >
            Reject all
          </button>
          <button
            type="button"
            onClick={() => useChangeStore.getState().acceptAll()}
            disabled={changes.length === 0}
            className="flex items-center gap-1 rounded-md bg-emerald-500 hover:bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <span>Accept all</span>
            <ChevronDown size={12} />
          </button>
        </div>
      </div>
    </div>
  );
};

export const CliStreamingPanel: React.FC<CliStreamingPanelProps> = (props) => {
  const isPanelExpanded = useAssistantActivityStore((state) => state.isPanelExpanded);
  if (!isPanelExpanded) return null;
  return <CliStreamingBody {...props} />;
};
