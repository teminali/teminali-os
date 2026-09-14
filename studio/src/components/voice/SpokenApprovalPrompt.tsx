import React, { useEffect, useState } from "react";
import { Check, Copy, CornerDownLeft, Mic, ShieldAlert, Terminal, Wrench } from "lucide-react";
import type { PendingApproval } from "../../store/approvalStore";

interface SpokenApprovalPromptProps {
  pending: PendingApproval;
  compact?: boolean;
  className?: string;
}

export const SpokenApprovalPrompt: React.FC<SpokenApprovalPromptProps> = ({
  pending,
  compact = false,
  className = "",
}) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // If user is inside an input, textarea or contentEditable, respect text editing unless it's Escape
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
          pending.answer("allow", false);
        } else if (event.key === "n" || event.key === "N") {
          event.preventDefault();
          pending.answer("deny", false);
        } else if ((event.key === "a" || event.key === "A") && pending.alwaysLabel) {
          event.preventDefault();
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
    pending.source === "agent" && !pending.action.includes(" ");

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-modal="false"
      aria-label={`Permission requested: ${pending.action}`}
      data-approval-banner="true"
      className={`relative overflow-hidden rounded-2xl border border-amber-500/40 bg-gradient-to-b from-[#1f1b15]/98 via-[#181614]/98 to-[#100f0d]/98 p-3.5 text-zinc-100 shadow-[0_12px_36px_-4px_rgba(245,158,11,0.3),0_2px_8px_rgba(0,0,0,0.8)] backdrop-blur-xl transition-all animate-in fade-in slide-in-from-bottom-2 ${className}`}
    >
      {/* Top ambient gold glow streak */}
      <div className="pointer-events-none absolute -top-10 left-1/4 h-20 w-1/2 rounded-full bg-amber-500/15 blur-2xl" />

      {/* Header bar */}
      <div className="flex items-center justify-between gap-2.5 pb-2">
        <div className="flex items-center gap-2">
          <div className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-amber-500/20 border border-amber-500/30">
            <ShieldAlert size={14} className="text-amber-400" />
            <span className="absolute -inset-0.5 rounded-lg bg-amber-400/20 blur-[3px] animate-pulse" />
          </div>
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-[12.5px] font-semibold tracking-tight text-amber-200">
              {pending.asker || "Assistant"}
            </span>
            <span className="text-[11.5px] text-zinc-400">
              needs permission
            </span>
          </div>
        </div>

        {/* Live voice indicator badge */}
        <div
          className="flex items-center gap-1.5 rounded-full bg-amber-400/10 border border-amber-400/25 px-2.5 py-0.5 text-[10px] font-medium text-amber-300 select-none shadow-sm"
          title="Microphone is listening for your spoken command"
        >
          <Mic size={10} className="text-amber-400 animate-pulse" />
          <span className="hidden sm:inline text-zinc-400">Voice:</span>
          <span>
            <strong className="text-amber-200 font-semibold">"allow"</strong> ·{" "}
            {pending.alwaysLabel && <strong className="text-amber-200 font-semibold">"always"</strong>}
            {pending.alwaysLabel && " · "}
            <strong className="text-zinc-300 font-semibold">"refuse"</strong>
          </span>
        </div>
      </div>

      {/* Command / Action block */}
      <div className="group relative my-1 flex items-start justify-between gap-2 rounded-xl border border-amber-500/20 bg-black/65 p-2.5 font-mono text-[11.5px] text-amber-100 shadow-inner">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          {isTool ? (
            <Wrench size={13} className="mt-0.5 flex-shrink-0 text-amber-400/80" />
          ) : (
            <Terminal size={13} className="mt-0.5 flex-shrink-0 text-amber-400/80" />
          )}
          <span className="break-all select-all leading-relaxed">{pending.action}</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex-shrink-0 rounded-md p-1 text-zinc-400 hover:bg-white/10 hover:text-white transition-colors"
          title="Copy command to clipboard"
          aria-label="Copy command"
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
        </button>
      </div>

      {/* Bottom action buttons */}
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => pending.answer("allow", false)}
          className="group flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 active:bg-amber-600 px-3.5 py-1.5 text-[12px] font-semibold text-black transition-all shadow-[0_2px_8px_rgba(245,158,11,0.35)]"
        >
          <span>Allow</span>
          <kbd className="rounded bg-black/20 px-1 py-0.2 text-[9.5px] font-mono font-medium text-black/80">
            ↵ / Y
          </kbd>
        </button>

        {pending.alwaysLabel && (
          <button
            type="button"
            onClick={() => pending.answer("allow", true)}
            className="group flex items-center gap-1.5 rounded-lg border border-amber-500/35 bg-amber-500/15 hover:bg-amber-500/25 px-3 py-1.5 text-[12px] font-medium text-amber-200 transition-colors shadow-sm"
            title={`Always allow ${pending.alwaysLabel} for this run`}
          >
            <span>Always Allow</span>
            <span className="max-w-[80px] truncate text-[10.5px] text-amber-300/70">
              ({pending.alwaysLabel})
            </span>
            <kbd className="rounded bg-amber-500/20 px-1 py-0.2 text-[9.5px] font-mono text-amber-200">
              A
            </kbd>
          </button>
        )}

        <button
          type="button"
          onClick={() => pending.answer("deny", false)}
          className="flex items-center gap-1.5 rounded-lg border border-transparent hover:border-red-500/30 hover:bg-red-500/15 px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:text-red-300 transition-colors"
        >
          <span>Refuse</span>
          <kbd className="rounded bg-white/10 px-1 py-0.2 text-[9.5px] font-mono text-zinc-400">
            Esc / N
          </kbd>
        </button>
      </div>
    </div>
  );
};
