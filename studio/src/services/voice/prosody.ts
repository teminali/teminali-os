/**
 * Prosody — predicting the end of a turn from how the voice sounds.
 *
 * The syntactic endpointer in `turnTaking.ts` needs a transcript to score, and
 * a one-shot recogniser (whisper.cpp, the sidecar's Whisper) produces none
 * until the recording closes. With nothing to read, the silence window sat at
 * its ceiling on every turn. The audio itself carries the same information
 * earlier and for free: a finished statement ends on falling energy and a
 * falling pitch; a question or an unfinished clause ends level or rising.
 *
 * Everything here is pure arithmetic over numbers the microphone graph already
 * has — the frame RMS and a fundamental-frequency estimate from the same
 * time-domain buffer — so it runs every frame and is covered by node tests
 * without an AudioContext.
 */

export interface PitchEstimate {
  /** Fundamental frequency in Hz, or 0 when the frame has no clear pitch. */
  f0: number;
  /** How periodic the frame was, 0–1. Below `MIN_CLARITY` the f0 is 0. */
  clarity: number;
}

/** Adult speech sits comfortably inside this range; outside it is noise. */
const MIN_F0 = 70;
const MAX_F0 = 400;
/** Decimate to roughly this rate first — pitch needs no more, and it is 16× cheaper. */
const TARGET_RATE = 12_000;
/** Below this the normalised autocorrelation peak is not a pitch. */
const MIN_CLARITY = 0.55;
/** A later peak within this fraction of the best one is an octave error, not a better answer. */
const PEAK_TOLERANCE = 0.9;

/**
 * Cheap pitch estimate for one frame: block-decimate, remove DC, then a
 * normalised square-difference (McLeod) autocorrelation over the speech lag
 * range. The first strong peak is the period; later peaks at 2τ, 3τ are the
 * same note. Costs ~30k multiply-adds on a 1024-sample frame at 48 kHz.
 */
export function estimatePitch(samples: Float32Array<ArrayBuffer>, sampleRate: number): PitchEstimate {
  const none: PitchEstimate = { f0: 0, clarity: 0 };
  const decimation = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const rate = sampleRate / decimation;
  const n = Math.floor(samples.length / decimation);
  if (n < 64) return none;

  const x = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    const base = i * decimation;
    for (let k = 0; k < decimation; k += 1) sum += samples[base + k];
    x[i] = sum / decimation;
    mean += x[i];
  }
  mean /= n;
  let energy = 0;
  for (let i = 0; i < n; i += 1) {
    x[i] -= mean;
    energy += x[i] * x[i];
  }
  // Below roughly -70 dBFS there is nothing to be periodic.
  if (energy / n < 1e-7) return none;

  const minLag = Math.max(2, Math.floor(rate / MAX_F0));
  const maxLag = Math.min(n - 2, Math.ceil(rate / MIN_F0));
  if (maxLag <= minLag) return none;

  // nsdf(τ) = 2·Σ x[i]·x[i+τ] / Σ (x[i]² + x[i+τ]²), in [-1, 1].
  const nsdf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let cross = 0;
    let power = 0;
    for (let i = 0; i + lag < n; i += 1) {
      const a = x[i];
      const b = x[i + lag];
      cross += a * b;
      power += a * a + b * b;
    }
    nsdf[lag] = power > 0 ? (2 * cross) / power : 0;
  }

  // Local maxima above zero, then the first one that rivals the best.
  let best = 0;
  const peaks: number[] = [];
  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    const v = nsdf[lag];
    if (v > 0 && v >= nsdf[lag - 1] && v > nsdf[lag + 1]) {
      peaks.push(lag);
      if (v > best) best = v;
    }
  }
  if (peaks.length === 0 || best < MIN_CLARITY) return none;
  const chosen = peaks.find((lag) => nsdf[lag] >= best * PEAK_TOLERANCE) ?? peaks[0];

  // Parabolic interpolation around the peak for sub-sample resolution.
  const l = nsdf[chosen - 1];
  const c = nsdf[chosen];
  const r = nsdf[chosen + 1];
  const denominator = l - 2 * c + r;
  const shift = denominator !== 0 ? (0.5 * (l - r)) / denominator : 0;
  const period = chosen + Math.max(-1, Math.min(1, shift));
  return { f0: rate / period, clarity: c };
}

/** One voiced frame, as the tracker remembers it. */
export interface ProsodyPoint {
  /** Wall-clock ms. */
  at: number;
  /** Frame RMS, linear 0–1. */
  rms: number;
  /** Frame pitch in Hz, 0 when unclear. */
  f0: number;
}

export interface ProsodyOptions {
  /** The stretch of speech just before the silence, ms. */
  tailMs: number;
  /** The stretch before that, which the tail is compared against, ms. */
  headMs: number;
  /** Points older than this (relative to the newest) are forgotten, ms. */
  historyMs: number;
  /** Fewest points each of the tail and head must hold for a reading. */
  minPoints: number;
}

export const DEFAULT_PROSODY: ProsodyOptions = {
  tailMs: 300,
  headMs: 300,
  historyMs: 1200,
  minPoints: 4,
};

export interface ProsodyReading {
  /** Mean tail RMS over mean head RMS. Below 1 the voice is trailing off. */
  energyRatio: number;
  /** Median tail pitch relative to the head, in semitones; null without enough pitched frames. */
  pitchSemitones: number | null;
  /** 0 (hold — rising or level) to 1 (release — falling), 0.5 neutral. */
  finality: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Read the shape of the last stretch of speech. Pure: `points` are voiced
 * frames in time order; returns null until there is enough of both the tail
 * and the head to compare.
 *
 * Energy: the tail sitting well under the head (≤ 0.7×) is a voice trailing
 * off — release. Level or louder is a plateau or a push — hold. Pitch: a drop
 * of a semitone or more over the tail is a statement ending — release; a rise
 * is a question or a clause still open — hold, and harder than a plateau, so
 * the rising term is allowed to reach further below neutral than the falling
 * term reaches above it.
 */
export function readProsody(points: readonly ProsodyPoint[], options: ProsodyOptions = DEFAULT_PROSODY): ProsodyReading | null {
  if (points.length === 0) return null;
  const end = points[points.length - 1].at;
  const tailStart = end - options.tailMs;
  const headStart = tailStart - options.headMs;
  const tail = points.filter((p) => p.at > tailStart);
  const head = points.filter((p) => p.at > headStart && p.at <= tailStart);
  if (tail.length < options.minPoints || head.length < options.minPoints) return null;

  const headEnergy = mean(head.map((p) => p.rms));
  if (headEnergy <= 0) return null;
  const energyRatio = mean(tail.map((p) => p.rms)) / headEnergy;

  const tailPitched = tail.filter((p) => p.f0 > 0).map((p) => p.f0);
  const headPitched = head.filter((p) => p.f0 > 0).map((p) => p.f0);
  const pitchSemitones =
    tailPitched.length >= 3 && headPitched.length >= 3
      ? 12 * Math.log2(median(tailPitched) / median(headPitched))
      : null;

  // 0.95 rather than 1: a perfectly level tail is a hold, not a coin toss.
  const energyTerm = Math.max(-0.25, Math.min(0.25, (0.95 - energyRatio) * 0.55));
  const pitchTerm = pitchSemitones === null ? 0 : Math.max(-0.3, Math.min(0.25, -pitchSemitones * 0.1));
  const finality = Math.max(0, Math.min(1, 0.5 + energyTerm + pitchTerm));
  return { energyRatio, pitchSemitones, finality };
}

/**
 * Keeps the recent voiced frames for one turn. Feed it every voiced frame;
 * ask it for `finality()` on the silent ones.
 */
export class ProsodyTracker {
  private points: ProsodyPoint[] = [];
  private options: ProsodyOptions;

  constructor(options: Partial<ProsodyOptions> = {}) {
    this.options = { ...DEFAULT_PROSODY, ...options };
  }

  observe(point: ProsodyPoint): void {
    this.points.push(point);
    const cutoff = point.at - this.options.historyMs;
    // Oldest first, so a single scan from the front is enough.
    let drop = 0;
    while (drop < this.points.length && this.points[drop].at < cutoff) drop += 1;
    if (drop > 0) this.points.splice(0, drop);
  }

  reset(): void {
    this.points = [];
  }

  get size(): number {
    return this.points.length;
  }

  read(): ProsodyReading | null {
    return readProsody(this.points, this.options);
  }

  /** The end-of-turn likelihood from the audio alone, or null when there is not enough of it. */
  finality(): number | null {
    return this.read()?.finality ?? null;
  }
}
