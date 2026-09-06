/**
 * Microphone capture and analysis.
 *
 * One shared WebAudio graph feeds everything downstream: the level meter the
 * HUD draws, the voice-activity detector that decides when a turn starts and
 * ends, the per-frame pitch the endpointer's prosody reads (`prosody.ts`), and
 * the rolling PCM buffer the speaker matcher reads from.
 *
 * Echo cancellation matters more here than anywhere else. In conversation mode
 * the microphone stays open while the assistant is speaking, so without the
 * browser's AEC the recogniser would happily transcribe our own text-to-speech
 * and answer itself. `echoCancellation` plus the `duckWhileSpeaking` gate is
 * what makes barge-in possible instead of a feedback loop.
 */

import { estimatePitch } from "./prosody";
import { isVoicedFrame } from "./voiceActivity";
import { VoiceError } from "./types";

export interface AudioFrame {
  /** Wall-clock ms the frame was read — the endpointer's clock. */
  at: number;
  /** Root-mean-square amplitude of the frame, 0–1. */
  rms: number;
  /** RMS mapped to a perceptual 0–1 for the meter. */
  level: number;
  /** Estimated noise floor at this instant, same units as rms. */
  noiseFloor: number;
  /** True when rms sits far enough above the floor to count as speech. */
  voiced: boolean;
  /** Spectral centroid in Hz — separates speech from steady-state hum. */
  centroid: number;
  /** Fundamental frequency in Hz on a voiced, periodic frame; 0 otherwise. */
  pitch: number;
  /** Raw time-domain samples for this frame. */
  samples: Float32Array;
}

export interface AudioGraphOptions {
  /** Frames per second delivered to `onFrame`. */
  fps?: number;
  /** Seconds of audio kept for the speaker matcher and re-transcription. */
  historySeconds?: number;
  onFrame?: (frame: AudioFrame) => void;
}

const FFT_SIZE = 1024;
const DEFAULT_FPS = 50;
const DEFAULT_HISTORY_SECONDS = 12;

/**
 * Noise-floor tracker. Rises slowly and falls fast, so a door slamming does not
 * permanently desensitise the detector but walking into a quiet room does make
 * it more sensitive within a second or so.
 */
class NoiseFloor {
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

export class AudioGraph {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  /** Survives a restart: a muted conversation stays muted if the graph rebuilds. */
  private muted = false;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private timer: number | null = null;

  private readonly floor = new NoiseFloor();
  private timeData = new Float32Array(FFT_SIZE);
  private freqData = new Float32Array(FFT_SIZE / 2);

  /** Ring buffer of recent audio, for the speaker matcher. */
  private history: Float32Array | null = null;
  private historyWrite = 0;
  private historyFilled = false;
  private sampleRate = 48000;

  private ducked = false;
  private options: Required<Omit<AudioGraphOptions, "onFrame">> & Pick<AudioGraphOptions, "onFrame">;

  constructor(options: AudioGraphOptions = {}) {
    this.options = {
      fps: options.fps ?? DEFAULT_FPS,
      historySeconds: options.historySeconds ?? DEFAULT_HISTORY_SECONDS,
      onFrame: options.onFrame,
    };
  }

  get running(): boolean {
    return this.context !== null;
  }

  get noiseFloor(): number {
    return this.floor.current;
  }

  /** The live capture stream, for a provider that wants to record it directly. */
  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  async start(): Promise<void> {
    if (this.context) return;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new VoiceError("This build has no microphone access.", "MIC_UNAVAILABLE", false);
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // The three constraints that make an always-open mic workable.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (error) {
      const name = (error as DOMException)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new VoiceError("Microphone permission was denied.", "MIC_DENIED", false);
      }
      throw new VoiceError(
        `No microphone is available (${name ?? "unknown error"}).`,
        "MIC_UNAVAILABLE",
        false,
      );
    }

    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.context = new Ctor();
    // Autoplay policy can hand back a suspended context even after a gesture.
    if (this.context.state === "suspended") await this.context.resume().catch(() => undefined);

    this.sampleRate = this.context.sampleRate;
    this.history = new Float32Array(Math.ceil(this.sampleRate * this.options.historySeconds));
    this.historyWrite = 0;
    this.historyFilled = false;

    this.source = this.context.createMediaStreamSource(this.stream);
    this.gain = this.context.createGain();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.25;

    this.source.connect(this.gain);
    this.gain.connect(this.analyser);
    // Deliberately not connected to the destination — monitoring our own mic
    // through the speakers is exactly the feedback path we are avoiding.

    this.timeData = new Float32Array(this.analyser.fftSize);
    this.freqData = new Float32Array(this.analyser.frequencyBinCount);

    // A graph rebuilt during a muted conversation must not come back hot.
    if (this.muted) this.setMuted(true);

    const interval = Math.max(10, Math.round(1000 / this.options.fps));
    this.timer = window.setInterval(() => this.tick(), interval);
  }

  /**
   * Silence the microphone without giving it up.
   *
   * `track.enabled = false` makes the track deliver digital silence: the
   * recogniser keeps running and hears nothing, the graph stays built, and the
   * OS permission is not surrendered — so unmuting is instant and does not
   * re-prompt. Stopping the track instead would end the capture and force a
   * fresh getUserMedia, which on macOS re-arms the orange recording dot and,
   * on a denied second prompt, would strand a live conversation with no way
   * back.
   *
   * This exists because the mic hears whatever the room hears. A video playing
   * on the machine arrives as operator speech and is transcribed as a prompt —
   * which is how a conversation ends up answering "the girls are resting" in
   * Russian. Noise suppression cannot help: that audio is not noise, it is
   * speech that simply is not addressed to us.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  }

  /** Whether the microphone is currently delivering silence on purpose. */
  isMuted(): boolean {
    return this.muted;
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.source?.disconnect();
    this.gain?.disconnect();
    this.analyser?.disconnect();
    void this.context?.close().catch(() => undefined);
    this.stream = null;
    this.source = null;
    this.gain = null;
    this.analyser = null;
    this.context = null;
    this.history = null;
    this.historyFilled = false;
    this.historyWrite = 0;
  }

  /**
   * Raise the bar for what counts as speech while our own reply is playing.
   * The browser's AEC removes most of the loop; this covers the remainder, so
   * a barge-in still registers but the tail of our own sentence does not.
   */
  setDucked(ducked: boolean): void {
    if (this.ducked && !ducked) {
      // Ducking ended: immediately clamp noise floor to clean room sensitivity
      // so user does not experience a 4-5s deafness period after speech finishes.
      this.floor.clamp(0.006);
    }
    this.ducked = ducked;
  }

  /** The last `seconds` of captured audio, oldest sample first. */
  takeHistory(seconds: number): { samples: Float32Array; sampleRate: number } | null {
    if (!this.history) return null;
    const want = Math.min(this.history.length, Math.ceil(this.sampleRate * seconds));
    const available = this.historyFilled ? this.history.length : this.historyWrite;
    const take = Math.min(want, available);
    if (take === 0) return null;

    const out = new Float32Array(take);
    // Walk backwards from the write head, wrapping once if needed.
    const start = (this.historyWrite - take + this.history.length) % this.history.length;
    if (start + take <= this.history.length) {
      out.set(this.history.subarray(start, start + take));
    } else {
      const head = this.history.length - start;
      out.set(this.history.subarray(start), 0);
      out.set(this.history.subarray(0, take - head), head);
    }
    return { samples: out, sampleRate: this.sampleRate };
  }

  private tick(): void {
    const analyser = this.analyser;
    if (!analyser) return;

    analyser.getFloatTimeDomainData(this.timeData);
    analyser.getFloatFrequencyData(this.freqData);

    let sum = 0;
    for (let i = 0; i < this.timeData.length; i += 1) sum += this.timeData[i] * this.timeData[i];
    const rms = Math.sqrt(sum / this.timeData.length);

    const centroid = this.spectralCentroid();
    const floor = this.floor.current;

    const tone = estimatePitch(this.timeData, this.sampleRate);
    const voiced = isVoicedFrame(
      { rms, centroid, noiseFloor: floor, f0: tone.f0, clarity: tone.clarity },
      this.ducked,
    );
    const pitch = voiced ? tone.f0 : 0;

    this.floor.update(rms, voiced, this.ducked);
    this.appendHistory(this.timeData);

    this.options.onFrame?.({
      at: Date.now(),
      rms,
      level: Math.min(1, Math.sqrt(rms) * 3.2),
      noiseFloor: floor,
      voiced,
      centroid,
      pitch,
      samples: this.timeData,
    });
  }

  /** Energy-weighted mean frequency — cheap, and enough to gate on. */
  private spectralCentroid(): number {
    const bins = this.freqData.length;
    const nyquist = this.sampleRate / 2;
    let weighted = 0;
    let total = 0;
    for (let i = 0; i < bins; i += 1) {
      // getFloatFrequencyData returns dBFS; convert to linear magnitude.
      const magnitude = Math.pow(10, this.freqData[i] / 20);
      weighted += magnitude * ((i / bins) * nyquist);
      total += magnitude;
    }
    return total > 0 ? weighted / total : 0;
  }

  private appendHistory(frame: Float32Array): void {
    const history = this.history;
    if (!history) return;
    for (let i = 0; i < frame.length; i += 1) {
      history[this.historyWrite] = frame[i];
      this.historyWrite += 1;
      if (this.historyWrite >= history.length) {
        this.historyWrite = 0;
        this.historyFilled = true;
      }
    }
  }
}

/** Encode float samples as a 16-bit PCM WAV, for upload to a transcription API. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}
