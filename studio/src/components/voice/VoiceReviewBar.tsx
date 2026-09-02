import React, { useEffect, useRef, useState } from "react";
import { Check, X, Pencil, Undo2, Languages, Sparkles } from "lucide-react";
import type { RepairedTranscript } from "../../services/voice";

/**
 * The gate between the microphone and the chat.
 *
 * Nothing dictated reaches the engine until it has passed through here. The bar
 * shows the repaired text, what was changed and why, and gives three ways out:
 * send it, edit it, or throw it away. In conversation mode a countdown sends it
 * automatically so the exchange keeps flowing — but the countdown stops the
 * instant the operator touches anything, and it can be switched off entirely.
 */

export interface VoiceReviewBarProps {
  pending: RepairedTranscript;
  /** ms remaining on the auto-send timer, or null when there is none. */
  autoSendIn: number | null;
  onApprove: (text: string) => void;
  onDiscard: () => void;
  /** Called on any interaction, so the caller can cancel the countdown. */
  onInteract?: () => void;
}

const KIND_LABELS: Record<string, string> = {
  filler: "filler removed",
  punctuation: "punctuation",
  capitalisation: "casing",
  "code-term": "code term",
  path: "path",
  command: "command",
  model: "product name",
  duplicate: "repeat removed",
  translation: "translated",
};

export const VoiceReviewBar: React.FC<VoiceReviewBarProps> = ({
  pending,
  autoSendIn,
  onApprove,
  onDiscard,
  onInteract,
}) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(pending.repaired);
  const [showRaw, setShowRaw] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(pending.repaired);
    setEditing(false);
    setShowRaw(false);
  }, [pending]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const touch = () => onInteract?.();
  const changed = pending.edits.length > 0;
  const seconds = autoSendIn !== null ? Math.ceil(autoSendIn / 1000) : null;

  return (
    <div className="lit lit-lift w-full rounded-xl bg-surface overflow-hidden animate-in">
      {/* Countdown rail — reads as progress, not as a warning. */}
      {seconds !== null && (
        <div className="h-0.5 bg-accent/25">
          <div
            className="h-full bg-accent transition-[width] duration-100 ease-linear"
            style={{ width: `${Math.max(0, Math.min(100, (autoSendIn ?? 0) / 25))}%` }}
          />
        </div>
      )}

      <div className="px-3 py-2.5 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-2xs text-ink-faint">
          <Sparkles size={11} className="text-accent" />
          <span>{changed ? "Cleaned up — check before sending" : "Heard"}</span>
          {pending.translatedFrom && (
            <span className="inline-flex items-center gap-1 text-info">
              <Languages size={11} />
              from {pending.translatedFrom}
            </span>
          )}
          <div className="flex-1" />
          {seconds !== null && <span className="font-mono">sending in {seconds}s</span>}
        </div>

        {editing ? (
          <textarea
            ref={inputRef}
            value={text}
            onChange={(event) => {
              touch();
              setText(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onApprove(text);
              }
              if (event.key === "Escape") setEditing(false);
            }}
            rows={2}
            className="lit lit-inner w-full bg-surface-sunken rounded-lg px-2.5 py-2 text-sm text-ink-high outline-none resize-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              touch();
              setEditing(true);
            }}
            className="text-left text-sm text-ink-high leading-relaxed hover:text-white transition-colors duration-ds ease-ds"
          >
            {showRaw ? <span className="text-ink-muted italic">{pending.raw}</span> : text}
          </button>
        )}

        <div className="flex items-center gap-2">
          {changed && (
            <button
              type="button"
              onClick={() => {
                touch();
                setShowRaw((previous) => !previous);
              }}
              className="inline-flex items-center gap-1 text-2xs text-ink-faint hover:text-ink-dim transition-colors duration-ds ease-ds"
            >
              <Undo2 size={11} />
              {showRaw ? "Show cleaned" : "Show what I said"}
            </button>
          )}

          {/* Every edit is named. A silent rewrite of your words is not acceptable. */}
          {changed && !showRaw && (
            <div className="flex items-center gap-1 flex-wrap min-w-0">
              {Array.from(new Set(pending.edits.map((edit) => edit.kind))).slice(0, 4).map((kind) => (
                <span key={kind} className="text-3xs font-mono text-ink-disabled bg-surface-chip rounded px-1.5 py-0.5">
                  {KIND_LABELS[kind] ?? kind}
                </span>
              ))}
            </div>
          )}

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => {
              touch();
              setEditing((previous) => !previous);
            }}
            title="Edit before sending"
            className="w-7 h-7 flex items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink-high transition-colors duration-ds ease-ds"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={onDiscard}
            title="Discard"
            className="w-7 h-7 flex items-center justify-center rounded-md text-ink-muted hover:bg-danger/15 hover:text-danger transition-colors duration-ds ease-ds"
          >
            <X size={14} />
          </button>
          <button
            type="button"
            onClick={() => onApprove(text)}
            className="h-7 px-3 inline-flex items-center gap-1.5 rounded-md bg-ink-high text-frame-top text-xs font-medium hover:bg-white transition-colors duration-ds ease-ds"
          >
            <Check size={13} />
            Send
          </button>
        </div>
      </div>
    </div>
  );
};
