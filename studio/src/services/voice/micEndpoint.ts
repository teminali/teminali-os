/**
 * Mic endpointing for Temi's live lane.
 *
 * The live lane used to hand end-of-turn detection to Google: the session was
 * opened with `automaticActivityDetection.silenceDurationMs` set to a flat
 * 1800 ms, and the model decided he had stopped talking 1.8 seconds after he
 * actually had. Measured against a conversational turn of a little over three
 * seconds, that one constant was roughly half of the wait.
 *
 * This module is the replacement, and it is deliberately almost no new code.
 * The dictation lane has had an adaptive endpointer since long before this:
 * `voiceActivity.ts` turns five numbers into "was that speech", `turnTaking.ts`
 * turns that into "he has finished", sizing the silence window between 600 and
 * 1800 ms against how final the sentence sounds and learning the speaker's own
 * pause rhythm as it goes. None of that was reachable from here, because the
 * chain it hangs off (`audioGraph.ts` -> `conversation.ts`) needs an
 * AudioContext and is not mounted on this lane at all.
 *
 * So the only thing missing was the part that turns PCM into those five
 * numbers, which is what this file is. It takes the 16 kHz Int16 the engine is
 * already about to put on the wire and produces the same analysis frames
 * `audioGraph.ts` produces from an AnalyserNode: a 512-sample window every
 * 320 samples, which is a 32 ms window on a 20 ms hop, the same geometry the
 * graph runs at 48 kHz. Everything downstream of that is the existing,
 * already-tested chain, unchanged.
 *
 * It has no DOM in it on purpose. That is what lets the end-to-end harness
 * drive a real Gemini session from plain Node with a recorded utterance and
 * put a stopwatch on the result.
 */

import { estimatePitch, ProsodyTracker } from "./prosody.ts";
import { fft } from "./speakerProfile.ts";
import { isVoicedFrame, NoiseFloor } from "./voiceActivity.ts";
import {
  DEFAULT_ENDPOINTER,
  Endpointer,
  type EndpointerConfig,
  type TurnEvent,
} from "./turnTaking.ts";

/**
 * 512 samples at 16 kHz is 32 ms, and a power of two so the FFT is a radix-2.
 * `audioGraph.ts` reads 1024 samples at 48 kHz, which is 21 ms; both are a
 * couple of pitch periods of a low male voice, which is what the estimator
 * needs and all it needs.
 */
const WINDOW = 512;

/** 320 samples at 16 kHz is 20 ms, the graph's frame interval exactly. */
const HOP = 320;

/**
 * Web Audio applies this to the magnitude spectrum before handing it over, and
 * `audioGraph.ts` therefore sees a smoothed centroid. The thresholds in
 * `isVoicedFrame` were tuned against that, so the smoothing is part of the
 * contract rather than a detail: without it the centroid of a fricative swings
 * far enough between frames to cross the 4200 Hz gate on its own.
 */
const SPECTRUM_SMOOTHING = 0.25;

/** Int16 full scale. */
const INT16_SCALE = 32768;

/**
 * The engine asks a question and the answer is already on its way, so commit
 * on a shorter silence. Lifted from `conversation.ts`, which has run this
 * behaviour on the dictation lane for as long as the endpointer has existed.
 */
export const EAGER_AFTER_QUESTION_MS = 9000;

/** What the engine needs back, beyond the turn event itself. */
export interface MicEndpointerStats {
  /** Wall clock of the last frame we judged to be speech, 0 before any. */
  lastVoicedAt: number;
  /** Wall clock of the last `speech-end` we emitted, 0 before any. */
  lastEndpointAt: number;
  /** The silence window the endpointer is currently sizing against, in ms. */
  windowMs: number;
  /** The learned pause floor, in ms. 0 until he has been cut off once. */
  pacingFloorMs: number;
}

/**
 * PCM in, turn events out.
 *
 * Owns the three pieces of per-frame state that have to persist across chunks:
 * the sample ring the analysis window slides over, the adaptive noise floor,
 * and the smoothed spectrum. Everything else it borrows.
 */
export class MicEndpointer {
  private readonly endpointer: Endpointer;
  private readonly floor = new NoiseFloor();
  private readonly prosody = new ProsodyTracker();

  /** The analysis window, kept full and slid by `HOP` samples at a time. */
  private readonly window = new Float32Array(WINDOW);
  /** How many samples of `window` are real. Only matters before the first fill. */
  private filled = 0;
  /** Samples accumulated since the last analysis frame. */
  private sinceHop = 0;

  private readonly real = new Float32Array(WINDOW);
  private readonly imag = new Float32Array(WINDOW);
  private readonly spectrum = new Float32Array(WINDOW / 2);
  private readonly hann = new Float32Array(WINDOW);

  private ducked = false;
  private transcript = "";
  private eagerUntil = 0;

  private lastVoicedAtMs = 0;
  private lastEndpointAtMs = 0;
  private windowMs = DEFAULT_ENDPOINTER.maxSilenceMs;

  constructor(config: Partial<EndpointerConfig> = {}) {
    this.endpointer = new Endpointer({ ...DEFAULT_ENDPOINTER, ...config });
    for (let i = 0; i < WINDOW; i += 1) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1));
    }
  }

  /**
   * The assistant's own voice is playing, so tighten every threshold.
   *
   * On this lane the truth arrives per frame rather than per event: the mic
   * batch carries an `isTTSPlaying` flag in its header, set at capture time.
   * That is better evidence than a start/stop callback, which can only ever be
   * right about the frames that follow it.
   */
  setDucked(ducked: boolean): void {
    if (ducked === this.ducked) return;
    this.ducked = ducked;
    // Leaving a ducked stretch, the floor has been sitting frozen while the
    // speaker bled into the mic. Pull it back down so the first real frame
    // after she stops is not measured against her.
    if (!ducked) this.floor.clamp(0.006);
  }

  /**
   * The live transcript so far, which sizes the silence window: a sentence
   * that already parses as complete is committed sooner than one left hanging
   * on "and". Empty is a supported state and reads as "unknown", not as
   * "unfinished" — see `syntaxFinality`.
   */
  setTranscript(text: string): void {
    this.transcript = text;
  }

  /** Temi just asked something. Commit faster until the window lapses. */
  markQuestionAsked(at = Date.now()): void {
    this.eagerUntil = at + EAGER_AFTER_QUESTION_MS;
  }

  /** A turn is over. Keeps the learned pacing; only the in-flight state goes. */
  reset(): void {
    this.endpointer.reset();
    this.prosody.reset();
    this.filled = 0;
    this.sinceHop = 0;
    this.window.fill(0);
  }

  get isSpeaking(): boolean {
    return this.endpointer.isSpeaking;
  }

  get stats(): MicEndpointerStats {
    return {
      lastVoicedAt: this.lastVoicedAtMs,
      lastEndpointAt: this.lastEndpointAtMs,
      windowMs: this.windowMs,
      pacingFloorMs: this.endpointer.pacingFloorMs,
    };
  }

  /**
   * Feed one chunk of 16 kHz mono Int16 and get back every turn event it
   * produced, in order.
   *
   * A chunk is 42.7 ms and a frame is 20 ms, so a chunk is two frames and can
   * legitimately carry more than one event. `at` is when the chunk arrived;
   * frames inside it are dated backwards from there so the endpointer's clock
   * tracks the audio rather than the delivery.
   */
  push(samples: Int16Array, sampleRate: number, at = Date.now()): TurnEvent[] {
    const events: TurnEvent[] = [];
    if (!samples.length) return events;

    const frameMs = (HOP / sampleRate) * 1000;
    // Date every frame from the end of the chunk backwards. Counted first so
    // the first frame of the chunk is the oldest, not the newest.
    let pending = 0;
    for (let i = 0; i < samples.length; i += 1) {
      if (this.sinceHop + i + 1 >= HOP && (this.sinceHop + i + 1 - HOP) % HOP === 0) pending += 1;
    }
    let emitted = 0;

    for (let i = 0; i < samples.length; i += 1) {
      // Slide the window by one and write the new sample at the end.
      this.window.copyWithin(0, 1);
      this.window[WINDOW - 1] = samples[i] / INT16_SCALE;
      if (this.filled < WINDOW) this.filled += 1;
      this.sinceHop += 1;

      if (this.sinceHop < HOP) continue;
      this.sinceHop = 0;
      if (this.filled < WINDOW) continue;

      emitted += 1;
      const frameAt = Math.round(at - (pending - emitted) * frameMs);
      const event = this.analyse(sampleRate, frameAt);
      if (event) events.push(event);
    }

    return events;
  }

  /** One analysis frame: the five numbers, the verdict, and the turn event. */
  private analyse(sampleRate: number, at: number): TurnEvent | null {
    let sum = 0;
    for (let i = 0; i < WINDOW; i += 1) sum += this.window[i] * this.window[i];
    const rms = Math.sqrt(sum / WINDOW);

    const centroid = this.spectralCentroid(sampleRate);
    // The floor as it stood before this frame, matching `audioGraph.tick`:
    // the verdict is judged against the room as it was, then the room learns.
    const floor = this.floor.current;
    const tone = estimatePitch(this.window, sampleRate);
    const voiced = isVoicedFrame(
      { rms, centroid, noiseFloor: floor, f0: tone.f0, clarity: tone.clarity },
      this.ducked,
    );
    this.floor.update(rms, voiced, this.ducked);

    if (voiced) {
      this.lastVoicedAtMs = at;
      this.prosody.observe({ at, rms, f0: tone.f0 });
    }

    const eager = at < this.eagerUntil;
    const event = this.endpointer.push(voiced, this.transcript, eager, {
      at,
      // Fed on voiced frames, read on silent ones. Never both in one call.
      prosody: voiced ? null : this.prosody.finality(),
    });

    if (event?.type === "holding") this.windowMs = event.windowMs;
    if (event?.type === "speech-end") {
      this.windowMs = event.windowMs;
      this.lastEndpointAtMs = at;
      this.prosody.reset();
    }
    if (event?.type === "discarded") this.prosody.reset();

    return event;
  }

  /**
   * Magnitude-weighted mean bin frequency, smoothed across frames.
   *
   * Deliberately the same arithmetic as `AudioGraph.spectralCentroid`, which
   * reads `getFloatFrequencyData` and weights by linear magnitude rather than
   * by power. Computing it a different way here would mean `isVoicedFrame`
   * saw a different distribution on this lane than the thresholds were tuned
   * against.
   */
  private spectralCentroid(sampleRate: number): number {
    for (let i = 0; i < WINDOW; i += 1) {
      this.real[i] = this.window[i] * this.hann[i];
      this.imag[i] = 0;
    }
    fft(this.real, this.imag);

    const bins = WINDOW / 2;
    const nyquist = sampleRate / 2;
    let weighted = 0;
    let total = 0;
    for (let i = 0; i < bins; i += 1) {
      const magnitude = Math.hypot(this.real[i], this.imag[i]);
      const smoothed =
        SPECTRUM_SMOOTHING * this.spectrum[i] + (1 - SPECTRUM_SMOOTHING) * magnitude;
      this.spectrum[i] = smoothed;
      weighted += smoothed * ((i / bins) * nyquist);
      total += smoothed;
    }
    return total > 0 ? weighted / total : 0;
  }
}
