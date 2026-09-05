import React, { useEffect, useRef } from "react";
import { CornerDownLeft } from "lucide-react";
import { commandHead, type AgentCommandRequest } from "../../services/agentCommands";

interface CommandApprovalPromptProps {
  request: AgentCommandRequest | null;
  /** `remember` allows every later command with the same executable. */
  onApprove: (remember?: boolean) => void;
  onDeny: () => void;
}

/**
 * One-line approval for a state-changing command.
 *
 * Deliberately compact: it appears mid-conversation, so it announces the command
 * and gets out of the way. Read-only checks never reach it and blocked commands
 * never run at all, so the only question here is "run this one?".
 */
export const CommandApprovalPrompt: React.FC<CommandApprovalPromptProps> = ({ request, onApprove, onDeny }) => {
  const runRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (request) runRef.current?.focus();
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDeny();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        // Shift is taken by the composer's newline, so the modifier for
        // "and stop asking" is the one that is free.
        onApprove(event.metaKey || event.altKey);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request, onApprove, onDeny]);

  if (!request) return null;

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label={`Run command: ${request.command}`}
      title={request.reason}
      className="mx-3 mb-1.5 flex items-center gap-2 h-8 pl-2 pr-1.5 rounded-lg bg-warning/[0.07] border border-warning/25 text-2xs"
    >
      <span aria-hidden="true" className="text-warning/70 font-mono flex-shrink-0 select-none">$</span>

      <code className="flex-1 min-w-0 truncate font-mono text-ink-high" title={request.command}>
        {request.command}
      </code>

      <button
        ref={runRef}
        type="button"
        onClick={() => onApprove(false)}
        className="flex items-center gap-1 px-2 h-6 rounded-md bg-success/15 text-success font-semibold hover:bg-success/25 focus-visible:outline focus-visible:outline-1 focus-visible:outline-success transition-colors flex-shrink-0"
      >
        Run <CornerDownLeft size={9} className="opacity-60" />
      </button>

      {/* Approving the same executable repeatedly is the friction that makes
          people turn the gate off altogether. The unit is the executable, so
          "always" covers `open -a Safari` after `open -a VLC` and still stops
          at `rm`. */}
      <button
        type="button"
        onClick={() => onApprove(true)}
        title={`Run this and every later ${commandHead(request.command)} command this session`}
        className="px-2 h-6 rounded-md text-ink-muted font-semibold hover:bg-surface-hover hover:text-ink-high focus-visible:outline focus-visible:outline-1 focus-visible:outline-edge-popover transition-colors flex-shrink-0"
      >
        Always {commandHead(request.command)}
      </button>

      <button
        type="button"
        onClick={onDeny}
        className="px-2 h-6 rounded-md text-ink-muted font-semibold hover:bg-surface-hover hover:text-ink-high focus-visible:outline focus-visible:outline-1 focus-visible:outline-edge-popover transition-colors flex-shrink-0"
      >
        Skip
      </button>
    </div>
  );
};
