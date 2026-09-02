import React, { useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { CursorMarkdownRenderer } from "./CursorMarkdownRenderer";
import { FileActionCard } from "./FileActionCard";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { WorkTimeline } from "./WorkTimeline";
import { AttachmentStrip } from "./AttachmentStrip";
import { segment } from "../../utils/segment";
import type { ChatMessage } from "../../types";
import type { Attachment } from "../../services/fileService";

/**
 * One turn, rendered.
 *
 * Shared by the main conversation and by side chats so a improvement to how a
 * reply reads lands in both at once — the two surfaces differ in width and
 * density, never in what a message is.
 */

const SHELL_LANGUAGES = new Set(["bash", "sh", "zsh", "shell", "console"]);

/**
 * Messages carry an already-formatted clock string, but older persisted rows
 * hold an ISO date. Render whichever we were given rather than showing
 * "Invalid Date" for one of the two.
 */
function clockOf(timestamp: string): string {
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  if (!Number.isNaN(parsed.getTime()) && /\d{4}-\d{2}-\d{2}/.test(timestamp)) {
    return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return timestamp;
}

export const MessageBlock: React.FC<{
  message: ChatMessage;
  previousRole?: "user" | "assistant" | "system" | null;
  onJumpToFile: (path: string, code: string) => void;
  onRun: () => void;
  onStop?: () => void;
  onRetry?: () => void;
  /** `compact` tightens spacing for the narrow side-chat column. */
  density?: "comfortable" | "compact";
}> = ({ message, previousRole, onJumpToFile, onRun, onStop, onRetry, density = "comfortable" }) => {
  const compact = density === "compact";
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard blocked; the text is still selectable. */
    }
  };

  if (message.role === "user") {
    return (
      /* Cursor's user turn fills the reading column. It is not a right-aligned
         chat bubble and it is not capped at a fraction of the width — it is a
         full-width card that happens to be lighter than the canvas, which is
         what keeps a long prompt from ragging into a narrow ribbon down the
         right-hand side. #212121 behind a flat #313131 hairline, 12px corner. */
      <div className={compact ? "pt-3 pb-2" : "pt-1 pb-4"}>
        <div className={`lit w-full rounded-xl bg-surface whitespace-pre-wrap break-words ${compact ? "px-3 py-2 text-xs" : "px-3.5 py-2.5 text-md"} text-ink-bright`}>
          {message.content}
        </div>
      </div>
    );
  }

  const segments = segment(message.content);
  const calls = message.toolCalls ?? [];
  const runningCall = calls.find((call) => call.status === "running");
  // Nothing written yet and nothing to show: the turn is still in its opening
  // gap, which is exactly where an empty bubble reads as a hung app.
  const awaitingFirstToken = Boolean(message.isStreaming) && !message.content.trim();

  return (
    <div className={`group/turn flex flex-col ${compact ? "gap-2 pb-2" : "gap-3 pb-4"}`}>
      {calls.length > 0 && <WorkTimeline calls={calls} />}

      {(awaitingFirstToken || message.isStreaming) && (
        <ThinkingIndicator
          active
          charCount={message.content.length}
          toolLabel={runningCall ? runningCall.name : null}
          onStop={onStop}
        />
      )}

      {segments.map((piece, index) =>
        piece.kind === "prose" ? (
          <div key={index} className={`${compact ? "text-xs" : "text-md"} text-ink-prose leading-relaxed markdown-body`}>
            <CursorMarkdownRenderer content={piece.text} />
          </div>
        ) : (
          <FileActionCard
            key={index}
            title={piece.filename ?? piece.language ?? "code"}
            code={piece.text}
            language={piece.language}
            runnable={SHELL_LANGUAGES.has(piece.language ?? "")}
            onJumpToFile={piece.filename ? () => onJumpToFile(piece.filename as string, piece.text) : undefined}
            onRun={SHELL_LANGUAGES.has(piece.language ?? "") ? onRun : undefined}
          />
        ),
      )}

      {message.isStreaming && message.content.trim() && (
        <span className="inline-block w-1.5 h-4 bg-ink-code animate-caret" />
      )}

      {!message.isStreaming && message.content && (
        <div className="flex items-center gap-3 font-mono text-2xs pt-0.5">
            <span className="text-ink-soft">{clockOf(message.timestamp)}</span>
            {typeof message.tokensCount === "number" && message.tokensCount > 0 && (
              <span className="flex items-center gap-1.5 text-ink-muted bg-surface-chip rounded-lg px-2 py-1">
                {message.tokensCount} tokens
              </span>
            )}
            <span className="text-ink-soft">{message.costLabel ?? "$0.00 local"}</span>
            {typeof message.durationSec === "number" && message.durationSec > 0 && (
              <span className="text-ink-disabled">{message.durationSec.toFixed(1)}s</span>
            )}

            <span className="flex-1" />

            {/* Actions stay hidden until the turn is hovered: they are useful
                but they are not what you are reading. */}
            <span className="flex items-center gap-1 opacity-0 group-hover/turn:opacity-100 focus-within:opacity-100 transition-opacity duration-ds ease-ds">
              <button
                type="button"
                onClick={copy}
                title="Copy reply"
                className="w-6 h-6 flex items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink-high transition-colors duration-ds ease-ds"
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </button>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  title="Ask again"
                  className="w-6 h-6 flex items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink-high transition-colors duration-ds ease-ds"
                >
                  <RotateCcw size={12} />
                </button>
              )}
            </span>
        </div>
      )}
    </div>
  );
};
