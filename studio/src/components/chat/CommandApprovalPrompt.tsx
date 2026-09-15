import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, Mic, ShieldAlert, Terminal, Wrench } from "lucide-react";
import { describeApprovalAction, type AgentCommandRequest } from "../../services/agentCommands";

interface CommandApprovalPromptProps {
  request: AgentCommandRequest | null;
  onApprove: (remember?: boolean) => void;
  onDeny: () => void;
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
      className="relative mx-3 mb-2 flex flex-col gap-2 rounded-lg border border-[#2d2d2d] bg-[#181818]/95 p-2.5 text-xs text-[#ececec] shadow-lg backdrop-blur-md transition-all"
    >
      {/* Top row: Label & Voice Hint */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="flex h-4 w-4 items-center justify-center text-amber-400">
            <ShieldAlert size={13} />
          </span>
          <span className="font-medium text-zinc-200">
            {isTool ? "Permission requested for tool" : "Permission requested for command"}
          </span>
        </div>

        {listening && (
          <div
            className="flex items-center gap-1 rounded bg-[#222] border border-[#333] px-2 py-0.5 text-[10px] text-zinc-400 select-none"
            title="Microphone is listening for your spoken command"
          >
            <Mic size={9} className="text-amber-400 animate-pulse" />
            <span className="text-zinc-500">Voice:</span>
            <span className="text-zinc-300 font-medium">"yes"</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-400">"no"</span>
          </div>
        )}
      </div>

      {/* Command snippet */}
      <div className="group flex items-center justify-between gap-2 rounded border border-[#262626] bg-[#111] px-2 py-1 font-mono text-[11px] text-zinc-200">
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
          {isTool ? (
            <Wrench size={11} className="flex-shrink-0 text-zinc-400" />
          ) : (
            <Terminal size={11} className="flex-shrink-0 text-zinc-400" />
          )}
          <div className="truncate select-all text-zinc-200">
            {isTool && action.server && <span className="text-zinc-500">{action.server} › </span>}
            {action.label}
          </div>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex-shrink-0 text-zinc-500 hover:text-zinc-200 transition-colors p-0.5"
          title="Copy command to clipboard"
          aria-label="Copy command"
        >
          {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
        </button>
      </div>

      {/* Buttons */}
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={onDeny}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-zinc-400 hover:bg-[#252525] hover:text-zinc-200 transition-colors"
        >
          <span>Don't allow</span>
          <kbd className="text-[9px] font-mono opacity-60">Esc</kbd>
        </button>

        <button
          type="button"
          onClick={() => onApprove(true)}
          title={`Allow this and every later ${action.scope} for the rest of this session`}
          className="flex items-center gap-1 rounded border border-[#333] bg-[#222] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:bg-[#2a2a2a] hover:text-white transition-colors"
        >
          <span>Always</span>
          <kbd className="text-[9px] font-mono text-zinc-400">A</kbd>
        </button>

        <button
          ref={runRef}
          type="button"
          onClick={() => onApprove(false)}
          className="flex items-center gap-1 rounded bg-[#00bf63] hover:bg-[#00d66f] active:bg-[#00a855] px-2.5 py-1 text-[11px] font-semibold text-black transition-colors"
        >
          <span>{isTool ? "Allow" : "Run"}</span>
          <kbd className="text-[9px] font-mono text-black/70">↵</kbd>
        </button>
      </div>
    </div>
  );
};
