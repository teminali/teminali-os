import React, { useEffect, useRef } from "react";
import { CornerDownLeft, Mic, ShieldAlert, Terminal, Wrench } from "lucide-react";
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

/**
 * The approval for a state-changing command or tool call.
 *
 * It used to be one 32-pixel row: a `$`, the command truncated to whatever was
 * left, and three buttons. That worked while every request was a short shell
 * command and stopped working the moment agent tool calls came through it. The
 * "always" button carried the first word of the request, which for
 * `mcp__teminali-workspace__recent_projects` is the whole name — so the button
 * grew to the width of the row and pushed *Skip off the end of it*. The
 * operator was left with a prompt they could see, could approve, and could not
 * refuse without reaching for the keyboard.
 *
 * So the layout is now three bands rather than one row, and nothing in it
 * competes for horizontal space with anything else:
 *
 * - **who and what kind**, with the voice hint parked on the right;
 * - **the request itself**, given the full width and allowed two lines of it,
 *   because the operator is being asked to judge this text and truncating it
 *   is the one thing that makes that impossible. A tool call is shown as its
 *   server and its tool — which server is asking is most of what makes a tool
 *   judgeable — and a shell command keeps its monospace. The `$` sigil is
 *   gone: it said "shell" on a row that is now often a tool call, and an icon
 *   says which of the two this is without spending a character of the line;
 * - **the answers**, in a fixed order with fixed labels. "Always allow" is
 *   those two words whatever the request is; the scope rides after it as muted
 *   text that truncates, so no request can ever again make a button too wide
 *   for the one beside it.
 *
 * The keyboard contract is unchanged — Enter runs, ⌘/⌥Enter remembers, Escape
 * refuses — and so is the rule that the buttons are never replaced by the
 * spoken path: `listening` only says a second door is open.
 */
export const CommandApprovalPrompt: React.FC<CommandApprovalPromptProps> = ({ request, onApprove, onDeny, listening = false }) => {
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

  const action = describeApprovalAction(request.command);
  const isTool = action.kind === "tool";

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label={`Approve: ${request.command}`}
      className="mx-3 mb-1.5 rounded-lg bg-surface-chip border border-warning/25 overflow-hidden"
    >
      <div className="flex items-center gap-2 px-2.5 h-7 text-2xs border-b border-edge-popover">
        <ShieldAlert size={11} className="text-warning flex-shrink-0" />
        <span className="text-ink-high truncate">
          {isTool ? "Waiting on you to allow a tool" : "Waiting on you to run a command"}
        </span>
        <span className="flex-1" />
        {listening && (
          <span className="flex items-center gap-1 text-ink-muted flex-shrink-0" title={'Say "yes", "always", or "no"'}>
            <Mic size={9} className="opacity-70" />
            say yes
          </span>
        )}
      </div>

      <div className="flex items-start gap-2 px-2.5 py-2">
        {isTool
          ? <Wrench size={11} className="text-ink-muted flex-shrink-0 mt-[3px]" />
          : <Terminal size={11} className="text-ink-muted flex-shrink-0 mt-[3px]" />}
        <div className="min-w-0 flex-1">
          <div className="font-mono text-2xs text-ink-high break-all line-clamp-2" title={request.command}>
            {isTool && action.server && <span className="text-ink-muted">{action.server} › </span>}
            {action.label}
          </div>
          {request.reason && (
            <div className="mt-0.5 text-2xs text-ink-muted line-clamp-2">{request.reason}</div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 px-2.5 pb-2">
        <button
          ref={runRef}
          type="button"
          onClick={() => onApprove(false)}
          className="flex items-center gap-1 px-2.5 h-6 rounded-md text-2xs bg-success/15 text-success font-semibold hover:bg-success/25 focus-visible:outline focus-visible:outline-1 focus-visible:outline-success transition-colors flex-shrink-0"
        >
          {isTool ? "Allow" : "Run"} <CornerDownLeft size={9} className="opacity-60" />
        </button>

        {/* Approving the same thing over and over is the friction that makes
            people turn the gate off altogether. The label is fixed; only the
            scope after it can grow, and it truncates rather than pushing. */}
        <button
          type="button"
          onClick={() => onApprove(true)}
          title={`Allow this and every later ${action.scope} for the rest of this session`}
          className="min-w-0 flex items-baseline gap-1 px-2.5 h-6 rounded-md text-2xs text-ink-muted font-semibold hover:bg-surface-hover hover:text-ink-high focus-visible:outline focus-visible:outline-1 focus-visible:outline-edge-popover transition-colors"
        >
          <span className="flex-shrink-0">Always</span>
          <span className="truncate font-mono font-normal text-ink-disabled">{action.scope}</span>
        </button>

        <span className="flex-1" />

        <button
          type="button"
          onClick={onDeny}
          className="px-2.5 h-6 rounded-md text-2xs text-ink-muted font-semibold hover:bg-surface-hover hover:text-warning focus-visible:outline focus-visible:outline-1 focus-visible:outline-edge-popover transition-colors flex-shrink-0"
        >
          Skip
        </button>
      </div>
    </div>
  );
};
