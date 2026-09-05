import React, { useEffect, useMemo, useRef, useState } from "react";
import type { VoiceState } from "../../services/voice";

export interface VoiceOrbProps {
  state?: VoiceState;
  level?: number;
  size?: number;
  interactive?: boolean;
  onClick?: () => void;
  showWaves?: boolean;
  className?: string;
  title?: string;
  badge?: string | React.ReactNode;
}

type HoverMode = "none" | "close_eyes" | "jump_away" | "hop_bounce";

/**
 * Animated Teminali Voice Assistant Logo.
 *
 * Pure black squircle with animated green terminal characters: `> _ <`
 * - Dramatic & Living Character Behavior:
 *   - Follows the mouse pointer with smooth 3D parallax perspective tilt.
 *   - Character gaze tracks cursor across the canvas.
 *   - Playful Hover variety:
 *     - Sometimes closes all eyes peacefully (`— _ —`) with a warm smile.
 *     - Sometimes cheekily jumps away / dodges your cursor (`> o <`)!
 *     - Sometimes does an excited vertical hop bounce with squash & stretch!
 *   - Living idle behavior: loses the mouse from time to time and glances around
 *     before curiously snapping back to the cursor!
 * - Voice states:
 *   - Idle: organic breathing and periodic natural blinks.
 *   - Listening: alert gaze and anticipatory ready state.
 *   - Hearing: mouth `_` reacts directly as a live audio equalizer / waveform.
 *   - Thinking/Deciding: scanning cursor and thinking pulse.
 *   - Speaking: articulating speech mouth with harmonic pulses.
 */
export const VoiceOrb: React.FC<VoiceOrbProps> = ({
  state = "idle",
  level = 0,
  size = 64,
  interactive = true,
  onClick,
  showWaves = false,
  className = "",
  title,
  badge,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const isHearing = state === "hearing";
  const isListening = state === "listening";
  const isSpeaking = state === "speaking";
  const isThinking = state === "deciding" || state === "thinking" || state === "repairing" || state === "sending";
  const isActive = state !== "idle";

  // Mouse tracking state
  const [mouseGaze, setMouseGaze] = useState<{ x: number; y: number; tiltX: number; tiltY: number }>({
    x: 0,
    y: 0,
    tiltX: 0,
    tiltY: 0,
  });

  // Distraction state: "losing the mouse from time to time"
  const [distraction, setDistraction] = useState<{
    active: boolean;
    x: number;
    y: number;
    tiltX: number;
    tiltY: number;
    headTilt: number;
  }>({
    active: false,
    x: 0,
    y: 0,
    tiltX: 0,
    tiltY: 0,
    headTilt: 0,
  });

  // Hover state & dynamic dramatic reaction
  const [isHovered, setIsHovered] = useState(false);
  const [hoverMode, setHoverMode] = useState<HoverMode>("none");
  const [jumpOffset, setJumpOffset] = useState<{ x: number; y: number; rotate: number; scale: number }>({
    x: 0,
    y: 0,
    rotate: 0,
    scale: 1,
  });
  const [isPressed, setIsPressed] = useState(false);

  // Audio-reactive level boost (clamped 0 to 1)
  const normalizedLevel = useMemo(() => {
    return Math.min(1, Math.max(0, level));
  }, [level]);

  // Periodic natural blink timer for idle/listening state
  const [isBlinking, setIsBlinking] = useState(false);
  useEffect(() => {
    if (isHearing || isSpeaking || isThinking || isHovered) {
      setIsBlinking(false);
      return;
    }

    const interval = setInterval(() => {
      setIsBlinking(true);
      setTimeout(() => setIsBlinking(false), 160);
    }, 4500);

    return () => clearInterval(interval);
  }, [isHearing, isSpeaking, isThinking, isHovered]);

  // Periodic "lose the mouse" wandering behavior
  useEffect(() => {
    if (!interactive || isActive || isHovered) {
      setDistraction((prev) => (prev.active ? { ...prev, active: false } : prev));
      return;
    }

    let timer: NodeJS.Timeout;
    let cancelTimer: NodeJS.Timeout;
    let stepTimer: NodeJS.Timeout;

    const scheduleDistraction = () => {
      // Every 5 to 8 seconds, lose the mouse and glance around
      const delay = 5000 + Math.random() * 3000;
      timer = setTimeout(() => {
        // Direction 1: Look away (up-left or up-right daydreaming)
        const sign = Math.random() > 0.5 ? 1 : -1;
        const randX1 = sign * (5 + Math.random() * 4);
        const randY1 = -4 - Math.random() * 3;
        const tilt1 = sign * (6 + Math.random() * 5);

        setDistraction({
          active: true,
          x: randX1,
          y: randY1,
          tiltX: randY1 * 1.4,
          tiltY: randX1 * 1.4,
          headTilt: tilt1,
        });

        // Direction 2 (after 900ms): glance curiously to the other side
        stepTimer = setTimeout(() => {
          const randX2 = -sign * (4 + Math.random() * 3);
          const randY2 = -2 - Math.random() * 3;
          setDistraction({
            active: true,
            x: randX2,
            y: randY2,
            tiltX: randY2 * 1.2,
            tiltY: randX2 * 1.2,
            headTilt: -tilt1 * 0.7,
          });
        }, 900);

        // Snap back: after 1.8s, find the mouse again!
        cancelTimer = setTimeout(() => {
          setIsBlinking(true);
          setTimeout(() => setIsBlinking(false), 140);
          setDistraction((prev) => ({ ...prev, active: false }));
          scheduleDistraction();
        }, 1800);
      }, delay);
    };

    scheduleDistraction();

    return () => {
      clearTimeout(timer);
      clearTimeout(cancelTimer);
      clearTimeout(stepTimer);
    };
  }, [interactive, isActive, isHovered]);

  // Speaking mouth wave animation timer
  const [speechPhase, setSpeechPhase] = useState(0);
  useEffect(() => {
    if (!isSpeaking) return;
    const interval = setInterval(() => {
      setSpeechPhase((p) => (p + 1) % 6);
    }, 110);
    return () => clearInterval(interval);
  }, [isSpeaking]);

  // Unified dramatic hover trigger & release
  const lastHoverRef = useRef(false);

  const triggerHover = (approachSign = 1) => {
    if (lastHoverRef.current) return;
    lastHoverRef.current = true;
    const roll = Math.random();

    if (roll < 0.45) {
      // 45%: Close all eyes peacefully (— _ —) with a warm smile
      setHoverMode("close_eyes");
      setJumpOffset({ x: 0, y: -4, rotate: 0, scale: 1.06 });
    } else if (roll < 0.82) {
      // 37%: Cheekily jump away / dodge your cursor (> o <)!
      setHoverMode("jump_away");
      const sign = approachSign !== 0 ? approachSign : (Math.random() > 0.5 ? 1 : -1);
      const jumpX = -sign * (36 + Math.random() * 12);
      const jumpY = -34 - Math.random() * 10;
      const rot = -sign * (10 + Math.random() * 6);
      setJumpOffset({ x: jumpX, y: jumpY, rotate: rot, scale: 1.1 });
    } else {
      // 18%: Startled playful hop bounce straight up!
      setHoverMode("hop_bounce");
      setJumpOffset({ x: (Math.random() - 0.5) * 12, y: -42, rotate: (Math.random() - 0.5) * 12, scale: 1.14 });
    }
    setIsHovered(true);
  };

  const endHover = () => {
    if (!lastHoverRef.current) return;
    lastHoverRef.current = false;
    setIsHovered(false);
    setHoverMode("none");
    setJumpOffset({ x: 0, y: 0, rotate: 0, scale: 1 });
    setIsPressed(false);
  };

  useEffect(() => {
    if (!interactive) return;

    let rafId: number;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        const maxDist = Math.max(window.innerWidth, window.innerHeight) * 0.7;
        const rawDx = (e.clientX - centerX) / (maxDist || 1);
        const rawDy = (e.clientY - centerY) / (maxDist || 1);

        const dx = Math.max(-1, Math.min(1, rawDx));
        const dy = Math.max(-1, Math.min(1, rawDy));

        // Direct bounding box hover check (expanded slightly for smooth entry)
        const isOver = (
          e.clientX >= rect.left - 6 &&
          e.clientX <= rect.right + 6 &&
          e.clientY >= rect.top - 6 &&
          e.clientY <= rect.bottom + 6
        );

        const approachSign = (e.clientX - centerX) >= 0 ? 1 : -1;
        if (isOver) {
          triggerHover(approachSign);
        } else {
          endHover();
        }

        // Eye gaze tracking (px in SVG space)
        const eyeX = dx * 6.5;
        const eyeY = dy * 5.5;

        // 3D perspective tilt
        const tiltY = dx * 14;
        const tiltX = -dy * 14;

        setMouseGaze({ x: eyeX, y: eyeY, tiltX, tiltY });
      });
    };

    const handleMouseLeave = () => {
      endHover();
      setMouseGaze({ x: 0, y: 0, tiltX: 0, tiltY: 0 });
    };

    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    document.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [interactive]);

  // Active gaze calculation
  const currentGaze = useMemo(() => {
    if (isHovered) {
      if (hoverMode === "close_eyes") {
        return { x: 0, y: 0, tiltX: 0, tiltY: 0, headTilt: 0 };
      }
      if (hoverMode === "jump_away" || hoverMode === "hop_bounce") {
        // Looking playfully at the cursor that tried to catch it
        return {
          x: mouseGaze.x * 0.7,
          y: mouseGaze.y * 0.7,
          tiltX: mouseGaze.tiltX * 0.5,
          tiltY: mouseGaze.tiltY * 0.5,
          headTilt: jumpOffset.rotate,
        };
      }
    }
    if (distraction.active) {
      return {
        x: distraction.x,
        y: distraction.y,
        tiltX: distraction.tiltX,
        tiltY: distraction.tiltY,
        headTilt: distraction.headTilt,
      };
    }
    return {
      x: mouseGaze.x,
      y: mouseGaze.y,
      tiltX: mouseGaze.tiltX,
      tiltY: mouseGaze.tiltY,
      headTilt: 0,
    };
  }, [isHovered, hoverMode, jumpOffset.rotate, distraction, mouseGaze]);

  // Dynamic mouth dimensions based on state, audio level, & hover reaction
  const mouthProps = useMemo(() => {
    if (isHearing) {
      // Live audio equalizer
      const height = 9.5 + normalizedLevel * 18;
      const width = 28 + normalizedLevel * 8;
      const x = 64 - width / 2;
      const y = 77 - height / 2;
      return { x, y, width, height, rx: height / 2 };
    }

    if (isSpeaking) {
      // Articulated speech wave
      const heights = [10, 22, 14, 26, 12, 18];
      const widths = [28, 24, 30, 26, 32, 28];
      const h = heights[speechPhase];
      const w = widths[speechPhase];
      return {
        x: 64 - w / 2,
        y: 77 - h / 2,
        width: w,
        height: h,
        rx: h / 2,
      };
    }

    if (isThinking) {
      return { x: 54, y: 72, width: 20, height: 9.5, rx: 4.75 };
    }

    if (isHovered) {
      if (hoverMode === "close_eyes") {
        // Peaceful contented smile
        return { x: 46, y: 70, width: 36, height: 9.5, rx: 4.75 };
      }
      if (hoverMode === "jump_away" || hoverMode === "hop_bounce") {
        // Surprised / playful open "o" mouth!
        return { x: 53, y: 69, width: 22, height: 15, rx: 7.5 };
      }
    }

    if (distraction.active) {
      // Curious compact mouth when lost in thought
      return { x: 53, y: 72, width: 22, height: 9.5, rx: 4.75 };
    }

    // Default resting underscore
    return { x: 50, y: 72, width: 28, height: 9.5, rx: 4.75 };
  }, [isHearing, isSpeaking, isThinking, isHovered, hoverMode, distraction.active, normalizedLevel, speechPhase]);

  const cornerRadius = 28;

  const defaultTitle = isActive
    ? isSpeaking
      ? "Temy is speaking — speak to interrupt"
      : isHearing
        ? "Temy is hearing you — speak your command"
        : isListening
          ? 'Temy is listening — say "Hey Temy"'
          : "Temy is working on your request…"
    : 'Say "Hey Temy" or click to start voice conversation';

  return (
    <div
      ref={containerRef}
      data-testid="teminali-voice-orb"
      role={interactive ? "button" : "presentation"}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onClick : undefined}
      onMouseEnter={() => triggerHover(1)}
      onMouseLeave={() => endHover()}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      title={title ?? defaultTitle}
      aria-label={title ?? defaultTitle}
      className={`group relative flex items-center justify-center select-none overflow-visible ${
        interactive ? "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-white/20 rounded-2xl" : ""
      } ${className}`}
      style={{
        width: size,
        height: size,
        perspective: 600,
      }}
    >
      {/* ── Pure Black Logo with 3D Tilt, Playful Dodge & Spring Physics ─── */}
      <div
        className="w-full h-full flex items-center justify-center transition-transform"
        style={{
          transform: `translate3d(${jumpOffset.x}px, ${jumpOffset.y}px, 0) rotateX(${currentGaze.tiltX}deg) rotateY(${currentGaze.tiltY}deg) rotate(${currentGaze.headTilt}deg) scale(${
            isPressed ? 0.92 : jumpOffset.scale
          })`,
          transformStyle: "preserve-3d",
          transitionDuration: isHovered ? "280ms" : "420ms",
          transitionTimingFunction: "cubic-bezier(0.34, 1.56, 0.64, 1)",
        }}
      >
        <svg
          viewBox="0 0 128 128"
          width={size}
          height={size}
          className="relative z-10 block overflow-visible"
          style={{
            filter: "drop-shadow(0 6px 14px rgba(0, 0, 0, 0.75))",
          }}
        >
          <defs>
            <filter id="temyCharGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="0.8" result="glow" />
              <feMerge>
                <feMergeNode in="glow" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Pure Black Squircle Body */}
          <rect
            width="128"
            height="128"
            rx={cornerRadius}
            ry={cornerRadius}
            fill="#000000"
          />

          {/* Razor-thin 1px crisp edge sheen */}
          <rect
            x="1"
            y="1"
            width="126"
            height="126"
            rx={cornerRadius - 1}
            ry={cornerRadius - 1}
            fill="none"
            stroke="rgba(255, 255, 255, 0.08)"
            strokeWidth="1.2"
          />

          {/* ── Green Animated Characters: > _ < ──────────────────────────── */}
          <g
            filter="url(#temyCharGlow)"
            className="transition-transform duration-150 ease-out"
            style={{
              transform: `translate(${currentGaze.x}px, ${currentGaze.y}px)`,
            }}
          >
            {/* Left Chevron: > */}
            <path
              d="M 26 48 L 43 64 L 26 80"
              fill="none"
              stroke="#65c466"
              strokeWidth="9.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-all duration-150 ease-out"
              style={{
                transformOrigin: "34.5px 64px",
                transform: (isHovered && hoverMode === "close_eyes")
                  ? "scaleY(0.06) scaleX(0.95)" // Closed eyelid!
                  : (isHovered && (hoverMode === "jump_away" || hoverMode === "hop_bounce"))
                    ? "scale(1.22) rotate(-6deg)" // Excited wide open eye!
                    : isBlinking
                      ? "scaleY(0.1)"
                      : isHearing
                        ? `translateX(${-normalizedLevel * 2}px) scale(${1 + normalizedLevel * 0.08})`
                        : isSpeaking
                          ? "scale(1.05)"
                          : undefined,
              }}
            />

            {/* Center Mouth: _ */}
            <rect
              x={mouthProps.x}
              y={mouthProps.y}
              width={mouthProps.width}
              height={mouthProps.height}
              rx={mouthProps.rx}
              ry={mouthProps.rx}
              fill="#65c466"
              className="transition-all duration-120 ease-out"
            />

            {/* Right Chevron: < */}
            <path
              d="M 102 48 L 85 64 L 102 80"
              fill="none"
              stroke="#65c466"
              strokeWidth="9.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-all duration-150 ease-out"
              style={{
                transformOrigin: "93.5px 64px",
                transform: (isHovered && hoverMode === "close_eyes")
                  ? "scaleY(0.06) scaleX(0.95)" // Closed eyelid!
                  : (isHovered && (hoverMode === "jump_away" || hoverMode === "hop_bounce"))
                    ? "scale(1.22) rotate(6deg)" // Excited wide open eye!
                    : isBlinking
                      ? "scaleY(0.1)"
                      : isHearing
                        ? `translateX(${normalizedLevel * 2}px) scale(${1 + normalizedLevel * 0.08})`
                        : isSpeaking
                          ? "scale(1.05)"
                          : undefined,
              }}
            />
          </g>
        </svg>
      </div>

      {/* ── Nicely Put Floating Badge ("Say Hey Temy") ──────────────────── */}
      {badge && (
        <div
          className="absolute top-[calc(100%+12px)] left-1/2 pointer-events-none select-none whitespace-nowrap z-20"
          style={{
            transform: `translate3d(calc(-50% + ${jumpOffset.x * 0.55}px), ${jumpOffset.y * 0.55}px, 0)`,
            transitionProperty: "transform",
            transitionDuration: isHovered ? "360ms" : "520ms",
            transitionTimingFunction: "cubic-bezier(0.25, 1, 0.5, 1)",
          }}
        >
          <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#121214]/90 backdrop-blur-md border border-white/10 shadow-[0_4px_12px_rgba(0,0,0,0.6)] text-[11px] font-medium tracking-tight text-neutral-300">
            <span className="w-1.5 h-1.5 rounded-full bg-[#65c466] shadow-[0_0_6px_rgba(101,196,102,0.8)] animate-pulse flex-shrink-0" />
            <span className="opacity-95">{badge}</span>
          </div>
        </div>
      )}
    </div>
  );
};
