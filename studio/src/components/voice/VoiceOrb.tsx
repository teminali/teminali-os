import React, { useEffect, useMemo, useRef, useState } from "react";
import type { VoiceEmotion, VoiceState } from "../../services/voice";
import { auraFor, breathFor, eyeScaleFor, mouthFor, MOUTH_REST, VISEME_SHAPES } from "../../utils/orbExpression";

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
 * Temy — the face of the voice assistant.
 *
 * A black squircle with a terminal face, `> _ <`, that behaves like someone in
 * the room rather than like an indicator. The rule everything below follows:
 *
 * **Whose sound is it?** The one `level` prop carries the microphone while the
 * operator is heard and the synthesiser while Temy speaks, and the state says
 * which. Only while *speaking* may the level reach the mouth. While *hearing*
 * it reaches the aura around the face and nothing on the face itself. The
 * first version opened the mouth to the microphone in hearing mode — an
 * "equaliser" — and the operator's words came back to them as Temy's mouth
 * moving while they talked: *"how can his mouth move and I'm the one
 * talking?"* Listening is stillness with attention in it, not a mouth.
 *
 * So each state has its own tell, and they do not share body parts:
 *
 * - **idle** — a slow breath, a blink every few seconds, and now and then the
 *   eyes wander off and come back. Enough to be alive, not enough to distract.
 * - **listening** (open microphone, nobody talking) — the same, a little
 *   brighter, eyes on the operator.
 * - **hearing** (the operator is talking) — the face leans in, the eyes widen
 *   and hold still on the operator, the mouth stays closed, and the aura
 *   behind the face breathes with the operator's own voice. That aura is the
 *   whole of the "I hear you" feedback, and it is deliberately not on the face.
 * - **thinking** — a thin arc orbits behind the face and the eyes go
 *   asymmetric, the way a person's do when they look for a word. It stops the
 *   instant there is an answer.
 * - **speaking** — the mouth articulates phonemic visemes from the caption,
 *   gated and sized by Temy's own audio level, and the aura pulses with it.
 *
 * **The pointer is an eye, not a hand.** The face tracks the cursor and leans
 * toward it slightly when hovered. The earlier version also dodged, hopped
 * and jumped away from a pointer that came close — charming once, and a
 * control that runs from the click it exists to receive breaks the first
 * rule of controls. Gone.
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

  // Where the pointer is, as a gaze and a tilt
  const [mouseGaze, setMouseGaze] = useState<{ x: number; y: number; tiltX: number; tiltY: number }>({
    x: 0,
    y: 0,
    tiltX: 0,
    tiltY: 0,
  });

  // Idle daydreaming: the eyes wander off and come back
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

  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);

  // Audio-reactive level (clamped 0 to 1)
  const normalizedLevel = useMemo(() => {
    return Math.min(1, Math.max(0, level));
  }, [level]);

  /*
    The operator's voice, smoothed for the aura. The raw level jumps every
    frame and a glow that jumps reads as flicker, not as breath; a short
    attack and a longer release is what a listener's attention looks like.
  */
  const [heardLevel, setHeardLevel] = useState(0);
  useEffect(() => {
    if (!isHearing) {
      setHeardLevel(0);
      return;
    }
    let raf = 0;
    let current = 0;
    const tick = () => {
      const target = normalizedLevel;
      current += (target - current) * (target > current ? 0.35 : 0.08);
      setHeardLevel(current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // `normalizedLevel` is read live through the closure on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHearing]);
  // A blink every few seconds, when a blink would not contradict the face
  const [isBlinking, setIsBlinking] = useState(false);
  useEffect(() => {
    if (isSpeaking || isThinking || effectiveEmotion === "error") {
      setIsBlinking(false);
      return;
    }
    // Slightly rarer while being spoken to: attention holds the eyes open.
    const every = isHearing ? 6500 : 4500;
    const interval = setInterval(() => {
      setIsBlinking(true);
      setTimeout(() => setIsBlinking(false), 150);
    }, every);

    return () => clearInterval(interval);
  }, [isHearing, isSpeaking, isThinking, effectiveEmotion]);

  // Periodic wandering behaviour, only when nothing is happening
  useEffect(() => {
    if (!interactive || isActive || isHovered) {
      setDistraction((prev) => (prev.active ? { ...prev, active: false } : prev));
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    let cancelTimer: ReturnType<typeof setTimeout>;
    let stepTimer: ReturnType<typeof setTimeout>;

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

  // Real-time mouth sync: phonemic viseme sequencing, only while speaking
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

  // Pointer tracking: the eyes follow, the head tilts toward it
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

        const isOver =
          e.clientX >= rect.left - 6 &&
          e.clientX <= rect.right + 6 &&
          e.clientY >= rect.top - 6 &&
          e.clientY <= rect.bottom + 6;
        setIsHovered(isOver);
        if (!isOver) setIsPressed(false);

        setMouseGaze({ x: dx * 6.5, y: dy * 5.5, tiltX: -dy * 14, tiltY: dx * 14 });
      });
    };

    const handleMouseLeave = () => {
      setIsHovered(false);
      setIsPressed(false);
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

  /*
    Where the face is looking and how it is held.

    While the operator is talking the eyes are on them — the pointer is
    ignored for gaze and only faintly for tilt — and the whole face leans in.
    That lean is the one thing the microphone is allowed to move on the face,
    and it is a posture, not a mouth.
  */
  const currentGaze = useMemo(() => {
    if (isHearing) {
      return {
        x: 0,
        y: 0.6,
        tiltX: -3.5 + mouseGaze.tiltX * 0.25,
        tiltY: mouseGaze.tiltY * 0.25,
        headTilt: 0,
        lean: 1.035,
      };
    }
    if (distraction.active) {
      return {
        x: distraction.x,
        y: distraction.y,
        tiltX: distraction.tiltX,
        tiltY: distraction.tiltY,
        headTilt: distraction.headTilt,
        lean: 1,
      };
    }
    const emotionTilt = effectiveEmotion === "thinking" ? 4 : 0;
    return {
      x: mouseGaze.x,
      y: mouseGaze.y,
      tiltX: mouseGaze.tiltX,
      tiltY: mouseGaze.tiltY,
      headTilt: emotionTilt,
      lean: isHovered ? 1.05 : 1,
    };
  }, [isHearing, distraction, mouseGaze, effectiveEmotion, isHovered]);

  // The mouth. The microphone never reaches it — `utils/orbExpression.ts`
  // is where that is decided and pinned; this only adds the emotional shapes.
  const mouthProps = useMemo(() => {
    if (isSpeaking || isHearing) {
      return { ...mouthFor(state, normalizedLevel, visemeSequence[visemeIndex] ?? 0), customPath: null as string | null };
    }

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

    return { ...MOUTH_REST, customPath: null };
  }, [state, isHearing, isSpeaking, isThinking, effectiveEmotion, distraction.active, normalizedLevel, visemeIndex, visemeSequence]);

  // The eyes
  const eyeProps = useMemo(() => {
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

    // Hearing: wider and still — no level in here, attention does not twitch
    // with the other person's volume. Speaking: a little of Temy's own voice.
    const scale = eyeScaleFor(state, normalizedLevel);
    return {
      leftPath: "M 26 48 L 43 64 L 26 80",
      rightPath: "M 102 48 L 85 64 L 102 80",
      leftTransform: `scale(${scale})`,
      rightTransform: `scale(${scale})`,
    };
  }, [isBlinking, effectiveEmotion, state, normalizedLevel]);

  /*
    The aura: the one place sound is allowed to show that is not the face.

    Hearing — the operator's voice, smoothed, as a breath behind the face.
    Speaking — Temy's own voice, a tighter pulse. Thinking — a soft constant
    glow under the orbiting arc. Idle — barely there, and brighter on hover.
  */
  const aura = useMemo(
    () => auraFor(state, { heard: heardLevel, own: normalizedLevel, hovered: isHovered }),
    [state, heardLevel, normalizedLevel, isHovered],
  );

  const breathKind = breathFor(state);
  const breath = breathKind === "attend" ? "animate-orbAttend" : breathKind === "breathe" ? "animate-orbBreathe" : "";

  const cornerRadius = 28;

  const defaultTitle = isActive
    ? isSpeaking
      ? "Temy is speaking — speak to interrupt"
      : isHearing
        ? "Temy is hearing you"
        : isListening
          ? 'Temy is listening — say "Hey Temy"'
          : "Temy is working on your request…"
    : 'Say "Hey Temy" or click to start voice conversation';

  // The thinking arc sits just outside the body
  const ringInset = -Math.round(size * 0.09);

  return (
    <div
      ref={containerRef}
      data-testid="teminali-voice-orb"
      data-voice-state={state}
      role={interactive ? "button" : "presentation"}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onClick : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        setIsPressed(false);
      }}
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
      {/* ── Aura: where sound is allowed to show ─────────────────────────── */}
      <div
        aria-hidden="true"
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          background: `radial-gradient(circle, ${colors.glow} 0%, ${colors.drop} 45%, transparent 72%)`,
          opacity: aura.opacity,
          transform: `scale(${aura.scale})`,
          transition: isHearing ? "opacity 90ms linear, transform 90ms linear" : "opacity 320ms ease, transform 320ms ease",
          filter: "blur(6px)",
        }}
      />

      {/* ── Thinking: one thin arc orbiting behind the face ───────────────── */}
      {isThinking && (
        <svg
          aria-hidden="true"
          className="absolute pointer-events-none animate-orbThink"
          style={{ inset: ringInset, width: size - ringInset * 2, height: size - ringInset * 2 }}
          viewBox="0 0 100 100"
        >
          <circle
            cx="50"
            cy="50"
            r="47"
            fill="none"
            stroke={colors.stroke}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeDasharray="70 226"
            opacity="0.85"
          />
        </svg>
      )}

      {/* ── Breath (CSS) wraps posture (inline), so the two transforms never fight */}
      <div className={`w-full h-full flex items-center justify-center ${breath}`}>
        <div
          className="w-full h-full flex items-center justify-center transition-transform"
          style={{
            transform: `rotateX(${currentGaze.tiltX}deg) rotateY(${currentGaze.tiltY}deg) rotate(${currentGaze.headTilt}deg) scale(${
              isPressed ? 0.94 : currentGaze.lean
            })`,
            transformStyle: "preserve-3d",
            transitionDuration: isHearing ? "360ms" : "420ms",
            transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
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

            {/* Pure black squircle body */}
            <rect width="128" height="128" rx={cornerRadius} ry={cornerRadius} fill="#000000" />

            {/* Razor-thin edge sheen; a touch brighter when attended to */}
            <rect
              x="1"
              y="1"
              width="126"
              height="126"
              rx={cornerRadius - 1}
              ry={cornerRadius - 1}
              fill="none"
              stroke={isHovered || isHearing ? "rgba(255, 255, 255, 0.14)" : "rgba(255, 255, 255, 0.08)"}
              strokeWidth="1.2"
              className="transition-[stroke] duration-300"
            />

            {/* ── The face ────────────────────────────────────────────────── */}
            <g
              filter={`url(#temyGlow-${effectiveEmotion})`}
              className="transition-transform duration-150 ease-out"
              style={{
                transform: `translate(${currentGaze.x}px, ${currentGaze.y}px)`,
              }}
            >
              {/* Left eye */}
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

              {/* Mouth: visemes while speaking, a still line otherwise */}
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

              {/* Right eye */}
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
      </div>

      {/* ── Floating badge ─────────────────────────────────────────────────── */}
      {badge && (
        <div className="absolute top-[calc(100%+12px)] left-1/2 -translate-x-1/2 pointer-events-none select-none whitespace-nowrap z-20">
          <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#121214]/90 backdrop-blur-md border border-white/10 shadow-[0_4px_12px_rgba(0,0,0,0.6)] text-[11px] font-medium tracking-tight text-neutral-300">
            <span
              className={`w-1.5 h-1.5 rounded-full shadow-[0_0_6px_rgba(101,196,102,0.8)] flex-shrink-0 ${isActive ? "animate-pulse" : ""}`}
              style={{ backgroundColor: colors.stroke }}
            />
            <span className="opacity-95">{badge}</span>
          </div>
        </div>
      )}
    </div>
  );
};
