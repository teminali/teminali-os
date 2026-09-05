import React from "react";
import { Mic, Square, Loader2, AudioLines } from "lucide-react";
import type { VoiceState } from "../../services/voice";

/**
 * The microphone control in the composer.
 *
 * It carries the whole state machine in one glyph, because a hands-free mode
 * where you cannot tell whether the machine is listening is worse than no
 * hands-free mode at all. The ring reflects live input level, so the operator
 * can see that the microphone is actually hearing them before they finish a
 * sentence.
 */

export interface VoiceButtonProps {
  state: VoiceState;
  level: number;
  /**
   * What the assistant will do with the utterance. Only used for the tooltip —
   * a control that opens a session which then acts on your screen must say so
   * before it is pressed, not after.
   */
  mode?: "dictate" | "talk" | "agent";
  /** Short press: start the assistant. Shift-click: hands-free conversation. */
  onDictate: () => void;
  onConversation: () => void;
  onStop: () => void;
  disabled?: boolean;
  size?: number;
}

const IDLE_STATES: VoiceState[] = ["idle"];
const BUSY_STATES: VoiceState[] = ["deciding", "repairing", "sending"];

const MODE_LABEL: Record<NonNullable<VoiceButtonProps["mode"]>, string> = {
  dictate: "Speak to put words in the composer",
  talk: "Ask about what is on your screen",
  agent: "Ask the assistant to act on your screen",
};

export const VoiceButton: React.FC<VoiceButtonProps> = ({
  state,
  level,
  mode = "dictate",
  onDictate,
  onConversation,
  onStop,
  disabled = false,
  size = 32,
}) => {
  const idle = IDLE_STATES.includes(state);
  const busy = BUSY_STATES.includes(state);
  const hearing = state === "hearing" || state === "listening";
  const speaking = state === "speaking";

  const label = idle
    ? "Start voice conversation with Temy"
    : speaking
      ? "Speaking — talk to interrupt"
      : hearing
        ? "Listening — click to stop"
        : "Working…";

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={!idle}
      disabled={disabled}
      onClick={() => {
        if (!idle) {
          onStop();
          return;
        }
        onConversation();
      }}
      style={{ width: size, height: size }}
      className={`relative flex items-center justify-center rounded-full flex-shrink-0 transition-colors duration-ds ease-ds disabled:opacity-40 ${
        idle
          ? "bg-ink-high text-frame-top hover:bg-white"
          : speaking
            ? "bg-accent text-frame-top"
            : hearing
              ? "bg-success text-frame-top animate-listening"
              : "bg-surface-hover text-ink-high"
      }`}
    >
      {/* Level ring. Scales with input so it reads as a live meter, not decor. */}
      {hearing && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full border border-success/60 pointer-events-none"
          style={{ transform: `scale(${1 + Math.min(0.55, level * 0.75)})`, opacity: 0.25 + level * 0.5 }}
        />
      )}
      {busy ? (
        <Loader2 size={size * 0.45} className="animate-spin" />
      ) : speaking ? (
        <AudioLines size={size * 0.45} />
      ) : hearing ? (
        <Square size={size * 0.36} fill="currentColor" />
      ) : (
        <Mic size={size * 0.45} strokeWidth={2} />
      )}
    </button>
  );
};
