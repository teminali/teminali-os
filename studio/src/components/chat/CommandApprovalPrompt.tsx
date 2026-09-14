import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, CornerDownLeft, Mic, ShieldAlert, Terminal, Wrench } from "lucide-react";
import { describeApprovalAction, type AgentCommandRequest } from "../../services/agentCommands";

interface CommandApprovalPromptProps {
  request: AgentCommandRequest | null;
  /** `remember` allows every later command with the same executable. */
  onApprove: (remember?: boolean) => void;
  onDeny: () => void;
  /** The assistant has read this out and is listening for "yes" — say so, so
   *  the operator knows the words are live as well as the buttons. */
  listening?: boolean;
}

export const CommandApprovalPrompt: React.FC<CommandApprovalPromptProps> = ({
  request,
  onApprove,
  onDeny,
  listening = false,
}) => {
  const runRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (request) runRef.current?.focus();
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditingText =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (event.key === "Escape") {
        event.preventDefault();
        onDeny();
      } else if (event.key === "Enter" && !event.shiftKey && !isEditingText) {
        event.preventDefault();
        onApprove(event.metaKey || event.altKey);
      } else if (!isEditingText) {
        if (event.key === "y" || event.key === "Y") {
          event.preventDefault();
          onApprove(false);
        } else if (event.key === "n" || event.key === "N") {
          event.preventDefault();
          onDeny();
        } else if (event.key === "a" || event.key === "A") {
          event.preventDefault();
          onApprove(true);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [request, onApprove, onDeny]);

  if (!request) return null;

  const action = describeApprovalAction(request.command);
  const isTool = action.kind === "tool";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(request.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label={`Approve: ${request.command}`}
      data-approval-banner="true"
      className="relative mx-3 mb-2 overflow-hidden rounded-2xl border border-amber-500/40 bg-gradient-to-b from-[#1f1b15]/98 via-[#181614]/98 to-[#100f0d]/98 p-3 text-zinc-100 shadow-[0_12px_36px_-4px_rgba(245,158,11,0.3),0_2px_8px_rgba(0,0,0,0.8)] backdrop-blur-xl transition-all animate-in fade-in slide-in-from-bottom-2"
    >
      {/* Top ambient gold glow */}
      <div className="pointer-events-none absolute -top-10 left-1/4 h-20 w-1/2 rounded-full bg-amber-500/15 blur-2xl" />

      {/* Header Bar */}
      <div className="flex items-center justify-between gap-2.5 pb-2 border-b border-amber-500/20">
        <div className="flex items-center gap-2">
          <div className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-amber-500/20 border border-amber-500/30">
            <ShieldAlert size={13} className="text-amber-400" />
            <span className="absolute -inset-0.5 rounded-lg bg-amber-400/20 blur-[3px] animate-pulse" />
          </div>
          <span className="text-[12.5px] font-semibold text-amber-200">
            {isTool ? "Permission requested for tool" : "Permission requested for command"}
          </span>
        </div>

        {listening && (
          <div
            className="flex items-center gap-1.5 rounded-full bg-amber-400/10 border border-amber-400/25 px-2.5 py-0.5 text-[10px] font-medium text-amber-300 select-none shadow-sm"
            title="Microphone is listening for your spoken command"
          >
            <Mic size={10} className="text-amber-400 animate-pulse" />
            <span className="hidden sm:inline text-zinc-400">Voice:</span>
            <span>
              <strong className="text-amber-200 font-semibold">"yes"</strong> ·{" "}
              <strong className="text-amber-200 font-semibold">"always"</strong> ·{" "}
              <strong className="text-zinc-300 font-semibold">"no"</strong>
            </span>
          </div>
        )}
      </div>

      {/* Command Preview Container with Copy Button */}
      <div className="group relative my-2.5 flex items-start justify-between gap-2 rounded-xl border border-amber-500/20 bg-black/65 p-2.5 font-mono text-[11.5px] text-amber-100 shadow-inner">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          {isTool ? (
            <Wrench size={13} className="mt-0.5 flex-shrink-0 text-amber-400/80" />
          ) : (
            <Terminal size={13} className="mt-0.5 flex-shrink-0 text-amber-400/80" />
          )}
          <div className="min-w-0 flex-1">
            <div className="break-all select-all leading-relaxed">
              {isTool && action.server && <span className="text-zinc-500">{action.server} › </span>}
              {action.label}
            </div>
            {request.reason && (
              <div className="mt-1 text-[11px] font-sans text-amber-300/70">{request.reason}</div>
            )}
          </div>
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

      {/* Interactive Action Buttons with Keyboard Badges */}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2 pt-0.5">
        <button
          ref={runRef}
          type="button"
          onClick={() => onApprove(false)}
          className="group flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 active:bg-amber-600 px-3.5 py-1.5 text-[12px] font-semibold text-black transition-all shadow-[0_2px_8px_rgba(245,158,11,0.35)]"
        >
          <span>{isTool ? "Allow" : "Run"}</span>
          <kbd className="rounded bg-black/20 px-1 py-0.2 text-[9.5px] font-mono font-medium text-black/80">
            ↵ / Y
          </kbd>
        </button>

        <button
          type="button"
          onClick={() => onApprove(true)}
          title={`Allow this and every later ${action.scope} for the rest of this session`}
          className="group flex items-center gap-1.5 rounded-lg border border-amber-500/35 bg-amber-500/15 hover:bg-amber-500/25 px-3 py-1.5 text-[12px] font-medium text-amber-200 transition-colors shadow-sm"
        >
          <span>Always</span>
          <span className="max-w-[90px] truncate text-[10.5px] text-amber-300/70">
            ({action.scope})
          </span>
          <kbd className="rounded bg-amber-500/20 px-1 py-0.2 text-[9.5px] font-mono text-amber-200">
            A
          </kbd>
        </button>

        <button
          type="button"
          onClick={onDeny}
          className="flex items-center gap-1.5 rounded-lg border border-transparent hover:border-red-500/30 hover:bg-red-500/15 px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:text-red-300 transition-colors"
        >
          <span>Don't allow</span>
          <kbd className="rounded bg-white/10 px-1 py-0.2 text-[9.5px] font-mono text-zinc-400">
            Esc / N
          </kbd>
        </button>
      </div>
    </div>
  );
};
