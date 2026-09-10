import React, { useEffect, useRef } from "react";

export interface TemiCanvasOrbProps {
  userEnergy?: number;
  assistantEnergy?: number;
  isTTSPlaying?: boolean;
  isHearing?: boolean;
  isThinking?: boolean;
  getAudioState?: () => { userEnergy: number; assistantEnergy: number; isTTSPlaying: boolean };
  size?: number;
  onClick?: () => void;
  className?: string;
}

/*
  The face is the logo.

  `teminali-logo-512.png` is `>` `_` `<` — a terminal prompt that is already an
  emoticon. So the orb does not get a face *added* to it; the mark is drawn onto
  the bead and then given the things a still mark cannot have: a gaze that
  follows the pointer, lids that blink on their own schedule, brows that carry
  the state, and a mouth driven by the same audio energy the orb pulses to.

  Every literal below collapses back to the logo at rest: openness 1, brow 0,
  mouth 0 draws exactly `>` `_` `<`. Expression is a departure from the mark and
  returns to it, which is why the idle orb still reads as the brand.
*/

/** Expression per state. `open` scales the chevrons' vertical reach; `brow`
 *  rotates their open side (+ alert, − narrowed); `curve` bows the mouth. */
interface Expression { open: number; brow: number; squint: number; curve: number; width: number }

const NEUTRAL: Expression = { open: 1, brow: 0, squint: 0, curve: 0, width: 1 };
const IDLE: Expression = { open: 0.84, brow: 0, squint: 0, curve: 0.20, width: 1 };
const LISTENING: Expression = { open: 1.14, brow: 0.13, squint: 0, curve: 0.06, width: 0.88 };
const THINKING: Expression = { open: 0.72, brow: -0.08, squint: 0.34, curve: -0.1, width: 0.74 };
const SPEAKING: Expression = { open: 0.96, brow: 0.05, squint: 0, curve: 0.1, width: 1.06 };
const STARTLED: Expression = { open: 0.3, brow: -0.34, squint: 1, curve: -0.3, width: 0.82 };
const GREETING: Expression = { open: 1.12, brow: 0.18, squint: 0, curve: 0.34, width: 0.98 };

/*
  Colour as data, not as branches.

  Hover has to *blend* in: an orb that snaps to amber under the pointer reads as
  a CSS `:hover`, which is the one thing this orb is not. So every state carries
  the same shape - three glow stops, five shader stops, all RGBA - and the frame
  eases the displayed palette toward whichever state is current. State changes
  cross-fade for free, which they never did before.
*/
type Stop = [number, [number, number, number, number]];

const GLOW_RIPPLE: Stop[] = [[0, [244, 63, 94, 0.45]], [0.65, [244, 63, 94, 0.22]], [1, [0, 0, 0, 0]]];
const GLOW_HOVER: Stop[] = [[0, [253, 230, 138, 0.5]], [0.7, [245, 158, 11, 0.24]], [1, [0, 0, 0, 0]]];
const GLOW_SPEAKING: Stop[] = [[0, [134, 239, 172, 0.55]], [0.65, [0, 191, 99, 0.28]], [1, [0, 0, 0, 0]]];
const GLOW_LISTENING: Stop[] = [[0, [110, 231, 183, 0.5]], [0.7, [16, 185, 129, 0.22]], [1, [0, 0, 0, 0]]];
const GLOW_THINKING: Stop[] = [[0, [45, 212, 191, 0.5]], [0.7, [13, 148, 136, 0.25]], [1, [0, 0, 0, 0]]];
const GLOW_IDLE: Stop[] = [[0, [187, 247, 208, 0.26]], [0.65, [74, 222, 128, 0.12]], [1, [0, 0, 0, 0]]];

const ORB_RIPPLE: Stop[] = [[0, [255, 255, 255, 1]], [0.25, [253, 164, 175, 1]], [0.55, [251, 113, 133, 1]], [0.82, [244, 63, 94, 1]], [1, [136, 19, 55, 1]]];
const ORB_HOVER: Stop[] = [[0, [255, 255, 255, 1]], [0.28, [254, 243, 199, 1]], [0.6, [252, 211, 77, 1]], [0.88, [245, 158, 11, 1]], [1, [120, 53, 15, 1]]];
const ORB_SPEAKING: Stop[] = [[0, [255, 255, 255, 1]], [0.25, [220, 252, 231, 1]], [0.55, [74, 222, 128, 1]], [0.82, [0, 191, 99, 1]], [1, [4, 80, 43, 1]]];
const ORB_LISTENING: Stop[] = [[0, [255, 255, 255, 1]], [0.28, [236, 253, 245, 1]], [0.6, [110, 231, 183, 1]], [0.88, [16, 185, 129, 1]], [1, [6, 95, 70, 1]]];
const ORB_THINKING: Stop[] = [[0, [255, 255, 255, 1]], [0.28, [204, 251, 241, 1]], [0.6, [45, 212, 191, 1]], [0.88, [13, 148, 136, 1]], [1, [19, 78, 74, 1]]];
/** Idle: luminous milky crystal pearl. */
const ORB_IDLE: Stop[] = [[0, [255, 255, 255, 1]], [0.28, [240, 253, 244, 1]], [0.55, [187, 247, 208, 1]], [0.82, [74, 222, 128, 1]], [1, [22, 163, 74, 1]]];

/*
  The screen.

  The name is a terminal and the mark is a prompt, so the bead is not a pearl
  with a face drawn on it - it is a screen in a lit bezel. A black plate is laid
  over the shader, opaque through the core and gone before the contour, which
  costs the state ladder nothing: hue was never read from the middle of the orb,
  it is read from the rim and the halo, and the plate deliberately reaches
  neither. The mark then inverts to phosphor white, which is what a prompt on a
  terminal has always been.

  Not pure #000: a black with a trace of the brand hue in it sits on the green
  rim without the seam a neutral black shows against a saturated edge.
*/
const SCREEN: Stop[] = [[0, [2, 9, 6, 1]], [0.58, [3, 12, 8, 1]], [0.80, [5, 17, 11, 0.88]], [1, [7, 24, 15, 0]]];

/** The open mouth is a lens of light, not a white slab. */
const MOUTH_LIGHT = "rgba(190, 255, 222, 0.26)";

const cloneStops = (stops: Stop[]): Stop[] => stops.map(([at, c]) => [at, [...c] as Stop[1]]);

/** Ease `into` toward `target` in place. Both are always the same shape. */
function easeStops(into: Stop[], target: Stop[], t: number): void {
  for (let i = 0; i < into.length; i++) {
    into[i][0] += (target[i][0] - into[i][0]) * t;
    for (let c = 0; c < 4; c++) into[i][1][c] += (target[i][1][c] - into[i][1][c]) * t;
  }
}

function paint(gradient: CanvasGradient, stops: Stop[]): void {
  for (const [at, [r, g, b, a]] of stops) {
    gradient.addColorStop(Math.min(1, Math.max(0, at)), `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(3)})`);
  }
}

/** One blink, in seconds: shut fast, hold, open slower — the asymmetry is what
 *  separates a blink from a pulse. */
const BLINK_DURATION = 0.2;
const smoothstep = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How shut the lids are, 0..1, across one blink. */
function lidCurve(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 0;
  return u < 0.34 ? smoothstep(u / 0.34) : 1 - smoothstep((u - 0.34) / 0.66);
}

export const TemiCanvasOrb: React.FC<TemiCanvasOrbProps> = ({
  userEnergy = 0,
  assistantEnergy = 0,
  isTTSPlaying = false,
  isHearing = false,
  isThinking = false,
  getAudioState,
  size = 136,
  onClick,
  className = "",
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rippleRef = useRef(0);
  const phaseRef = useRef(0);

  /* Life state lives on refs, not in the effect: the render effect restarts on
     every energy prop change, and a blink that reset itself each time would
     tick like a metronome instead of a habit. */
  const clockRef = useRef(0);
  const lastFrameRef = useRef(0);
  const pointerRef = useRef({ x: 0, y: 0, seen: false });
  const rectRef = useRef<DOMRect | null>(null);
  const gazeRef = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const microRef = useRef({ x: 0, y: 0, at: 0.8 });
  const blinkRef = useRef({ at: 1.6, started: -1, queued: false });
  const mouthRef = useRef(0);
  const faceRef = useRef<Expression>({ ...NEUTRAL });
  const hoverRef = useRef(false);
  const glowRef = useRef<Stop[]>(cloneStops(GLOW_IDLE));
  const shaderRef = useRef<Stop[]>(cloneStops(ORB_IDLE));

  // Expose ripple trigger for interruptions/clicks
  const triggerInterruptionWave = () => {
    rippleRef.current = 1.0;
  };

  /* Tracked on the window, not the canvas: an orb whose eyes only wake when the
     pointer is already on it is a hover effect. Watching the pointer cross the
     room is the thing that reads as alive. */
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY, seen: true };
    };
    const onLeave = () => {
      pointerRef.current.seen = false;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let rectAge = 99;

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;
      const cx = width / 2;
      const cy = height / 2;
      const baseRadius = 36 * (width / 144);

      ctx.clearRect(0, 0, width, height);

      // Wall-clock, so blinks and saccades keep their timing on a slow frame.
      const now = performance.now() / 1000;
      const dt = lastFrameRef.current ? Math.min(0.05, now - lastFrameRef.current) : 0.016;
      lastFrameRef.current = now;
      clockRef.current += dt;
      const clock = clockRef.current;

      phaseRef.current += 0.035;
      if (rippleRef.current > 0) {
        rippleRef.current -= 0.045;
        if (rippleRef.current < 0) rippleRef.current = 0;
      }

      const liveState = getAudioState ? getAudioState() : { userEnergy, assistantEnergy, isTTSPlaying };
      const currentUE = liveState.userEnergy ?? userEnergy;
      const currentAE = liveState.assistantEnergy ?? assistantEnergy;
      const currentPlaying = liveState.isTTSPlaying ?? isTTSPlaying;

      const activeUserEnergy = isHearing ? Math.max(currentUE, 0.2) : currentUE;
      const activeAssistantEnergy = currentPlaying ? Math.max(currentAE, 0.25) : currentAE;
      const totalEnergy = activeUserEnergy * 1.6 + activeAssistantEnergy * 1.9 + (isThinking ? 0.35 : 0);
      const audioExpansion = Math.min(totalEnergy * 13, 12);
      const radius = baseRadius + audioExpansion + rippleRef.current * 10;

      // 1. Ambient luminous diffused glow
      const glowRadius = radius * 1.65;
      const hovering = hoverRef.current;
      /* Click beats hover: the ripple is the interrupt, and being told to stop
         outranks being pointed at. */
      const wantGlow = rippleRef.current > 0
        ? GLOW_RIPPLE
        : hovering
          ? GLOW_HOVER
          : isTTSPlaying
            ? GLOW_SPEAKING
            : activeUserEnergy > 0.05
              ? GLOW_LISTENING
              : isThinking
                ? GLOW_THINKING
                : GLOW_IDLE;
      easeStops(glowRef.current, wantGlow, Math.min(1, dt * 12));
      const ambientGlow = ctx.createRadialGradient(cx, cy, radius * 0.4, cx, cy, glowRadius);
      paint(ambientGlow, glowRef.current);

      ctx.beginPath();
      ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2);
      ctx.fillStyle = ambientGlow;
      ctx.fill();

      // 2. Liquid organic caustic contour
      ctx.save();
      ctx.beginPath();

      const points = 64;
      for (let i = 0; i <= points; i++) {
        const angle = (i / points) * Math.PI * 2;
        const wave =
          Math.sin(angle * 4 + phaseRef.current * 1.8) * (1.1 + totalEnergy * 4.8) +
          Math.cos(angle * 3 - phaseRef.current * 1.3) * (0.8 + totalEnergy * 3.4);
        const r = radius + wave;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.clip();

      // 3. Pearlescent multi-stop liquid shader
      const highlightX = cx - radius * 0.26 + Math.cos(phaseRef.current) * 3;
      const highlightY = cy - radius * 0.3 + Math.sin(phaseRef.current) * 3;

      const wantOrb = rippleRef.current > 0
        ? ORB_RIPPLE
        : hovering
          ? ORB_HOVER
          : isTTSPlaying
            ? ORB_SPEAKING
            : activeUserEnergy > 0.05
              ? ORB_LISTENING
              : isThinking
                ? ORB_THINKING
                : ORB_IDLE;
      easeStops(shaderRef.current, wantOrb, Math.min(1, dt * 12));
      const orbGrad = ctx.createRadialGradient(highlightX, highlightY, 2, cx, cy, radius * 1.25);
      paint(orbGrad, shaderRef.current);

      ctx.fillStyle = orbGrad;
      ctx.fillRect(0, 0, width, height);

      /* The plate. Centred on the bead rather than on the highlight: the screen
         is flat and the glass over it is what moves. */
      const screenRadius = radius * 0.88;
      const screen = ctx.createRadialGradient(cx, cy, 0, cx, cy, screenRadius);
      paint(screen, SCREEN);
      ctx.beginPath();
      ctx.arc(cx, cy, screenRadius, 0, Math.PI * 2);
      ctx.fillStyle = screen;
      ctx.fill();

      /* ---------------------------------------------------------------- FACE

         Drawn inside the contour clip and *under* the specular sheen, so the
         glass passes over the features. A face drawn on top of the highlight
         sits on the bead like a sticker; drawn beneath it, it is in the bead.
      */

      // Where the pointer is, relative to the orb's centre on screen. The rect
      // is a layout read, so it is refreshed a few times a second, not 60.
      if (++rectAge > 15) {
        rectRef.current = canvas.getBoundingClientRect();
        rectAge = 0;
      }
      const rect = rectRef.current;
      let targetX = 0;
      let targetY = 0;
      if (rect && pointerRef.current.seen) {
        const dx = pointerRef.current.x - (rect.left + rect.width / 2);
        const dy = pointerRef.current.y - (rect.top + rect.height / 2);
        const dist = Math.hypot(dx, dy);
        if (dist > 0.001) {
          // Saturates quickly: eyes look *at* a thing, they do not lerp to it.
          const reach = Math.min(1, dist / 130);
          targetX = (dx / dist) * reach;
          targetY = (dy / dist) * reach;
        }
      }

      /* Thinking looks away. Up-and-left is where a person's eyes go to recall
         something, and it is the cheapest possible signal that she is not
         waiting on you. */
      if (isThinking) {
        targetX = -0.55 + Math.sin(clock * 0.9) * 0.16;
        targetY = -0.62 + Math.cos(clock * 0.63) * 0.12;
      }

      // Micro-saccades. Real eyes never hold still; perfectly steady ones are
      // the single loudest tell that a face is a graphic.
      if (clock > microRef.current.at) {
        microRef.current = {
          x: (Math.random() - 0.5) * 0.13,
          y: (Math.random() - 0.5) * 0.1,
          at: clock + 0.42 + Math.random() * 1.1,
        };
      }
      targetX += microRef.current.x;
      targetY += microRef.current.y;

      // Underdamped spring (omega ~5.1, damping 7.4 against a critical 10.2):
      // the gaze overshoots a little and settles, the way an eye actually lands.
      const gaze = gazeRef.current;
      gaze.vx += ((targetX - gaze.x) * 26 - gaze.vx * 7.4) * dt;
      gaze.vy += ((targetY - gaze.y) * 26 - gaze.vy * 7.4) * dt;
      gaze.x += gaze.vx * dt;
      gaze.y += gaze.vy * dt;

      // Blinks on their own schedule, with the occasional double.
      const blink = blinkRef.current;
      if (blink.started < 0 && clock >= blink.at) {
        blink.started = clock;
        blink.queued = Math.random() < 0.22;
      }
      let lid = 0;
      if (blink.started >= 0) {
        const u = (clock - blink.started) / BLINK_DURATION;
        lid = lidCurve(u);
        if (u >= 1) {
          blink.started = -1;
          blink.at = blink.queued ? clock + 0.13 : clock + 2.2 + Math.random() * 4.4;
        }
      }
      // A startled orb holds its eyes shut a beat longer than a blink does.
      lid = Math.max(lid, rippleRef.current * 0.55);

      const wanted = rippleRef.current > 0.02
        ? STARTLED
        : currentPlaying
          ? SPEAKING
          : activeUserEnergy > 0.05
            ? LISTENING
            : isThinking
              ? THINKING
              : hovering
                ? GREETING
                : IDLE;

      // Expressions are eased into, never swapped: a face that snaps between
      // states reads as a sprite sheet.
      const face = faceRef.current;
      const ease = Math.min(1, dt * 7.5);
      face.open += (wanted.open - face.open) * ease;
      face.brow += (wanted.brow - face.brow) * ease;
      face.squint += (wanted.squint - face.squint) * ease;
      face.curve += (wanted.curve - face.curve) * ease;
      face.width += (wanted.width - face.width) * ease;

      // The mouth opens fast and closes slow, because that is what a mouth does.
      const mouthTarget = currentPlaying ? clamp01(activeAssistantEnergy * 3.1) : 0;
      mouthRef.current += (mouthTarget - mouthRef.current) * Math.min(1, dt * (mouthTarget > mouthRef.current ? 26 : 9));
      const mouthOpen = mouthRef.current;

      // Breathing: a slow scale the energy pulse never masks, so she is visibly
      // alive even in total silence.
      const breath = 1 + Math.sin(clock * 1.35) * 0.014;

      /* Phosphor, not ink: on the plate the mark is lit rather than printed.
         The pale second colour is no longer a bevel - a lift made sense when the
         mark was dark on a pale bead and reads as a smear on a lit one - it is a
         bloom drawn concentric and wide underneath. */
      const ink = "rgba(236, 255, 244, 0.96)";
      const bloom = "rgba(190, 255, 222, 0.20)";
      const stroke = radius * 0.115;
      const eyeDX = radius * 0.44;
      const eyeY = -radius * 0.08;
      const eyeReachY = radius * 0.3;
      const eyeReachX = radius * 0.17;
      const mouthY = radius * 0.3;
      const mouthHalf = radius * 0.27;

      ctx.save();
      // The face sits on a sphere: it tilts and slides with the gaze, and the
      // eyes travel further than the mouth, which is what gives it depth.
      ctx.translate(cx + gaze.x * radius * 0.06, cy + gaze.y * radius * 0.05);
      ctx.rotate(gaze.x * 0.075);
      ctx.scale(breath, breath);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = stroke;

      const eyeShiftX = gaze.x * radius * 0.09;
      const eyeShiftY = gaze.y * radius * 0.075;
      const openness = Math.max(0.06, face.open * (1 - lid));

      /* One chevron. `dir` is +1 for the `>` on the left and −1 for the `<` on
         the right, so both point inward exactly as the mark does. */
      const chevron = (ox: number, dir: number, offset: number) => {
        const reachX = eyeReachX * (1 - face.squint * 0.22);
        const reachY = eyeReachY * openness;
        const brow = face.brow * eyeReachY * 0.55;
        const ax = ox - dir * reachX;
        ctx.beginPath();
        ctx.moveTo(ax, eyeY + eyeShiftY - reachY - brow + offset);
        ctx.lineTo(ox + dir * reachX, eyeY + eyeShiftY + offset);
        ctx.lineTo(ax, eyeY + eyeShiftY + reachY - brow + offset);
        ctx.stroke();
      };

      /* The mouth is two lips that coincide at rest. At `mouthOpen` 0 they draw
         one round-capped bar — the logo's `_` exactly — and separate from there,
         so no state ever loses the mark. */
      const lips = (offset: number, fill: boolean) => {
        const half = mouthHalf * face.width;
        const gap = mouthOpen * radius * 0.34;
        const bow = -face.curve * radius * 0.13;
        const y = mouthY + gaze.y * radius * 0.03 + offset;
        const x = gaze.x * radius * 0.045;
        // Both lips start and end at the same two corners; only their control
        // points differ, so gap 0 collapses them onto one bar - the logo's `_`.
        const upCtl = y - gap * 0.5 + bow;
        const downCtl = y + gap * 1.15 + bow;
        if (fill && gap > 0.4) {
          const previousFill = ctx.fillStyle;
          ctx.fillStyle = MOUTH_LIGHT;
          ctx.beginPath();
          ctx.moveTo(x - half, y);
          ctx.quadraticCurveTo(x, upCtl, x + half, y);
          ctx.quadraticCurveTo(x, downCtl, x - half, y);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = previousFill;
        }
        ctx.beginPath();
        ctx.moveTo(x - half, y);
        ctx.quadraticCurveTo(x, upCtl, x + half, y);
        ctx.stroke();
        if (gap > 0.4) {
          ctx.beginPath();
          ctx.moveTo(x - half, y);
          ctx.quadraticCurveTo(x, downCtl, x + half, y);
          ctx.stroke();
        }
      };

      // The bloom: identical geometry, a wider softer line, no offset. Offset it
      // and it reads as a double stroke - a defect this file already shipped once
      // - where concentric it reads as light coming off the glyph.
      ctx.strokeStyle = bloom;
      ctx.lineWidth = stroke * 2.2;
      chevron(-eyeDX + eyeShiftX, 1, 0);
      chevron(eyeDX + eyeShiftX, -1, 0);
      lips(0, false);
      ctx.lineWidth = stroke;

      ctx.strokeStyle = ink;
      ctx.fillStyle = ink;
      chevron(-eyeDX + eyeShiftX, 1, 0);
      chevron(eyeDX + eyeShiftX, -1, 0);
      lips(0, true);
      ctx.restore();

      /* 4. Specular sheen.

         Over a black screen this has to be a glancing arc near the rim, not the
         broad disc a pale bead could carry. At its old strength and position it
         read as a thumbprint smudged across the left eye - the same washing-out
         that once cost it 0.62 → 0.40, except black gives it nowhere to hide.
         So it is pushed off the face toward the upper-left bezel, flattened,
         dropped to 0.16, and given a gradient so it has no edge to notice.

         The gradient is built round, before the squash: a canvas gradient is
         fixed in the user space it was created in, so the transform below
         flattens the falloff with the path instead of leaving a hard rim where
         a circular fade meets an elliptical hole. */
      const sheenX = cx - radius * 0.42;
      const sheenY = cy - radius * 0.46;
      const sheenR = radius * 0.44;
      const sheen = ctx.createRadialGradient(sheenX, sheenY, 0, sheenX, sheenY, sheenR);
      sheen.addColorStop(0, "rgba(255, 255, 255, 0.16)");
      sheen.addColorStop(0.55, "rgba(255, 255, 255, 0.06)");
      sheen.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.save();
      ctx.translate(sheenX, sheenY);
      ctx.rotate(Math.PI / 4);
      ctx.scale(1, 0.4);
      ctx.rotate(-Math.PI / 4);
      ctx.translate(-sheenX, -sheenY);
      ctx.beginPath();
      ctx.arc(sheenX, sheenY, sheenR, 0, Math.PI * 2);
      ctx.fillStyle = sheen;
      ctx.fill();
      ctx.restore();

      ctx.restore();

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [userEnergy, assistantEnergy, isTTSPlaying, isHearing, isThinking]);

  return (
    <div
      onClick={() => {
        triggerInterruptionWave();
        onClick?.();
      }}
      onPointerEnter={() => {
        hoverRef.current = true;
      }}
      onPointerLeave={() => {
        hoverRef.current = false;
      }}
      role="button"
      tabIndex={0}
      className={`relative flex items-center justify-center cursor-pointer select-none transition-transform active:scale-95 ${className}`}
      style={{ width: size, height: size }}
      title="Temi Voice Orb (Tap to speak / interrupt)"
    >
      <canvas ref={canvasRef} width={size * 2} height={size * 2} style={{ width: size, height: size }} />
    </div>
  );
};
