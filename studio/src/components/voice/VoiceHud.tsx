import React, { useEffect, useRef } from "react";
import { AudioLines, EarOff, Mic, PhoneOff, Sparkles, UserCheck } from "lucide-react";
import type { AddressingVerdict, VoiceState } from "../../services/voice";

/**
 * The hands-free heads-up display.
 *
 * Conversation mode is the one place where the operator cannot see a cursor or
 * a caret to tell them what the machine is doing, so this has to answer three
 * questions at a glance: is it hearing me, did it think that was for it, and
 * can I interrupt right now. Anything the assistant decides — especially a
 * dropped utterance — is stated in words, with a way to undo it.
 */

export interface VoiceHudProps {
  state: VoiceState;
  level: number;
  transcript: string;
  verdict: AddressingVerdict | null;
  lastRejected: { text: string; verdict: AddressingVerdict } | null;
  interrupted: boolean;
  tierLabel: string;
  onRecover: () => void;
  onEnd: () => void;
}

const STATE_COPY: Record<VoiceState, string> = {
  idle: "Off",
  listening: "Listening",
  hearing: "Hearing you",
  deciding: "Was that for me?",
  repairing: "Cleaning that up",
  review: "Ready to send",
  sending: "Sending",
  thinking: "Thinking",
  speaking: "Speaking — talk to interrupt",
};

/** Rolling level history, drawn as the bar meter. */
const BARS = 28;

export const VoiceHud: React.FC<VoiceHudProps> = ({
  state,
  level,
  transcript,
  verdict,
  lastRejected,
  interrupted,
  tierLabel,
  onRecover,
  onEnd,
}) => {
  const history = useRef<number[]>(new Array(BARS).fill(0));
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    history.current = [...history.current.slice(1), level];
    const node = canvasRef.current;
    if (!node) return;
    // Written straight to the DOM: this updates 50 times a second and has no
    // business triggering React renders.
    const children = node.children;
    for (let i = 0; i < children.length; i += 1) {
      const value = history.current[i] ?? 0;
      (children[i] as HTMLElement).style.height = `${Math.max(2, value * 22)}px`;
    }
  }, [level]);

  const speaking = state === "speaking";
  const hearing = state === "hearing" || state === "listening";

  return (
    <div className="lit lit-lift w-full rounded-xl bg-surface overflow-hidden animate-float">
      <div className="px-3 py-2.5 flex items-center gap-3">
        <div
          className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
            speaking ? "bg-accent text-frame-top" : hearing ? "bg-success/15 text-success" : "bg-surface-chip text-ink-muted"
          }`}
        >
          {speaking ? <AudioLines size={14} /> : <Mic size={14} />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-high">{STATE_COPY[state]}</span>
            {interrupted && <span className="text-3xs font-mono text-accent">interrupted</span>}
          </div>
          <div className="text-2xs text-ink-faint truncate">
            {transcript || (verdict?.reason ?? tierLabel)}
          </div>
        </div>

        {/* Level meter */}
        <div ref={canvasRef} className="flex items-end gap-[2px] h-6 flex-shrink-0" aria-hidden>
          {Array.from({ length: BARS }).map((_, index) => (
            <span
              key={index}
              className={`w-[2px] rounded-full ${speaking ? "bg-accent/70" : "bg-success/70"}`}
              style={{ height: 2 }}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={onEnd}
          title="End voice conversation"
          className="w-7 h-7 flex items-center justify-center rounded-md text-ink-muted hover:bg-danger/15 hover:text-danger transition-colors duration-ds ease-ds flex-shrink-0"
        >
          <PhoneOff size={14} />
        </button>
      </div>

      {/* A dropped utterance is always explained and always recoverable. */}
      {lastRejected && (
        <div className="border-t border-edge-subtle px-3 py-2 flex items-center gap-2">
          <EarOff size={12} className="text-ink-disabled flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-2xs text-ink-faint truncate">
              Ignored: “{lastRejected.text}”
            </div>
            <div className="text-3xs text-ink-disabled">{lastRejected.verdict.reason}</div>
          </div>
          <button
            type="button"
            onClick={onRecover}
            className="text-2xs text-accent hover:text-accent-hover flex-shrink-0 transition-colors duration-ds ease-ds"
          >
            That was for you
          </button>
        </div>
      )}

      {/* Signal breakdown — so a wrong call is diagnosable, not mysterious. */}
      {verdict && state === "deciding" && (
        <div className="border-t border-edge-subtle px-3 py-2 flex items-center gap-3 text-3xs font-mono text-ink-disabled">
          {verdict.signals.wakeWord && (
            <span className="inline-flex items-center gap-1 text-accent">
              <Sparkles size={10} /> name
            </span>
          )}
          {verdict.signals.speakerMatch !== null && (
            <span className="inline-flex items-center gap-1">
              <UserCheck size={10} /> voice {verdict.signals.speakerMatch.toFixed(2)}
            </span>
          )}
          {verdict.signals.followUpWindow && <span>reply expected</span>}
          {verdict.signals.classifier !== null && <span>model {verdict.signals.classifier > 0 ? "+" : ""}{verdict.signals.classifier.toFixed(2)}</span>}
        </div>
      )}
    </div>
  );
};
