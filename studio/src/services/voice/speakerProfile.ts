/**
 * On-device speaker matching.
 *
 * Purpose: when several people are in the room, only the enrolled operator
 * should be able to drive the assistant. This computes an MFCC-based voiceprint
 * from a few seconds of speech and compares later utterances against it.
 *
 * Be clear about what this is. A mean-MFCC voiceprint is a *weak* speaker
 * verifier. It reliably separates voices that differ in pitch and vocal-tract
 * length — most male/female pairs, an adult from a child — and it reliably
 * recognises the enrolled speaker in the same room on the same microphone. It
 * does not reliably separate two similar voices, and it drifts when you change
 * microphone or catch a cold. So it is used as *one weighted signal* in the
 * addressing decision, never as the sole gate, and the UI always says what it
 * scored. A strong verifier needs a trained embedding model; that arrives with
 * the VibeVoice tier, which returns a real speaker embedding per utterance.
 */

const MEL_BANDS = 26;
const CEPSTRA = 13;
const FRAME_SIZE = 512;
const HOP = 256;
/** Frames quieter than this contribute nothing but noise to the print. */
const VOICED_RMS = 0.012;

/* ── Minimal radix-2 FFT (in-place, real input) ───────────────────────────── */

function fft(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aR = real[i + k];
        const aI = imag[i + k];
        const bR = real[i + k + len / 2] * curR - imag[i + k + len / 2] * curI;
        const bI = real[i + k + len / 2] * curI + imag[i + k + len / 2] * curR;
        real[i + k] = aR + bR;
        imag[i + k] = aI + bI;
        real[i + k + len / 2] = aR - bR;
        imag[i + k + len / 2] = aI - bI;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
}

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

/** Triangular mel filterbank, built once per sample rate. */
function melFilterbank(sampleRate: number, bins: number): Float32Array[] {
  const low = hzToMel(80);
  const high = hzToMel(Math.min(8000, sampleRate / 2));
  const points = new Array(MEL_BANDS + 2)
    .fill(0)
    .map((_, i) => melToHz(low + ((high - low) * i) / (MEL_BANDS + 1)));
  const binOf = (hz: number) => Math.floor(((bins + 1) * hz) / (sampleRate / 2));

  const filters: Float32Array[] = [];
  for (let m = 1; m <= MEL_BANDS; m += 1) {
    const filter = new Float32Array(bins);
    const left = binOf(points[m - 1]);
    const centre = binOf(points[m]);
    const right = binOf(points[m + 1]);
    for (let k = left; k < centre && k < bins; k += 1) {
      if (centre > left) filter[k] = (k - left) / (centre - left);
    }
    for (let k = centre; k < right && k < bins; k += 1) {
      if (right > centre) filter[k] = (right - k) / (right - centre);
    }
    filters.push(filter);
  }
  return filters;
}

const bankCache = new Map<number, Float32Array[]>();
function bankFor(sampleRate: number, bins: number): Float32Array[] {
  const key = sampleRate * 100000 + bins;
  let bank = bankCache.get(key);
  if (!bank) {
    bank = melFilterbank(sampleRate, bins);
    bankCache.set(key, bank);
  }
  return bank;
}

/**
 * Mean MFCC vector over the voiced frames of a clip, L2-normalised.
 * Returns null when there is not enough speech to characterise.
 */
export function voiceprint(samples: Float32Array, sampleRate: number): Float32Array | null {
  const bins = FRAME_SIZE / 2;
  const bank = bankFor(sampleRate, bins);
  const accumulator = new Float64Array(CEPSTRA);
  let frames = 0;

  const real = new Float32Array(FRAME_SIZE);
  const imag = new Float32Array(FRAME_SIZE);
  const power = new Float32Array(bins);
  const energies = new Float32Array(MEL_BANDS);

  for (let offset = 0; offset + FRAME_SIZE <= samples.length; offset += HOP) {
    let sum = 0;
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      const s = samples[offset + i];
      sum += s * s;
    }
    if (Math.sqrt(sum / FRAME_SIZE) < VOICED_RMS) continue;

    // Pre-emphasis flattens the spectral tilt, then Hann limits leakage.
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      const prev = offset + i > 0 ? samples[offset + i - 1] : 0;
      const emphasised = samples[offset + i] - 0.97 * prev;
      real[i] = emphasised * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1)));
      imag[i] = 0;
    }

    fft(real, imag);
    for (let k = 0; k < bins; k += 1) power[k] = real[k] * real[k] + imag[k] * imag[k];

    for (let m = 0; m < MEL_BANDS; m += 1) {
      let energy = 0;
      const filter = bank[m];
      for (let k = 0; k < bins; k += 1) energy += power[k] * filter[k];
      energies[m] = Math.log(energy + 1e-10);
    }

    // DCT-II, keeping the low cepstra that carry vocal-tract shape. c0 is
    // dropped: it is loudness, which says nothing about who is talking.
    for (let c = 0; c < CEPSTRA; c += 1) {
      let value = 0;
      for (let m = 0; m < MEL_BANDS; m += 1) {
        value += energies[m] * Math.cos((Math.PI * (c + 1) * (m + 0.5)) / MEL_BANDS);
      }
      accumulator[c] += value;
    }
    frames += 1;
  }

  // Under ~0.4s of voiced audio the mean is dominated by whichever phoneme
  // happened to be spoken, not by the speaker.
  if (frames < Math.ceil((0.4 * sampleRate) / HOP)) return null;

  const print = new Float32Array(CEPSTRA);
  let norm = 0;
  for (let c = 0; c < CEPSTRA; c += 1) {
    print[c] = accumulator[c] / frames;
    norm += print[c] * print[c];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-6) return null;
  for (let c = 0; c < CEPSTRA; c += 1) print[c] /= norm;
  return print;
}

/** Cosine similarity of two L2-normalised prints, remapped to 0–1. */
export function similarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, (dot + 1) / 2));
}

export interface EnrolledProfile {
  /** Averaged print across every enrolment sample. */
  centroid: number[];
  /** Individual samples, so the profile can be re-averaged or extended. */
  samples: number[][];
  /** Spread of the enrolment samples — a tight profile deserves more trust. */
  cohesion: number;
  enrolledAt: string;
  sampleRate: number;
}

const STORAGE_KEY = "teminali_voice_profile_v1";

export const SpeakerProfile = {
  /**
   * Build a profile from enrolment clips. Three or more short clips beat one
   * long one: it averages out whatever the speaker happened to be saying.
   */
  enrol(clips: Array<{ samples: Float32Array; sampleRate: number }>): EnrolledProfile | null {
    const prints = clips
      .map((clip) => voiceprint(clip.samples, clip.sampleRate))
      .filter((print): print is Float32Array => print !== null);
    if (prints.length === 0) return null;

    const centroid = new Float32Array(CEPSTRA);
    for (const print of prints) for (let i = 0; i < CEPSTRA; i += 1) centroid[i] += print[i] / prints.length;

    let norm = 0;
    for (let i = 0; i < CEPSTRA; i += 1) norm += centroid[i] * centroid[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < CEPSTRA; i += 1) centroid[i] /= norm;

    const cohesion =
      prints.length > 1
        ? prints.reduce((acc, print) => acc + similarity(print, centroid), 0) / prints.length
        : 0.75;

    return {
      centroid: Array.from(centroid),
      samples: prints.map((print) => Array.from(print)),
      cohesion,
      enrolledAt: new Date().toISOString(),
      sampleRate: clips[0].sampleRate,
    };
  },

  /**
   * Score an utterance against the profile, 0–1. Returns null when the clip is
   * too short to judge — the caller must treat that as "no opinion", not as a
   * rejection, or a one-word "yes" would never be accepted.
   */
  match(profile: EnrolledProfile, samples: Float32Array, sampleRate: number): number | null {
    const print = voiceprint(samples, sampleRate);
    if (!print) return null;
    const centroid = Float32Array.from(profile.centroid);
    const direct = similarity(print, centroid);
    // Best-of against the individual enrolment samples too: it recovers some of
    // the variation the centroid averages away.
    const best = profile.samples.reduce(
      (acc, sample) => Math.max(acc, similarity(print, Float32Array.from(sample))),
      0,
    );
    return Math.max(direct, best * 0.97);
  },

  load(): EnrolledProfile | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as EnrolledProfile) : null;
    } catch {
      return null;
    }
  },

  save(profile: EnrolledProfile): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch {
      /* Storage full or blocked — the profile simply does not persist. */
    }
  },

  clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to do */
    }
  },
};
