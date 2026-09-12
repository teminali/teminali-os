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
const PITCH_CLARITY = 0.7;
const PITCH_CLARITY_DUCKED = 0.82;

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
 * Two routes, and a frame needs only one of them.
 *
 * **Loud.** The original test, kept unchanged: the frame clears the room's own
 * noise floor by a healthy margin. It is a *ratio*, which is its weakness — the
 * noisier the room, the louder the operator has to be to clear `floor × margin`.
 * That is backwards from what a person does, and it is why the same sentence at
 * the same volume was heard in a quiet room and missed in a busy one.
 *
 * **Clear.** A vowel is periodic and a room full of chatter, traffic and
 * crockery is not, so a confident fundamental in the speech range is evidence
 * that loudness cannot supply. It is admitted on a much lower energy bar —
 * `floor × 1.5` rather than `floor × 2.6` — which is what lets an ordinary
 * speaking voice survive a noise floor that has climbed under it.
 *
 * The spectral-centroid band gates both. It is the fan-and-fridge test: a
 * steady hum is periodic enough to fool the pitch route on its own, and its
 * energy sits below the band where speech lives.
 *
 * `ducked` is the assistant's own voice playing. Everything tightens there,
 * because the periodic sound in the room is then most likely to be us: the
 * clarity bar rises and the pitch route keeps a real absolute floor, so it can
 * only ever undercut the loud route, never open barge-in to speaker bleed.
 */
export function isVoicedFrame(frame: VoicingFrame, ducked = false): boolean {
  const { rms, centroid, noiseFloor, f0, clarity } = frame;
  const speechBand = centroid > 180 && centroid < 4200;
  if (!speechBand) return false;

  const loud = rms > Math.max(noiseFloor * (ducked ? 6.5 : 2.8), ducked ? 0.045 : 0.012);
  if (loud) return true;

  const periodic = f0 >= 80 && f0 <= 420 && clarity >= (ducked ? PITCH_CLARITY_DUCKED : PITCH_CLARITY);
  const pitchFloor = ducked ? Math.max(noiseFloor * 2.8, 0.02) : Math.max(noiseFloor * 1.5, 0.007);
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
  private readonly attack = 0.0006;
  private readonly release = 0.02;

  update(rms: number, voiced: boolean, ducked = false): number {
    // Never learn the floor from frames we already believe are speech.
    // Also NEVER raise the noise floor while audio is ducked (assistant speaking),
    // because speaker bleed into the laptop mic would inflate the floor to ~0.03
    // and deafen the detector for 4-5 seconds after speech stops.
    if (voiced || ducked) return this.value;
    if (rms > this.value) this.value += (rms - this.value) * this.attack;
    else this.value += (rms - this.value) * this.release;
    // Keep a sane range: silence never reads as exactly zero on real hardware.
    this.value = Math.min(0.08, Math.max(0.0015, this.value));
    return this.value;
  }

  clamp(max = 0.006): void {
    if (this.value > max) this.value = max;
  }

  reset(): void {
    this.value = 0.004;
  }

  get current(): number {
    return this.value;
  }
}
