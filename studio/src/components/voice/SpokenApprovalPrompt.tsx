import React, { useEffect, useState } from "react";
import { Check, Copy, Mic, ShieldAlert, Terminal, Wrench } from "lucide-react";
import type { PendingApproval } from "../../store/approvalStore";

interface SpokenApprovalPromptProps {
  pending: PendingApproval;
  compact?: boolean;
  className?: string;
}

export const SpokenApprovalPrompt: React.FC<SpokenApprovalPromptProps> = ({
  pending,
  className = "",
}) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditingText =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        pending.answer("deny", false);
      } else if (event.key === "Enter" && !isEditingText) {
        event.preventDefault();
        event.stopPropagation();
        pending.answer("allow", (event.altKey || event.metaKey) && Boolean(pending.alwaysLabel));
      } else if (!isEditingText) {
        if (event.key === "y" || event.key === "Y") {
          event.preventDefault();
          event.stopPropagation();
          pending.answer("allow", false);
        } else if (event.key === "n" || event.key === "N") {
          event.preventDefault();
          event.stopPropagation();
          pending.answer("deny", false);
        } else if ((event.key === "a" || event.key === "A") && pending.alwaysLabel) {
          event.preventDefault();
          event.stopPropagation();
          pending.answer("allow", true);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [pending]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(pending.action);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const isTool =
    pending.action.startsWith("mcp__") ||
    pending.action.includes("__") ||
    (pending.source === "agent" && !pending.action.includes(" "));

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label={`Permission requested: ${pending.action}`}
      data-approval-banner="true"
      className={`relative flex flex-col gap-2 rounded-lg border border-[#2d2d2d] bg-[#181818]/95 p-2.5 text-xs text-[#ececec] shadow-lg backdrop-blur-md transition-all ${className}`}
    >
      {/* Top row: Label & Voice Hint */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="flex h-4 w-4 items-center justify-center text-amber-400">
            <ShieldAlert size={13} />
          </span>
          <span className="font-medium text-zinc-200 truncate">
            {pending.asker || "Assistant"}
          </span>
          <span className="text-[11px] text-zinc-400">needs permission</span>
        </div>

        {/* Voice indicator badge */}
        <div
          className="flex items-center gap-1 rounded bg-[#222] border border-[#333] px-2 py-0.5 text-[10px] text-zinc-400 select-none"
          title="Microphone is listening for your approval"
        >
          <Mic size={9} className="text-amber-400 animate-pulse" />
          <span className="text-zinc-500">Voice:</span>
          <span className="text-zinc-300 font-medium">"allow"</span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-400">"refuse"</span>
        </div>
      </div>

      {/* Middle row: Command block */}
      <div className="group flex items-center justify-between gap-2 rounded border border-[#262626] bg-[#111] px-2 py-1 font-mono text-[11px] text-zinc-200">
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
          {isTool ? (
            <Wrench size={11} className="flex-shrink-0 text-zinc-400" />
          ) : (
            <Terminal size={11} className="flex-shrink-0 text-zinc-400" />
          )}
          <span className="truncate select-all text-zinc-200">{pending.action}</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex-shrink-0 text-zinc-500 hover:text-zinc-200 transition-colors p-0.5"
          title="Copy command"
          aria-label="Copy command"
        >
          {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
        </button>
      </div>

      {/* Bottom row: Compact Cursor-style action buttons */}
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={() => pending.answer("deny", false)}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-zinc-400 hover:bg-[#252525] hover:text-zinc-200 transition-colors"
        >
          <span>Refuse</span>
          <kbd className="text-[9px] font-mono opacity-60">Esc</kbd>
        </button>

        {pending.alwaysLabel && (
          <button
            type="button"
            onClick={() => pending.answer("allow", true)}
            className="flex items-center gap-1 rounded border border-[#333] bg-[#222] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:bg-[#2a2a2a] hover:text-white transition-colors"
            title={`Always allow ${pending.alwaysLabel} for this run`}
          >
            <span>Always</span>
            <kbd className="text-[9px] font-mono text-zinc-400">A</kbd>
          </button>
        )}

        <button
          type="button"
          onClick={() => pending.answer("allow", false)}
          className="flex items-center gap-1 rounded bg-[#00bf63] hover:bg-[#00d66f] active:bg-[#00a855] px-2.5 py-1 text-[11px] font-semibold text-black transition-colors"
        >
          <span>Allow</span>
          <kbd className="text-[9px] font-mono text-black/70">↵</kbd>
        </button>
      </div>
    </div>
  );
};
