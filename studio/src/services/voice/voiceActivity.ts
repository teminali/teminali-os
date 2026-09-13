/**
 * Voice activity — was this frame speech?
 *
 * Split out of `audioGraph.ts` so it can be exercised without an AudioContext,
 * the same way `prosody.ts` and `turnTaking.ts` are: everything here is
 * arithmetic over five numbers the graph already has for every frame.
 */

/**
 * How periodic a frame must be before periodicity alone counts as speech.
 *
 * `prosody.ts` will not report an `f0` below 0.55 clarity at all, so these sit
 * above that: 0.7 is a vowel, and the run of frames a word is made of clears it
 * comfortably. The ducked bar is higher because the assistant's own voice is
 * also periodic and must not read as the operator interrupting.
 */
export const PITCH_CLARITY = 0.7;
export const PITCH_CLARITY_DUCKED = 0.82;

/** One frame, reduced to the numbers that decide whether it was speech. */
export interface VoicingFrame {
  rms: number;
  centroid: number;
  noiseFloor: number;
  /** Fundamental in Hz from `estimatePitch`, 0 when the frame had no clear pitch. */
  f0: number;
  /** How periodic the frame was, 0–1, from the same estimate. */
  clarity: number;
}

/**
 * Was this frame speech?
 *
 * Two routes, and a frame needs only one of them when listening in the clear:
 *
 * **Loud.** The frame clears the room's own noise floor by a healthy margin,
 * admitting unvoiced consonants during speech.
 *
 * **Clear.** A vowel is periodic and a room full of chatter, traffic and
 * crockery is not, so a confident fundamental in the speech range is evidence
 * that loudness cannot supply. It is admitted on a much lower energy bar —
 * `floor × 1.6` rather than `floor × 3.0`.
 *
 * **Ducked (assistant speaking).** While the assistant is speaking through the
 * speakers, barge-in MUST be genuine human speech. Mechanical friction
 * (scratching the desk, typing on the keyboard, dragging a mouse, or chassis thumps)
 * produces high broadband RMS energy but has zero harmonic pitch periodicity.
 * If admitted by loudness alone, scratching the table immediately cuts off Temi's
 * voice. Therefore, while ducked, only confident vocal periodicity in the human
 * speech band (80–420 Hz) with high clarity can trigger barge-in.
 */
export function isVoicedFrame(frame: VoicingFrame, ducked = false): boolean {
  const { rms, centroid, noiseFloor, f0, clarity } = frame;
  const speechBand = centroid > 180 && centroid < 4200;
  if (!speechBand) return false;

  if (ducked) {
    // While the assistant speaks, barge-in requires real human vocal resonance
    // (a vowel). Broadband mechanical noise (table scratching, desk taps, keyboard
    // clicks) has no fundamental periodicity and must never cut off the assistant.
    const periodic = f0 >= 80 && f0 <= 420 && clarity >= PITCH_CLARITY_DUCKED;
    const pitchFloor = Math.max(noiseFloor * 2.8, 0.02);
    return periodic && rms > pitchFloor;
  }

  const loud = rms > Math.max(noiseFloor * 3.0, 0.016);
  if (loud) return true;

  const periodic = f0 >= 80 && f0 <= 420 && clarity >= PITCH_CLARITY;
  const pitchFloor = Math.max(noiseFloor * 1.6, 0.009);
  return periodic && rms > pitchFloor;
}

/**
 * The running estimate of the room, which `isVoicedFrame` judges every frame
 * against.
 *
 * It lives here rather than in `audioGraph.ts` because it is the other half of
 * the same decision and, like the verdict, it is arithmetic with no
 * AudioContext in it. The mic endpointer on Temi's lane needs exactly this
 * behaviour, and a second copy of an adaptive floor would drift from this one
 * within a release.
 */
export class NoiseFloor {
  private value = 0.004;
  /** Circular buffer of recent RMS values across a ~1.5 s window (75 frames at 20 ms). */
  private readonly history = new Float32Array(75);
  private historyIndex = 0;
  private historyCount = 0;
  private bootstrapped = false;

  constructor(initial = 0.004) {
    this.value = initial;
    this.history.fill(initial);
  }

  update(rms: number, voiced: boolean, ducked = false): number {
    // NEVER raise the noise floor while audio is ducked (assistant speaking),
    // because speaker bleed into the laptop mic would inflate the floor.
    // Also do not learn from frames we already believe are speech.
    if (ducked || voiced) return this.value;

    // Bootstrapping: on the first few frames after startup/reset, quickly seed
    // the floor from the room's actual acoustic energy.
    if (!this.bootstrapped) {
      this.history[this.historyIndex] = rms;
      this.historyIndex = (this.historyIndex + 1) % this.history.length;
      this.historyCount += 1;
      if (this.historyCount >= 10) {
        this.bootstrapped = true;
        let min = Infinity;
        for (let i = 0; i < this.historyCount; i += 1) {
          if (this.history[i] < min) min = this.history[i];
        }
        this.value = Math.min(0.04, Math.max(0.0015, min));
      }
      return this.value;
    }

    this.history[this.historyIndex] = rms;
    this.historyIndex = (this.historyIndex + 1) % this.history.length;
    if (this.historyCount < this.history.length) this.historyCount += 1;

    // Over any 1.5-second window, speech fluctuates and dips during consonant
    // closures and pauses, while stationary room noise (fans, AC, ambient hiss)
    // stays near its minimum. The minimum of the window is the true floor.
    let windowMin = Infinity;
    for (let i = 0; i < this.historyCount; i += 1) {
      if (this.history[i] < windowMin) windowMin = this.history[i];
    }

    const target = Math.min(0.05, Math.max(0.0015, windowMin));

    // Follow the minimum: fall rapidly when the room gets quieter,
    // rise smoothly when ambient room noise increases.
    if (target < this.value) {
      this.value += (target - this.value) * 0.15;
    } else {
      this.value += (target - this.value) * 0.03;
    }

    this.value = Math.min(0.06, Math.max(0.0015, this.value));
    return this.value;
  }

  clamp(max = 0.006): void {
    if (this.value > max) this.value = max;
  }

  reset(): void {
    this.value = 0.004;
    this.history.fill(0.004);
    this.historyIndex = 0;
    this.historyCount = 0;
    this.bootstrapped = false;
  }

  get current(): number {
    return this.value;
  }
}
