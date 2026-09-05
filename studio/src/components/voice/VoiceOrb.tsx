import React, { useEffect, useMemo, useRef, useState } from "react";
import type { VoiceEmotion, VoiceState } from "../../services/voice";

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
  emotion?: VoiceEmotion;
  caption?: string;
}

type HoverMode = "none" | "close_eyes" | "jump_away" | "hop_bounce";

interface VisemeShape {
  width: number;
  height: number;
  rx: number;
}

// 6 Core phonemic visemes for natural mouth articulation
const VISEME_SHAPES: VisemeShape[] = [
  // 0: Bilabial / Rest / Silence (M, B, P, pause)
  { width: 26, height: 7, rx: 3.5 },
  // 1: Dental Consonant (S, T, D, N, L, R, K, G)
  { width: 28, height: 11, rx: 5.5 },
  // 2: Wide Spread Smile Vowel (EE, I, AY, EY)
  { width: 38, height: 14, rx: 7 },
  // 3: Open Mid Vowel (AH, EH, AE, UH)
  { width: 30, height: 22, rx: 11 },
  // 4: Open Tall Vowel (AA, AW, AO, OH)
  { width: 24, height: 28, rx: 12 },
  // 5: Round Pucker Vowel (OO, OW, W, UW, U)
  { width: 19, height: 19, rx: 9.5 },
];

/**
 * Break conversational caption text into a sequence of phonemic visemes.
 */
function textToVisemes(text: string): number[] {
  if (!text.trim()) return [1, 3, 2, 4, 1, 5, 2, 0, 3, 1];
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const sequence: number[] = [];

  for (const word of words) {
    let i = 0;
    while (i < word.length) {
      const sub = word.slice(i, i + 2);
      if (["ee", "ea", "ey", "ay", "ai"].includes(sub)) {
        sequence.push(2); // Wide spread smile
        i += 2;
      } else if (["oo", "ou", "ow"].includes(sub)) {
        sequence.push(5); // Pucker
        i += 2;
      } else if (["aw", "au"].includes(sub)) {
        sequence.push(4); // Open tall
        i += 2;
      } else {
        const c = word[i];
        if (["m", "b", "p"].includes(c)) {
          sequence.push(0); // Bilabial rest
        } else if (["a", "e"].includes(c)) {
          sequence.push(3); // Open mid
        } else if (["i", "y"].includes(c)) {
          sequence.push(2); // Wide spread
        } else if (["o"].includes(c)) {
          sequence.push(4); // Open tall
        } else if (["u", "w"].includes(c)) {
          sequence.push(5); // Pucker
        } else {
          sequence.push(1); // Dental / alveolar
        }
        i += 1;
      }
    }
    sequence.push(0); // Natural inter-word micro pause
  }

  return sequence.length > 0 ? sequence : [1, 3, 2, 4, 1, 5, 2, 0, 3, 1];
}

/**
 * Color and glow styling according to emotional mood.
 */
const EMOTION_COLORS: Record<VoiceEmotion, { stroke: string; glow: string; drop: string }> = {
  neutral: { stroke: "#65c466", glow: "rgba(101, 196, 102, 0.7)", drop: "rgba(101, 196, 102, 0.25)" },
  happy: { stroke: "#52e078", glow: "rgba(82, 224, 120, 0.85)", drop: "rgba(82, 224, 120, 0.35)" },
  thinking: { stroke: "#68d391", glow: "rgba(104, 211, 145, 0.7)", drop: "rgba(104, 211, 145, 0.25)" },
  focused: { stroke: "#2dd4bf", glow: "rgba(45, 212, 191, 0.8)", drop: "rgba(45, 212, 191, 0.3)" },
  surprised: { stroke: "#4ade80", glow: "rgba(74, 222, 128, 0.8)", drop: "rgba(74, 222, 128, 0.3)" },
  error: { stroke: "#fb7185", glow: "rgba(251, 113, 133, 0.85)", drop: "rgba(251, 113, 133, 0.35)" },
  speaking: { stroke: "#65c466", glow: "rgba(101, 196, 102, 0.8)", drop: "rgba(101, 196, 102, 0.3)" },
  listening: { stroke: "#65c466", glow: "rgba(101, 196, 102, 0.75)", drop: "rgba(101, 196, 102, 0.25)" },
  relaxed: { stroke: "#86efac", glow: "rgba(134, 239, 172, 0.65)", drop: "rgba(134, 239, 172, 0.2)" },
};

/**
 * Animated Teminali Voice Assistant Logo.
 *
 * Pure black squircle with animated terminal characters: `> _ <`
 * - Complete Real-Time Mouth Sync:
 *   - Phonemic viseme articulation derived from spoken text syllables.
 *   - Live audio amplitude level modulation for organic lip sync.
 *   - Live equalizer waveform in hearing mode.
 * - 8 Character Emotions:
 *   - Neutral, Happy, Thinking, Focused, Surprised, Error, Speaking, Listening, Relaxed.
 *   - Dynamic SVG path morphing for eyes, mouth, and posture.
 * - Living Character Interactivity:
 *   - 3D parallax tilt & cursor tracking gaze.
 *   - Playful dodging, hop bouncing, and peaceful eye-closing hover modes.
 *   - Idle daydreaming wandering behavior.
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
  emotion,
  caption,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const isHearing = state === "hearing";
  const isListening = state === "listening";
  const isSpeaking = state === "speaking";
  const isThinking = state === "deciding" || state === "thinking";
  const isWorking = state === "repairing" || state === "sending";
  const isActive = state !== "idle";

  // Resolve effective emotion: explicit prop, or state + caption sentiment
  const effectiveEmotion: VoiceEmotion = useMemo(() => {
    if (emotion) return emotion;
    if (isSpeaking) return "speaking";
    if (isHearing || isListening) return "listening";
    if (isThinking) return "thinking";
    if (isWorking) return "focused";

    if (caption) {
      const lower = caption.toLowerCase();
      if (/(error|fail|failed|denied|cannot|can't|unable|bug|exception|wrong)/i.test(lower)) {
        return "error";
      }
      if (/(done|passed|success|fixed|finished|great|perfect|ready|hello|hi|welcome|all good)/i.test(lower)) {
        return "happy";
      }
      if (/(investigat|check|search|analyz|why|decid|ponder|status)/i.test(lower)) {
        return "thinking";
      }
      if (/(build|compil|refactor|writ|edit|run|test|execut|patch)/i.test(lower)) {
        return "focused";
      }
      if (/(wow|whoa|look|notic|surpris)/i.test(lower)) {
        return "surprised";
      }
    }

    return "neutral";
  }, [emotion, isSpeaking, isHearing, isListening, isThinking, isWorking, caption]);

  const colors = EMOTION_COLORS[effectiveEmotion] ?? EMOTION_COLORS.neutral;

  // Mouse tracking state
  const [mouseGaze, setMouseGaze] = useState<{ x: number; y: number; tiltX: number; tiltY: number }>({
    x: 0,
    y: 0,
    tiltX: 0,
    tiltY: 0,
  });

  // Distraction state: wandering gaze
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

  // Hover state & dynamic reaction
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
    if (isHearing || isSpeaking || isThinking || isHovered || effectiveEmotion === "error") {
      setIsBlinking(false);
      return;
    }

    const interval = setInterval(() => {
      setIsBlinking(true);
      setTimeout(() => setIsBlinking(false), 160);
    }, 4500);

    return () => clearInterval(interval);
  }, [isHearing, isSpeaking, isThinking, isHovered, effectiveEmotion]);

  // Periodic wandering behavior
  useEffect(() => {
    if (!interactive || isActive || isHovered) {
      setDistraction((prev) => (prev.active ? { ...prev, active: false } : prev));
      return;
    }

    let timer: NodeJS.Timeout;
    let cancelTimer: NodeJS.Timeout;
    let stepTimer: NodeJS.Timeout;

    const scheduleDistraction = () => {
      const delay = 5000 + Math.random() * 3000;
      timer = setTimeout(() => {
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

  // Real-time mouth sync: phonemic viseme sequencing
  const visemeSequence = useMemo(() => {
    return textToVisemes(caption ?? "");
  }, [caption]);

  const [visemeIndex, setVisemeIndex] = useState(0);
  const levelRef = useRef(normalizedLevel);
  levelRef.current = normalizedLevel;

  useEffect(() => {
    if (!isSpeaking) {
      setVisemeIndex(0);
      return;
    }
    const interval = setInterval(() => {
      // Advance phonemic visemes only while audio energy is audibly playing
      if (levelRef.current >= 0.035) {
        setVisemeIndex((prev) => (prev + 1) % visemeSequence.length);
      }
    }, 85);

    return () => clearInterval(interval);
  }, [isSpeaking, visemeSequence.length]);

  // Unified dramatic hover trigger & release
  const lastHoverRef = useRef(false);

  const triggerHover = (approachSign = 1) => {
    if (lastHoverRef.current) return;
    lastHoverRef.current = true;
    const roll = Math.random();

    if (roll < 0.45) {
      setHoverMode("close_eyes");
      setJumpOffset({ x: 0, y: -4, rotate: 0, scale: 1.06 });
    } else if (roll < 0.82) {
      setHoverMode("jump_away");
      const sign = approachSign !== 0 ? approachSign : (Math.random() > 0.5 ? 1 : -1);
      const jumpX = -sign * (36 + Math.random() * 12);
      const jumpY = -34 - Math.random() * 10;
      const rot = -sign * (10 + Math.random() * 6);
      setJumpOffset({ x: jumpX, y: jumpY, rotate: rot, scale: 1.1 });
    } else {
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

        const eyeX = dx * 6.5;
        const eyeY = dy * 5.5;
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
    const emotionTilt = effectiveEmotion === "thinking" ? 4 : 0;
    return {
      x: mouseGaze.x,
      y: mouseGaze.y,
      tiltX: mouseGaze.tiltX,
      tiltY: mouseGaze.tiltY,
      headTilt: emotionTilt,
    };
  }, [isHovered, hoverMode, jumpOffset.rotate, distraction, mouseGaze, effectiveEmotion]);

  // Dynamic mouth dimensions based on real visemes, audio level, emotions, & hover
  const mouthProps = useMemo(() => {
    // 1. Hearing mode: live audio equalizer reactive to operator speech
    if (isHearing) {
      const height = 9.5 + normalizedLevel * 20;
      const width = 28 + normalizedLevel * 10;
      const x = 64 - width / 2;
      const y = 77 - height / 2;
      return { x, y, width, height, rx: height / 2, customPath: null };
    }

    // 2. Speaking mode: complete real-time mouth sync
    if (isSpeaking) {
      // When amplitude is silent (< 0.035), return closed resting mouth.
      // Eliminates desynced mouth flapping when audio is silent, between clauses, or paused.
      if (normalizedLevel < 0.035) {
        return { x: 50, y: 72, width: 28, height: 8.5, rx: 4.25, customPath: null };
      }

      const vIndex = visemeSequence[visemeIndex] ?? 0;
      const target = VISEME_SHAPES[vIndex] ?? VISEME_SHAPES[0];

      // Audio volume modulation: aperture widens and deepens strictly with real acoustic energy
      const w = target.width + normalizedLevel * 8;
      const h = Math.max(7, target.height * (0.6 + normalizedLevel * 0.8));
      const rx = Math.min(w / 2, Math.max(3.5, target.rx * (0.7 + normalizedLevel * 0.5)));

      return {
        x: 64 - w / 2,
        y: 77 - h / 2,
        width: w,
        height: h,
        rx,
        customPath: null,
      };
    }

    // 3. Hover reactions
    if (isHovered) {
      if (hoverMode === "close_eyes") {
        return { x: 46, y: 72, width: 36, height: 9.5, rx: 4.75, customPath: "M 46 72 Q 64 85 82 72" };
      }
      if (hoverMode === "jump_away" || hoverMode === "hop_bounce") {
        return { x: 53, y: 68, width: 22, height: 17, rx: 8.5, customPath: null };
      }
    }

    // 4. Emotional mouth shapes
    if (effectiveEmotion === "happy") {
      return { x: 46, y: 72, width: 36, height: 10, rx: 5, customPath: "M 46 71 Q 64 86 82 71" };
    }
    if (effectiveEmotion === "error") {
      return { x: 46, y: 73, width: 36, height: 10, rx: 5, customPath: "M 46 73 Q 55 67 64 73 Q 73 79 82 73" };
    }
    if (effectiveEmotion === "surprised") {
      return { x: 54, y: 67, width: 20, height: 20, rx: 10, customPath: null };
    }
    if (effectiveEmotion === "focused") {
      return { x: 48, y: 73, width: 32, height: 7, rx: 3.5, customPath: null };
    }
    if (effectiveEmotion === "thinking" || isThinking) {
      return { x: 54, y: 73, width: 20, height: 8.5, rx: 4.25, customPath: null };
    }
    if (distraction.active) {
      return { x: 53, y: 72, width: 22, height: 9.5, rx: 4.75, customPath: null };
    }

    // Default resting underscore
    return { x: 50, y: 72, width: 28, height: 9.5, rx: 4.75, customPath: null };
  }, [
    isHearing,
    isSpeaking,
    isThinking,
    isHovered,
    hoverMode,
    effectiveEmotion,
    distraction.active,
    normalizedLevel,
    visemeIndex,
    visemeSequence,
  ]);

  // Eye paths & transforms per emotion
  const eyeProps = useMemo(() => {
    // Hover overrides
    if (isHovered && hoverMode === "close_eyes") {
      return {
        leftPath: "M 26 48 L 43 64 L 26 80",
        rightPath: "M 102 48 L 85 64 L 102 80",
        leftTransform: "scaleY(0.06) scaleX(0.95)",
        rightTransform: "scaleY(0.06) scaleX(0.95)",
      };
    }
    if (isHovered && (hoverMode === "jump_away" || hoverMode === "hop_bounce")) {
      return {
        leftPath: "M 26 48 L 43 64 L 26 80",
        rightPath: "M 102 48 L 85 64 L 102 80",
        leftTransform: "scale(1.22) rotate(-6deg)",
        rightTransform: "scale(1.22) rotate(6deg)",
      };
    }

    if (isBlinking) {
      return {
        leftPath: "M 26 48 L 43 64 L 26 80",
        rightPath: "M 102 48 L 85 64 L 102 80",
        leftTransform: "scaleY(0.08)",
        rightTransform: "scaleY(0.08)",
      };
    }

    if (effectiveEmotion === "happy") {
      return {
        leftPath: "M 24 67 Q 34.5 47 45 67",
        rightPath: "M 83 67 Q 93.5 47 104 67",
        leftTransform: "scale(1.05)",
        rightTransform: "scale(1.05)",
      };
    }

    if (effectiveEmotion === "error") {
      return {
        leftPath: "M 26 54 L 42 74 M 42 54 L 26 74",
        rightPath: "M 86 54 L 102 74 M 102 54 L 86 74",
        leftTransform: "scale(1)",
        rightTransform: "scale(1)",
      };
    }

    if (effectiveEmotion === "focused") {
      return {
        leftPath: "M 24 64 L 45 64",
        rightPath: "M 83 64 L 104 64",
        leftTransform: "scale(1.05)",
        rightTransform: "scale(1.05)",
      };
    }

    if (effectiveEmotion === "thinking") {
      return {
        leftPath: "M 26 52 L 43 64 L 26 76",
        rightPath: "M 102 44 L 85 64 L 102 84",
        leftTransform: "rotate(-4deg)",
        rightTransform: "scale(1.1) rotate(4deg)",
      };
    }

    if (effectiveEmotion === "surprised") {
      return {
        leftPath: "M 23 42 L 46 64 L 23 86",
        rightPath: "M 105 42 L 82 64 L 105 86",
        leftTransform: "scale(1.18)",
        rightTransform: "scale(1.18)",
      };
    }

    if (effectiveEmotion === "relaxed") {
      return {
        leftPath: "M 25 64 L 44 64",
        rightPath: "M 84 64 L 103 64",
        leftTransform: "scale(1)",
        rightTransform: "scale(1)",
      };
    }

    // Default neutral / listening / speaking chevrons
    return {
      leftPath: "M 26 48 L 43 64 L 26 80",
      rightPath: "M 102 48 L 85 64 L 102 80",
      leftTransform: isHearing
        ? `translateX(${-normalizedLevel * 2.5}px) scale(${1 + normalizedLevel * 0.08})`
        : isSpeaking
          ? `scale(${1 + (normalizedLevel > 0.05 ? normalizedLevel * 0.06 : 0.03)})`
          : undefined,
      rightTransform: isHearing
        ? `translateX(${normalizedLevel * 2.5}px) scale(${1 + normalizedLevel * 0.08})`
        : isSpeaking
          ? `scale(${1 + (normalizedLevel > 0.05 ? normalizedLevel * 0.06 : 0.03)})`
          : undefined,
    };
  }, [isHovered, hoverMode, isBlinking, effectiveEmotion, isHearing, isSpeaking, normalizedLevel]);

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
            filter: `drop-shadow(0 6px 14px rgba(0, 0, 0, 0.75)) drop-shadow(0 0 12px ${colors.drop})`,
          }}
        >
          <defs>
            <filter id={`temyGlow-${effectiveEmotion}`} x="-25%" y="-25%" width="150%" height="150%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.0" result="glow" />
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

          {/* ── Character Face & Morphing Visemes ─────────────────────────── */}
          <g
            filter={`url(#temyGlow-${effectiveEmotion})`}
            className="transition-transform duration-150 ease-out"
            style={{
              transform: `translate(${currentGaze.x}px, ${currentGaze.y}px)`,
            }}
          >
            {/* Left Eye / Chevron */}
            <path
              d={eyeProps.leftPath}
              fill="none"
              stroke={colors.stroke}
              strokeWidth="9.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-all duration-150 ease-out"
              style={{
                transformOrigin: "34.5px 64px",
                transform: eyeProps.leftTransform,
              }}
            />

            {/* Center Mouth: Morphing Viseme or Expressive Path */}
            {mouthProps.customPath ? (
              <path
                d={mouthProps.customPath}
                fill="none"
                stroke={colors.stroke}
                strokeWidth="9.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-all duration-120 ease-out"
              />
            ) : (
              <rect
                x={mouthProps.x}
                y={mouthProps.y}
                width={mouthProps.width}
                height={mouthProps.height}
                rx={mouthProps.rx}
                ry={mouthProps.rx}
                fill={colors.stroke}
                className="transition-all duration-100 ease-out"
              />
            )}

            {/* Right Eye / Chevron */}
            <path
              d={eyeProps.rightPath}
              fill="none"
              stroke={colors.stroke}
              strokeWidth="9.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-all duration-150 ease-out"
              style={{
                transformOrigin: "93.5px 64px",
                transform: eyeProps.rightTransform,
              }}
            />
          </g>
        </svg>
      </div>

      {/* ── Floating Badge ──────────────────────────────────────────────── */}
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
            <span
              className="w-1.5 h-1.5 rounded-full shadow-[0_0_6px_rgba(101,196,102,0.8)] animate-pulse flex-shrink-0"
              style={{ backgroundColor: colors.stroke }}
            />
            <span className="opacity-95">{badge}</span>
          </div>
        </div>
      )}
    </div>
  );
};

