import React, { useMemo } from "react";
import type { VoiceState } from "../../services/voice";

export interface AstraVoiceOrbProps {
  state: VoiceState;
  level?: number;
  size?: number;
  className?: string;
  onClick?: () => void;
}

/**
 * OpenAI Astra / ChatGPT Voice Floating Orb.
 *
 * Modeled directly from the real ChatGPT Voice interface:
 * an ethereal, fluid, luminous sphere that floats center-stage above the input pill.
 * Features pearlescent white, electric cyan, and lavender-violet fluid gradients,
 * audio-reactive breathing, and expressive wave oscillations when speaking.
 */
export const AstraVoiceOrb: React.FC<AstraVoiceOrbProps> = ({
  state,
  level = 0,
  size = 52,
  className = "",
  onClick,
}) => {
  const isHearing = state === "hearing" || state === "listening";
  const isSpeaking = state === "speaking";
  const isThinking = state === "deciding" || state === "thinking" || state === "repairing" || state === "sending";

  // Audio-reactive expansion (0 to 0.45)
  const audioScale = useMemo(() => {
    if (!isHearing && !isSpeaking) return 0;
    return Math.min(0.45, Math.max(0, level * 0.75));
  }, [level, isHearing, isSpeaking]);

  return (
    <div
      onClick={onClick}
      role="presentation"
      className={`relative flex items-center justify-center select-none transition-all duration-200 ${className}`}
      style={{ width: size, height: size }}
    >
      {/* ── Ambient Ethereal Glow Halo ──────────────────────────────────── */}
      <div
        aria-hidden
        className="absolute inset-[-35%] rounded-full pointer-events-none transition-all duration-300 ease-out"
        style={{
          background: isSpeaking
            ? "radial-gradient(circle, rgba(165, 180, 252, 0.6) 0%, rgba(129, 140, 248, 0.4) 40%, rgba(99, 102, 241, 0.15) 65%, transparent 80%)"
            : isHearing
              ? "radial-gradient(circle, rgba(147, 197, 253, 0.65) 0%, rgba(96, 165, 250, 0.4) 45%, rgba(59, 130, 246, 0.15) 70%, transparent 82%)"
              : isThinking
                ? "radial-gradient(circle, rgba(192, 132, 252, 0.6) 0%, rgba(168, 85, 247, 0.35) 45%, transparent 75%)"
                : "radial-gradient(circle, rgba(199, 210, 254, 0.4) 0%, rgba(147, 197, 253, 0.2) 45%, transparent 75%)",
          transform: `scale(${1 + audioScale * 0.8})`,
          filter: "blur(14px)",
          opacity: 0.9,
        }}
      />

      {/* ── Audio-Reactive Outer Ripple Wave (Hearing / Speaking) ────────── */}
      {(isHearing || isSpeaking) && (
        <span
          aria-hidden
          className="absolute rounded-full pointer-events-none transition-transform duration-75"
          style={{
            inset: -6,
            border: isSpeaking
              ? "1.5px solid rgba(165, 180, 252, 0.5)"
              : "1.5px solid rgba(147, 197, 253, 0.6)",
            transform: `scale(${1 + audioScale * 0.5})`,
            opacity: 0.3 + audioScale * 0.6,
          }}
        />
      )}

      {/* ── Fluid Luminous Spherical Orb ─────────────────────────────────── */}
      <div
        className="relative rounded-full overflow-hidden flex items-center justify-center transition-transform duration-100 ease-out"
        style={{
          width: size,
          height: size,
          transform: `scale(${1 + audioScale * 0.2})`,
          boxShadow: isSpeaking
            ? "0 0 24px rgba(165, 180, 252, 0.6), inset 0 0 14px rgba(255, 255, 255, 0.85)"
            : "0 0 18px rgba(147, 197, 253, 0.5), inset 0 0 12px rgba(255, 255, 255, 0.8)",
        }}
      >
        {/* Base fluid sphere gradient */}
        <div
          aria-hidden
          className="absolute inset-0 rounded-full"
          style={{
            background: "radial-gradient(circle at 35% 30%, #ffffff 0%, #dbeafe 30%, #bfdbfe 55%, #818cf8 80%, #4338ca 100%)",
          }}
        />

        {/* Dynamic mesh gradient swirl */}
        <div
          aria-hidden
          className={`absolute inset-[-25%] rounded-full mix-blend-overlay opacity-85 transition-opacity duration-300 ${
            isThinking ? "animate-spin" : isSpeaking ? "animate-pulse" : ""
          }`}
          style={{
            background: isSpeaking
              ? "conic-gradient(from 0deg at 50% 50%, #ffffff, #93c5fd, #c084fc, #818cf8, #ffffff)"
              : "conic-gradient(from 180deg at 50% 50%, #ffffff, #bfdbfe, #a5b4fc, #60a5fa, #ffffff)",
            filter: "blur(5px)",
            animationDuration: isThinking ? "2.5s" : "6s",
          }}
        />

        {/* Specular 3D glass gloss crescent highlight */}
        <div
          aria-hidden
          className="absolute top-1 left-2 w-[42%] h-[26%] rounded-full pointer-events-none"
          style={{
            background: "radial-gradient(ellipse at center, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0) 80%)",
            transform: "rotate(-25deg)",
          }}
        />
      </div>
    </div>
  );
};
