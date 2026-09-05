import React from "react";
import { Volume2, VolumeX, X, Zap, ShieldCheck, UserCheck } from "lucide-react";
import { VoiceOrb } from "./VoiceOrb";
import type { AddressingVerdict, VoiceState } from "../../services/voice";

export interface AstraVoiceHudProps {
  state: VoiceState;
  level: number;
  transcript: string;
  verdict: AddressingVerdict | null;
  lastRejected?: { text: string; verdict: AddressingVerdict } | null;
  interrupted?: boolean;
  tierLabel?: string;
  hasProfile?: boolean;
  speakReplies?: boolean;
  onToggleSpeakReplies?: () => void;
  onOpenEnrol?: () => void;
  onEnd: () => void;
}

const STATE_LABEL: Record<VoiceState, string> = {
  idle: "Off",
  listening: "Listening",
  hearing: "Hearing you…",
  deciding: "Checking address…",
  repairing: "Processing…",
  review: "Ready to send",
  sending: "Sending…",
  thinking: "Thinking…",
  speaking: "Speaking — talk to interrupt",
};

/**
 * Astra-style Voice Assistant Bar.
 *
 * Positioned cleanly above the composer just like OpenAI Astra / ChatGPT Voice:
 * featuring the animated Teminali logo, model indicator badge ("⚡ Teminali Voice"),
 * speaker verification status ("Recognize Only Me"), real-time transcript / status text,
 * and quick controls for speech output and dismissing voice mode.
 */
export const AstraVoiceHud: React.FC<AstraVoiceHudProps> = ({
  state,
  level,
  transcript,
  verdict,
  interrupted = false,
  hasProfile = false,
  speakReplies = true,
  onToggleSpeakReplies,
  onOpenEnrol,
  onEnd,
}) => {
  if (state === "idle") return null;

  return (
    <div className="w-full max-w-composer flex flex-col items-center gap-2 mb-2 animate-float">
      {/* Floating Astra capsule */}
      <div className="w-full flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-2xl bg-surface/90 backdrop-blur-md border border-edge-subtle shadow-xl">
        {/* Left: Animated Voice Logo + State */}
        <div className="flex items-center gap-3 min-w-0">
          <VoiceOrb
            size={32}
            state={state}
            level={level}
            caption={transcript || verdict?.reason || undefined}
            interactive={false}
          />
          <div className="min-w-0 flex flex-col">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-2xs font-medium text-ink-high">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    state === "speaking"
                      ? "bg-success animate-pulse"
                      : state === "hearing"
                        ? "bg-success animate-ping"
                        : "bg-ink-muted"
                  }`}
                />
                {STATE_LABEL[state]}
              </span>
              {interrupted && (
                <span className="text-3xs font-mono text-accent">interrupted</span>
              )}
            </div>
            <div className="text-2xs text-ink-muted truncate max-w-[280px]">
              {transcript || verdict?.reason || "Say \"Hey Temy\" or speak your instruction"}
            </div>
          </div>
        </div>

        {/* Right: Model Badge + Voice Match Status + Controls */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Model pill */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-chip/70 border border-edge-subtle text-3xs font-medium text-ink-high select-none">
            <Zap size={11} className="text-success fill-success" />
            <span>Teminali Voice</span>
          </div>

          {/* Voice Match / Speaker Verification Badge */}
          {onOpenEnrol && (
            <button
              type="button"
              onClick={onOpenEnrol}
              title={
                hasProfile
                  ? "Voice match active: only responds to your voice"
                  : "Train Temy to recognize only your voice"
              }
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full border text-3xs font-medium transition-colors ${
                hasProfile
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-edge-subtle bg-surface-chip/60 text-ink-muted hover:text-ink-high"
              }`}
            >
              {hasProfile ? <ShieldCheck size={11} /> : <UserCheck size={11} />}
              <span>{hasProfile ? "Only Me" : "Train Voice"}</span>
            </button>
          )}

          {/* Toggle speech audio output */}
          {onToggleSpeakReplies && (
            <button
              type="button"
              onClick={onToggleSpeakReplies}
              title={speakReplies ? "Mute spoken replies" : "Enable spoken replies"}
              aria-label={speakReplies ? "Mute spoken replies" : "Enable spoken replies"}
              className={`w-7 h-7 flex items-center justify-center rounded-full transition-colors duration-ds ${
                speakReplies
                  ? "text-ink-high hover:bg-surface-hover"
                  : "text-ink-disabled hover:bg-surface-hover"
              }`}
            >
              {speakReplies ? <Volume2 size={13} /> : <VolumeX size={13} />}
            </button>
          )}

          {/* Close / End Voice Session */}
          <button
            type="button"
            onClick={onEnd}
            title="End voice conversation"
            aria-label="End voice conversation"
            className="w-7 h-7 flex items-center justify-center rounded-full text-ink-muted hover:bg-danger/15 hover:text-danger transition-colors duration-ds"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};
