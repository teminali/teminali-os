/**
 * What Temy's face does in each state — as rules, without the face.
 *
 * Pure and dependency-free, so the one thing that matters most can be pinned
 * by a test that needs no browser: **the microphone never reaches the
 * mouth.** The orb has one `level` prop that carries the operator's voice
 * while they are heard and Temy's own while Temy speaks, and the state says
 * which. The first version opened the mouth to the level in hearing mode, and
 * the operator watched Temy's mouth move while they talked. These functions
 * are where that cannot happen again: `mouthFor("hearing", 1)` is
 * `mouthFor("hearing", 0)`, and a test says so.
 *
 * The component owns everything visual — paths, colours, timing. This owns
 * only the decisions: which part of the face a sound is allowed to touch, and
 * how much.
 */

import type { VoiceState } from "../services/voice/types";

export interface MouthShape {
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
}

/** The resting mouth: the underscore in `> _ <`. */
export const MOUTH_REST: MouthShape = { x: 50, y: 72, width: 28, height: 9.5, rx: 4.75 };

/** Closed and still, for while someone else is talking. A touch narrower than rest. */
export const MOUTH_ATTENTIVE: MouthShape = { x: 51, y: 72.5, width: 26, height: 8, rx: 4 };

/** Below this Temy's synthesiser is between clauses; the mouth closes rather than flapping at silence. */
export const SPEECH_FLOOR = 0.035;

/** The six phonemic viseme shapes, indexed by `textToVisemes`. */
export const VISEME_SHAPES: ReadonlyArray<{ width: number; height: number; rx: number }> = [
  { width: 26, height: 7, rx: 3.5 }, // 0: bilabial / rest
  { width: 28, height: 11, rx: 5.5 }, // 1: dental consonant
  { width: 38, height: 14, rx: 7 }, // 2: wide spread vowel
  { width: 30, height: 22, rx: 11 }, // 3: open mid vowel
  { width: 24, height: 28, rx: 12 }, // 4: open tall vowel
  { width: 19, height: 19, rx: 9.5 }, // 5: round pucker vowel
];

/**
 * The mouth, given the state and the level.
 *
 * Only `speaking` reads `level`. Every other state returns a shape that does
 * not depend on it, which is the invariant this file exists for.
 */
export function mouthFor(state: VoiceState, level: number, viseme = 0): MouthShape {
  if (state === "speaking") {
    const own = Math.min(1, Math.max(0, level));
    if (own < SPEECH_FLOOR) return { x: 50, y: 72, width: 28, height: 8.5, rx: 4.25 };
    const target = VISEME_SHAPES[viseme] ?? VISEME_SHAPES[0];
    const width = target.width + own * 8;
    const height = Math.max(7, target.height * (0.6 + own * 0.8));
    const rx = Math.min(width / 2, Math.max(3.5, target.rx * (0.7 + own * 0.5)));
    return { x: 64 - width / 2, y: 77 - height / 2, width, height, rx };
  }
  if (state === "hearing") return MOUTH_ATTENTIVE;
  return MOUTH_REST;
}

export interface Aura {
  opacity: number;
  scale: number;
}

/**
 * The glow behind the face — the one place sound is allowed to show that is
 * not the face. `heard` is the operator's level, already smoothed; `own` is
 * Temy's. Each state reads at most one of them.
 */
export function auraFor(state: VoiceState, { heard = 0, own = 0, hovered = false } = {}): Aura {
  const h = Math.min(1, Math.max(0, heard));
  const o = Math.min(1, Math.max(0, own));
  switch (state) {
    case "hearing":
      return { opacity: 0.28 + h * 0.62, scale: 1.12 + h * 0.42 };
    case "speaking":
      return { opacity: 0.22 + o * 0.45, scale: 1.1 + o * 0.22 };
    case "deciding":
    case "thinking":
      return { opacity: 0.22, scale: 1.18 };
    case "repairing":
    case "sending":
    case "review":
      return { opacity: 0.18, scale: 1.12 };
    case "listening":
      return { opacity: hovered ? 0.22 : 0.14, scale: 1.1 };
    default:
      return { opacity: hovered ? 0.16 : 0.07, scale: 1.06 };
  }
}

/** How the eyes are held: wider and still while being spoken to; a little of Temy's own voice while speaking. */
export function eyeScaleFor(state: VoiceState, level: number): number {
  if (state === "hearing") return 1.1;
  if (state === "speaking") {
    const own = Math.min(1, Math.max(0, level));
    return 1 + (own > 0.05 ? own * 0.06 : 0.03);
  }
  return 1;
}

/** Which breath the body takes. Speaking and thinking have their own motion and take none. */
export function breathFor(state: VoiceState): "attend" | "breathe" | "none" {
  if (state === "hearing") return "attend";
  if (state === "speaking" || state === "thinking" || state === "deciding") return "none";
  return "breathe";
}
