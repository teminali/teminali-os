import React, { useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { CursorMarkdownRenderer } from "./CursorMarkdownRenderer";
import { FileActionCard } from "./FileActionCard";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ProcessWatcher } from "./ProcessWatcher";
import { segment } from "../../utils/segment";
import type { ChatMessage } from "../../types";

/**
 * One turn, rendered.
 *
 * Shared by the main conversation and by side chats so an improvement to how a
 * reply reads lands in both at once — the two surfaces differ in width and
 * density, never in what a message is.
 *
 * The reading order is fixed and deliberate: what it did (the process strip),
 * then what it said (prose and code), then — only when you hover it — what it
 * cost. Telemetry used to sit under every reply at full contrast, six fields
 * wide; it is real, and it is not what anyone is reading.
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
  onJumpToFile: (path: string, code: string) => void;
  onRun: () => void;
  onStop?: () => void;
  onRetry?: () => void;
  /** `compact` tightens spacing for the narrow side-chat column. */
  density?: "comfortable" | "compact";
}> = ({ message, onJumpToFile, onRun, onStop, onRetry, density = "comfortable" }) => {
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
      /* The prompt, quoted back. A filled box one step off the canvas with a
         flat hairline — the same object as the composer it was typed into, so
         the eye reads "this is mine" without a label saying so. Its ink is
         `--text-dim`, not white: what you asked is context for the answer, and
         the answer is the thing to read. */
      <div className={compact ? "pt-2.5 pb-2" : "pt-4 pb-3"}>
        <div
          className={`w-full rounded-lg bg-surface/70 border border-edge/60 whitespace-pre-wrap break-words text-ink-dim ${
            compact ? "px-2.5 py-2 text-xs" : "px-3 py-2.5 text-sm"
          } leading-relaxed`}
        >
          {message.content}
        </div>
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1.5">
            {message.images.map((image, index) => (
              <img
                key={index}
                src={image.startsWith("data:") ? image : `data:image/png;base64,${image}`}
                alt=""
                className="h-14 w-auto rounded-md border border-edge/60 object-cover"
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const segments = segment(message.content);
  const calls = message.toolCalls ?? [];
  const runningCall = calls.find((call) => call.status === "running");
  const settled = !message.isStreaming;

  return (
    <div className={`group/turn flex flex-col ${compact ? "gap-1.5 pb-2" : "gap-2 pb-3"}`}>
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

      {/* Only when there is no process strip to carry the liveness — two live
          timers ticking beside each other is one too many. */}
      {message.isStreaming && calls.length === 0 && !message.content.trim() && (
        <ThinkingIndicator active charCount={message.content.length} toolLabel={runningCall?.name ?? null} onStop={onStop} />
      )}

      {segments.map((piece, index) =>
        piece.kind === "prose" ? (
          <div key={index} className={`${compact ? "text-xs" : "text-sm"} text-ink-prose leading-[1.65] markdown-body`}>
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
        <span className="inline-block w-[3px] h-3.5 rounded-[1px] bg-ink-faint animate-caret" />
      )}

      {/* Telemetry, on hover. Every field here is measured — none of it is
          worth a permanent line under every reply. */}
      {settled && message.content && (
        <div className="h-5 flex items-center gap-2 font-mono text-2xs text-ink-disabled select-none opacity-0 group-hover/turn:opacity-100 focus-within:opacity-100 transition-opacity duration-ds ease-ds">
          <span>{clockOf(message.timestamp)}</span>
          {message.engineUsed && <Meta>{message.engineUsed}</Meta>}
          {typeof message.tokensCount === "number" && message.tokensCount > 0 && (
            <Meta>{message.tokensCount.toLocaleString()} tok</Meta>
          )}
          {typeof message.durationSec === "number" && message.durationSec > 0 && <Meta>{message.durationSec.toFixed(1)}s</Meta>}
          {message.costLabel && <Meta>{message.costLabel}</Meta>}

          <span className="flex-1" />

          <button
            type="button"
            onClick={copy}
            title="Copy reply"
            className="w-5 h-5 flex items-center justify-center rounded text-ink-faint hover:bg-surface-hover hover:text-ink-high transition-colors duration-ds ease-ds"
          >
            {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
          </button>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              title="Ask again"
              className="w-5 h-5 flex items-center justify-center rounded text-ink-faint hover:bg-surface-hover hover:text-ink-high transition-colors duration-ds ease-ds"
            >
              <RotateCcw size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/** A telemetry field, behind the separator that keeps the row scannable. */
const Meta: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <>
    <span className="text-ink-disabled/60">·</span>
    <span>{children}</span>
  </>
);
