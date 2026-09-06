import React, { useEffect, useId, useMemo, useRef, useState } from "react";
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
 * A black **sphere** with a terminal face, `> _ <`, that behaves like someone
 * in the room rather than like an indicator.
 *
 * **The body is a ball; the face is still the wordmark.** The body used to be
 * a squircle — the app-icon tile, drawn a second time. A tile is a logo and
 * sits still. A ball has a side facing you, so everything the face already
 * does — leaning toward the pointer, widening at the operator, wandering off
 * and coming back — reads as a head turning rather than as a card being
 * nudged. The mark is untouched: the same `> _ <` at the same coordinates,
 * lit from inside the glass now instead of printed on a black square.
 *
 * **Nothing is drawn around the edge.** No rim, no border, no shadow — the
 * operator asked for all three gone, in that order, and they were right: a
 * stroke around a sphere is a circle drawn on top of it, and it flattens the
 * ball it was meant to finish. Sphericity is carried entirely by light *on*
 * the body: a key light fixed at the upper left, a bounce off the surface
 * below, occlusion gathering toward the silhouette, and a specular hotspot
 * that slides **against** the tilt — because the light stays in the room
 * while the head turns. Behind the body sits one soft white halo, dim enough
 * to read as air rather than as a glow, which is the only thing keeping the
 * black ball off a black page.
 *
 * The rule everything below follows:
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
  /*
    The drift belongs to the ball at rest only. While it is being spoken to it
    holds still and leans in — a listener who keeps bobbing is not listening —
    and while it speaks or thinks it already has motion of its own.
  */
  const float = breathKind === "breathe" ? "animate-orbFloat" : "";

  /*
    The ball, and where the light lands on it.

    The key light is fixed in the room at the upper left, so when the head
    tilts toward the pointer the highlight slides the *other* way. That
    counter-motion is most of what separates a sphere from a shaded disc, and
    it costs two subtractions.
  */
  const specX = 45 - currentGaze.tiltY * 0.55;
  const specY = 37 - currentGaze.tiltX * 0.55;

  /*
    One gradient namespace per instance. Two orbs are on screen at once — the
    composer's and the HUD's — and they are often in different states; sharing
    ids would let whichever mounted last repaint the other in its emotion.
  */
  const gid = `temy-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;

  const defaultTitle = isActive
    ? isSpeaking
      ? "Temy is speaking — speak to interrupt"
      : isHearing
        ? "Temy is hearing you"
        : isListening
          ? "Temy is listening"
          : "Temy is working on your request…"
    // Not "say Hey Temy": nothing is listening yet, and an orb that invites a
    // phrase no microphone can hear is a control that does nothing.
    : "Click to start a voice conversation";

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
        interactive ? "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-white/20 rounded-full" : ""
      } ${className}`}
      style={{
        width: size,
        height: size,
        perspective: 600,
      }}
    >
      {/*
        ── Air: the one halo, and it is white ─────────────────────────────────

        A black ball on a #151515 ground has nothing to sit against, and the
        first two attempts at fixing that were both wrong: a green drop-shadow
        that never went out, then a black one that read as a smudge. This is
        white, and deliberately dim — *"use a white glow, but not too light"* —
        so it registers as air behind the ball rather than as a light source in
        front of it. It does not change with state; it is not a signal.
      */}
      <div
        aria-hidden="true"
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          background: "radial-gradient(circle, rgba(255, 255, 255, 0.075) 0%, rgba(255, 255, 255, 0.03) 55%, transparent 74%)",
          transform: "scale(1.28)",
          filter: "blur(9px)",
        }}
      />

      {/*
        ── Aura: where sound is allowed to show ───────────────────────────────

        **The glow is for sound, and only for sound.** It used to be drawn in
        every state — faintly at idle, a little more on hover — and with a
        coloured drop-shadow under it that never went out. The operator, on the
        ball: *"i think it will look cleaner without the background glow and
        the green border."* They were right, and the reason is that a glow that
        is always on says nothing when it comes on. It now exists only while
        there is a voice to show — the operator's, or Temy's — so its arrival
        *is* the signal. Thinking keeps its orbiting arc and nothing else; idle,
        listening and hover are the bare ball.
      */}
      {(isHearing || isSpeaking) && (
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
      )}

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

      {/* ── Drift wraps breath wraps posture: three layers, because each of the
             three owns `transform` and they must not fight over it ─────────── */}
      <div className={`w-full h-full flex items-center justify-center ${float}`}>
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
                /*
                No filter. Every halo this orb has worn lived on this line: first a
                coloured one that was on in every state, then a black one that read
                as a smudge rather than as a shadow on a ground this dark. What
                separates the ball from the page now is its own shading and the one
                soft white halo above — nothing is drawn around its edge.
              */
              }}
            >
              <defs>
                {/* The body. Still the brand's black — it just has a direction to be black away from now. */}
                <radialGradient id={`${gid}-body`} cx="33%" cy="27%" r="84%">
                  <stop offset="0%" stopColor="#43434a" />
                  <stop offset="16%" stopColor="#232327" />
                  <stop offset="40%" stopColor="#111113" />
                  <stop offset="68%" stopColor="#050506" />
                  <stop offset="100%" stopColor="#000000" />
                </radialGradient>

                {/* Bounce: the surface below throws a little of Temy's own colour back up
                    under her. Without it the lower edge dies into the page and the ball
                    reads as a hole cut in it. */}
                <radialGradient id={`${gid}-bounce`} cx="63%" cy="90%" r="54%">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity="0.1" />
                  <stop offset="52%" stopColor="#ffffff" stopOpacity="0.03" />
                  <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
                </radialGradient>

                {/* The face is lit from inside the glass rather than painted on the front. */}
                <radialGradient id={`${gid}-core`} cx="50%" cy="53%" r="52%">
                  <stop offset="0%" stopColor={colors.stroke} stopOpacity="0.1" />
                  <stop offset="55%" stopColor={colors.stroke} stopOpacity="0.025" />
                  <stop offset="100%" stopColor={colors.stroke} stopOpacity="0" />
                </radialGradient>

                {/* Occlusion, gathering at the silhouette. */}
                <radialGradient id={`${gid}-occlusion`} cx="50%" cy="50%" r="50%">
                  <stop offset="60%" stopColor="#000000" stopOpacity="0" />
                  <stop offset="86%" stopColor="#000000" stopOpacity="0.5" />
                  <stop offset="100%" stopColor="#000000" stopOpacity="0.88" />
                </radialGradient>

                {/* The sheen the specular hotspot sits in. */}
                <radialGradient id={`${gid}-spec`} cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
                  <stop offset="42%" stopColor="#ffffff" stopOpacity="0.13" />
                  <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
                </radialGradient>

                {/* Everything on the body is cut to the silhouette, so no highlight
                    and no eye can bleed past the edge of the ball. */}
                <clipPath id={`${gid}-ball`}>
                  <circle cx="64" cy="64" r="62" />
                </clipPath>

                <filter id={`${gid}-glow`} x="-25%" y="-25%" width="150%" height="150%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="1.0" result="glow" />
                  <feMerge>
                    <feMergeNode in="glow" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>

                <filter id={`${gid}-soft`} x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="3.4" />
                </filter>
              </defs>

              {/* ── The ball ─────────────────────────────────────────────────── */}
              <g clipPath={`url(#${gid}-ball)`}>
                <circle cx="64" cy="64" r="62" fill={`url(#${gid}-body)`} />
                <circle cx="64" cy="64" r="62" fill={`url(#${gid}-bounce)`} />
                <circle cx="64" cy="64" r="62" fill={`url(#${gid}-core)`} />
                <circle cx="64" cy="64" r="62" fill={`url(#${gid}-occlusion)`} />

                {/* The sheen, then the hotspot inside it — both sliding against the
                    tilt, because the light does not turn with the head. */}
                <ellipse
                  cx={specX}
                  cy={specY}
                  rx="31"
                  ry="22"
                  fill={`url(#${gid}-spec)`}
                  filter={`url(#${gid}-soft)`}
                  opacity={isHovered || isActive ? 0.95 : 0.75}
                  transform={`rotate(-26 ${specX} ${specY})`}
                  className="transition-opacity duration-300"
                />
                <ellipse
                  cx={specX - 5}
                  cy={specY - 7}
                  rx="9"
                  ry="5.5"
                  fill="#ffffff"
                  opacity="0.3"
                  filter={`url(#${gid}-soft)`}
                  transform={`rotate(-26 ${specX - 5} ${specY - 7})`}
                />

                {/* The polished top: a crescent of glass just inside the silhouette,
                    which is the read that says "sphere" fastest. */}
                <path
                  d="M 17 47 A 53 53 0 0 1 105 40"
                  fill="none"
                  stroke="#ffffff"
                  strokeOpacity="0.16"
                  strokeWidth="3"
                  strokeLinecap="round"
                  filter={`url(#${gid}-soft)`}
                />
              </g>

              {/* ── The face ────────────────────────────────────────────────── */}
              <g
                filter={`url(#${gid}-glow)`}
                className="transition-transform duration-150 ease-out"
                style={{
                  transformOrigin: "64px 64px",
                  /*
                    Held a hair off the silhouette and travelling slightly further than the
                    gaze asks, so the mark reads as painted on a curved front face sliding
                    past us rather than as a decal dragged across a flat one. The glyph's
                    own coordinates are untouched.
                  */
                  transform: `translate(${currentGaze.x * 1.12}px, ${currentGaze.y * 1.12}px) scale(0.93)`,
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
