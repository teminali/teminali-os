import React, { useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { CursorMarkdownRenderer } from "./CursorMarkdownRenderer";
import { FileActionCard } from "./FileActionCard";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { WorkTimeline } from "./WorkTimeline";
import { ProcessWatcher } from "./ProcessWatcher";
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
      /* User turn: clean, rounded full-width card with subtle border highlight */
      <div className={compact ? "pt-3 pb-2" : "pt-1 pb-4"}>
        <div className={`lit w-full rounded-2xl border border-white/10 bg-gradient-to-br from-surface to-surface-sunken whitespace-pre-wrap break-words shadow-sm ${compact ? "px-3 py-2 text-xs" : "px-4 py-3 text-md"} text-ink-bright`}>
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
      {/* The Watcher & Stepwise Process Inspector (Antigravity Style) */}
      {(calls.length > 0 || message.isStreaming) && (
        <ProcessWatcher
          engine={message.engineUsed}
          mode={message.mode}
          toolCalls={calls}
          isStreaming={message.isStreaming}
          charCount={message.content.length}
          tokensCount={message.tokensCount}
          durationSec={message.durationSec}
          onJumpToFile={onJumpToFile}
          compact={compact}
        />
      )}

      {/* Fallback compact timeline if finished with calls */}
      {!message.isStreaming && calls.length > 0 && false && <WorkTimeline calls={calls} />}

      {(awaitingFirstToken || (message.isStreaming && calls.length === 0)) && (
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
        <span className="inline-block w-2 h-4 ml-1 rounded-sm bg-gradient-to-t from-cyan-400 via-sky-300 to-purple-400 shadow-[0_0_10px_rgba(56,189,248,0.8)] animate-pulse" />
      )}

      {!message.isStreaming && message.content && (
        <div className="flex items-center gap-2.5 font-mono text-2xs pt-1 border-t border-edge/30">
            <span className="text-ink-soft">{clockOf(message.timestamp)}</span>
            {message.engineUsed && (
              <span className="px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 text-3xs font-semibold uppercase tracking-wider">
                {message.engineUsed}
              </span>
            )}
            {typeof message.tokensCount === "number" && message.tokensCount > 0 && (
              <span className="flex items-center gap-1 text-ink-muted bg-surface-chip rounded-md px-2 py-0.5 border border-edge/40">
                ⚡ {message.tokensCount.toLocaleString()} tokens
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
