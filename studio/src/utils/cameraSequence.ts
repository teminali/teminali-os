/**
 * How a camera sequence is bounded and spaced.
 *
 * Pure and dependency-free, because the camera itself can only be exercised
 * by driving Electron with a lens in front of it — and a rule that can only be
 * checked that way is a rule nobody checks. What is here bounds two things:
 * how long the light stays on for one request, and how much is sent to a model.
 */

export const MAX_FRAMES = 6;
export const MAX_SPAN_MS = 5_000;
export const DEFAULT_SPAN_MS = 1_200;

/**
 * How far apart to space a sequence.
 *
 * The gaps are between the frames, so `n` frames over a span leave `n - 1` of
 * them, and one frame is not a sequence and waits for nothing.
 */
export function frameGapMs(frames: number, spanMs: number): number {
  if (frames <= 1) return 0;
  return Math.max(0, Math.round(spanMs / (frames - 1)));
}

/** `frames` and `spanMs` as the camera will actually honour them. */
export function clampSequence(frames: unknown, spanMs: unknown): { frames: number; spanMs: number } {
  const wanted = Number.isFinite(Number(frames)) ? Math.round(Number(frames)) : 1;
  const span = Number.isFinite(Number(spanMs)) ? Math.round(Number(spanMs)) : DEFAULT_SPAN_MS;
  return {
    frames: Math.min(MAX_FRAMES, Math.max(1, wanted)),
    spanMs: Math.min(MAX_SPAN_MS, Math.max(0, span)),
  };
}
