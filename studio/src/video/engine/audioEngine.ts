/* ═══════════════════════════════════════════════════════════════════
   Audio playback.

   You cannot edit video you cannot hear. Before this, pressing play
   moved the picture in silence — and the transport's level meters
   bounced on Math.random(), so it looked convincingly like sound was
   coming out. (The module that used to live here was called AudioEngine
   and could play one 440Hz beep.)

   Design: each audible clip gets an <audio> element routed through Web
   Audio as a MediaElementAudioSourceNode. That streams from disk rather
   than decoding whole files into memory — a ten-minute track would be
   ~100MB as a raw buffer — while still giving per-clip gain, fades, and
   a real analyser to drive the meters.

   The engine is told the timeline state every frame and reconciles
   against it. It owns no notion of time itself: the playhead is the
   single source of truth, so scrubbing, looping and rate changes all
   work without special cases.
   ═══════════════════════════════════════════════════════════════════ */

import { Track, Clip } from '../types/edl';
import {
  VoiceChain,
  buildVoiceChain,
  ensurePitchWorklet,
  chainSignature,
  disposeChain,
  duckGainFor,
  DUCK_ATTACK_S,
  DUCK_RELEASE_S,
} from './audioEffects';

interface Voice {
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  /** Per-clip effects. Rebuilt when `sig` stops matching the clip. */
  chain: VoiceChain;
  gain: GainNode;
  clipId: string;
  /** What `chain` was built for, so a changed voiceEffect is noticed. */
  sig: string;
  /** Which bus `gain` feeds — the ducked one, or the key one. */
  ducked: boolean;
  /**
   * The gain this voice was last ramped towards.
   *
   * `setTargetAtTime` schedules an automation event every time it is
   * called, and `sync` runs every frame — so a voice sitting at a
   * constant level was scheduling sixty events a second to hold still,
   * and every voice NOT under the playhead was scheduling sixty more to
   * stay at zero. Ramp only when the destination actually moved.
   */
  lastGain: number;
  /**
   * The position this module last ASKED the element for, while paused.
   * See `shouldParkSeek` — this is the audio twin of the video engine's
   * seek storm, and the same guard.
   */
  requestedTime: number | null;
  /** `performance.now()` of the last frame this voice was under the playhead. */
  lastUsedAt: number;
}

/**
 * A gain change too small to hear, so not worth an automation event.
 *
 * A 60fps loop scheduling events for a change of 1e-4 is spending the
 * audio thread's budget to hold a level it is already at.
 */
const GAIN_EPSILON = 0.001;

/**
 * How many voices may sit in the graph before idle ones are torn down.
 *
 * A voice is an `<audio>` element, a `MediaElementAudioSourceNode` and a
 * whole per-clip filter chain. `sync` used to pause the ones that had
 * fallen out from under the playhead and leave every one of them
 * resident for the life of the page — so scrubbing across a hundred-clip
 * timeline left a hundred decoders alive, a hundred filter chains
 * connected, and a hundred no-op ramps scheduled per frame. The video
 * engine had exactly this bug and this is the same bound.
 */
const VOICE_SOFT_LIMIT = 8;

/** How long a voice may sit unused before it is worth its teardown. */
const VOICE_IDLE_EVICT_MS = 20_000;

/**
 * Whether a PAUSED element is worth seeking.
 *
 * The audio twin of `shouldScrubSeek` in `videoEngine.ts`, and it exists
 * for the same reason: a tolerance alone cannot fix this. A compressed
 * stream seeks to a packet boundary, so an element told to go to 4.100
 * may answer 4.180 and be "wrong" for ever — re-seeked on every one of
 * the next sixty frames, permanently `seeking`, and audible as a clip
 * that will not scrub. Asking twice for a position the decoder has
 * already answered cannot produce a different answer, so it is not
 * asked.
 */
export function shouldParkSeek(state: {
  currentTime: number;
  requestedTime: number | null;
  target: number;
  seeking: boolean;
}): boolean {
  if (state.seeking) return false;
  if (!Number.isFinite(state.target)) return false;
  if (Math.abs(state.currentTime - state.target) <= PARK_TOLERANCE_S) return false;
  if (state.requestedTime !== null
      && Math.abs(state.requestedTime - state.target) < PARK_TOLERANCE_S) return false;
  return true;
}

/**
 * How close a parked element has to be before it is left alone.
 *
 * One video frame at 60fps, matching the picture side, and comfortably
 * wider than an AAC packet (23ms at 44.1kHz) so an ordinary seek lands
 * inside it first time.
 */
const PARK_TOLERANCE_S = 1 / 60;

/** Beyond this drift we re-seek rather than let the element free-run. */
const RESYNC_TOLERANCE_S = 0.28;

class AudioPlaybackEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private splitter: ChannelSplitterNode | null = null;

  /* The mix splits the same way the render's filtergraph does: clips
     marked `ducking` on one bus, everything else on the key bus, so the
     key bus can be measured and used to pull the ducked one down. With no
     clip on one side or the other there is nothing to duck against, and
     the ducked bus is left at unity — same fallback as the export. */
  private duckedBus: GainNode | null = null;
  private keyBus: GainNode | null = null;
  private keyAnalyser: AnalyserNode | null = null;
  private duckBuffer = new Float32Array(1024);

  /** Whether the pitch worklet has loaded; chains built before it lack pitch. */
  private pitchReady = false;

  private voices = new Map<string, Voice>();
  private levelBuffer = new Float32Array(1024);
  private peakHold = 0;
  private masterMuted = false;

  /*
    Whether the timeline is putting sound into the room, and who wants to know.

    Every voice here is a *detached* `Audio` element — created in `acquire`,
    routed into the graph through `createMediaElementSource`, and never added
    to the document, because the picture comes from a canvas and this element
    exists only to be a source node. That makes the whole timeline invisible to
    `services/voice/selfAudio.ts`, which finds the app's other sound by
    querying the document for `video, audio` — and an element that is not in
    the document is not in `querySelectorAll` and would fail `isConnected`
    anyway. So the microphone heard the operator's own footage, correctly
    transcribed it, and answered it as if they had said it.

    The engine reports instead of being discovered. It says nothing about
    microphones and knows nothing about the assistant; `watchTimelineAudio`
    arms this in `main.tsx` beside the document and browser watchers.
  */
  private audible = false;
  private audibleHandler: ((audible: boolean) => void) | null = null;

  /* ── Graph ── */

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === 'undefined') return null;

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;

    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.splitter = this.ctx.createChannelSplitter(2);
    this.analyserL = this.ctx.createAnalyser();
    this.analyserR = this.ctx.createAnalyser();

    for (const a of [this.analyserL, this.analyserR]) {
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0.6;
    }

    // Master feeds the meters AND the speakers; the splitter is a tap.
    this.master.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
    this.master.connect(this.ctx.destination);

    this.duckedBus = this.ctx.createGain();
    this.keyBus = this.ctx.createGain();
    this.duckedBus.gain.value = 1;
    this.keyBus.gain.value = 1;
    this.duckedBus.connect(this.master);
    this.keyBus.connect(this.master);

    // A tap on the key bus, not in line with it: this is the sidechain.
    this.keyAnalyser = this.ctx.createAnalyser();
    this.keyAnalyser.fftSize = 2048;
    this.keyAnalyser.smoothingTimeConstant = 0;
    this.keyBus.connect(this.keyAnalyser);

    /*
      The pitch worklet loads asynchronously, and any voice built before
      it lands has no shifter in it. Rather than leave those silently
      unpitched, drop them when the module arrives so the next frame
      rebuilds them — `sync` runs every frame, so "next frame" is ~16ms.
    */
    void ensurePitchWorklet(this.ctx).then((ok) => {
      this.pitchReady = ok;
      if (!ok) return;
      for (const [clipId, voice] of this.voices) {
        if (voice.sig.endsWith(':0') && !/deep|high/.test(voice.sig)) continue;
        this.release(clipId);
      }
    });

    return this.ctx;
  }

  /** Browsers start suspended until a gesture; call this from a click. */
  resume(): void {
    const ctx = this.ensureContext();
    if (ctx?.state === 'suspended') void ctx.resume();
  }

  setMasterMuted(muted: boolean): void {
    this.masterMuted = muted;
    if (muted) this.reportAudible(false);
    if (this.master) this.master.gain.value = muted ? 0 : 1;
  }

  isMuted(): boolean {
    return this.masterMuted;
  }

  /**
   * Be told when the timeline starts or stops making sound.
   *
   * One listener, not a set: there is one pair of speakers and one microphone,
   * and a second subscriber would mean a second answer to the same question.
   */
  onAudibleChange(handler: ((audible: boolean) => void) | null): () => void {
    this.audibleHandler = handler;
    handler?.(this.audible);
    return () => {
      if (this.audibleHandler === handler) this.audibleHandler = null;
    };
  }

  /** Fires only on a change, because `sync` runs every frame. */
  private reportAudible(next: boolean): void {
    if (next === this.audible) return;
    this.audible = next;
    this.audibleHandler?.(next);
  }

  /* ── Voices ── */

  private acquire(clip: Clip): Voice | null {
    const existing = this.voices.get(clip.id);
    if (existing) return existing;

    const ctx = this.ensureContext();
    if (!ctx || !this.master || !clip.mediaUrl) return null;

    const el = new Audio();
    el.src = clip.mediaUrl;
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    // Muting the element itself would silence the Web Audio path too.
    el.volume = 1;

    let source: MediaElementAudioSourceNode;
    try {
      source = ctx.createMediaElementSource(el);
    } catch {
      // An element can only ever be attached to one source node.
      return null;
    }

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const chain = buildVoiceChain(ctx, clip.audio, { pitchReady: this.pitchReady });
    source.connect(chain.input);
    chain.output.connect(gain);

    const ducked = Boolean(clip.audio.ducking);
    gain.connect(ducked ? this.duckedBus! : this.keyBus!);

    const voice: Voice = {
      el, source, chain, gain, clipId: clip.id,
      sig: chainSignature(clip.audio), ducked,
      lastGain: 0, requestedTime: null, lastUsedAt: performance.now(),
    };
    this.voices.set(clip.id, voice);
    return voice;
  }

  /**
   * Re-patch a live voice whose audio settings changed.
   *
   * Voices persist across frames and normally only their gain is written,
   * so switching a clip to `telephone` mid-session would otherwise do
   * nothing until the voice happened to be released for some other
   * reason. The element and its `MediaElementAudioSourceNode` are kept —
   * `createMediaElementSource` may only ever be called once per element,
   * and rebuilding them would restart the audio — so only the effects
   * between the source and the bus are replaced.
   */
  private repatch(voice: Voice, clip: Clip): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const sig = chainSignature(clip.audio);
    const ducked = Boolean(clip.audio.ducking);
    if (sig === voice.sig && ducked === voice.ducked) return;

    if (sig !== voice.sig) {
      try { voice.source.disconnect(); } catch { /* already detached */ }
      disposeChain(voice.chain);
      voice.chain = buildVoiceChain(ctx, clip.audio, { pitchReady: this.pitchReady });
      voice.source.connect(voice.chain.input);
      voice.chain.output.connect(voice.gain);
      voice.sig = sig;
    }

    if (ducked !== voice.ducked) {
      try { voice.gain.disconnect(); } catch { /* already detached */ }
      voice.gain.connect(ducked ? this.duckedBus! : this.keyBus!);
      voice.ducked = ducked;
    }
  }

  private release(clipId: string): void {
    const voice = this.voices.get(clipId);
    if (!voice) return;
    try {
      voice.el.pause();
      voice.gain.disconnect();
      voice.source.disconnect();
      disposeChain(voice.chain);
      voice.el.removeAttribute('src');
      voice.el.load();
    } catch {
      /* already torn down */
    }
    this.voices.delete(clipId);
  }

  /** Fade envelope and every volume the mixer applies, as one number. */
  private gainFor(clip: Clip, track: Track, offsetMs: number, anySolo: boolean): number {
    if (clip.hidden || track.muted) return 0;
    /*
      Solo means "only this", so a soloed AUDIO track silences every
      other source of sound — including the audio embedded in clips on
      VIDEO tracks, which used to sail straight past this gate because
      it also tested `track.type === 'audio'`. Measured before the
      change: a soloed audio track left a video clip's 440Hz tone at
      68.75dB, exactly where it started, delta 0.00dB.

      This is the AUDIO gate only. The picture is governed separately —
      `compositor.ts` and `videoEngine.ts` count only non-audio tracks
      when deciding what to paint, so soloing an audio track no longer
      blanks the frame and soloing a video track still hides the other
      video tracks.
    */
    if (anySolo && !track.solo) return 0;

    let g = clip.audio.volume * track.volume;

    const { fadeInMs, fadeOutMs } = clip.audio;
    if (fadeInMs > 0 && offsetMs < fadeInMs) g *= offsetMs / fadeInMs;

    const fromEnd = clip.durationMs - offsetMs;
    if (fadeOutMs > 0 && fromEnd < fadeOutMs) g *= Math.max(0, fromEnd / fadeOutMs);

    return Math.max(0, Math.min(4, g));
  }

  /**
   * Reconcile playback against the timeline. Called every frame.
   *
   * Cheap when nothing changed: elements already playing at the right
   * offset are left alone, and only gain is written.
   */
  sync(tracks: Track[], playheadMs: number, isPlaying: boolean, rate: number): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    if (isPlaying && ctx.state === 'suspended') void ctx.resume();

    const anySolo = tracks.some((t) => t.type === 'audio' && t.solo);
    const live = new Set<string>();
    const now = performance.now();
    let duckedLive = 0;
    let keyLive = 0;
    let sounding = 0;

    for (const track of tracks) {
      for (const clip of track.clips) {
        // Video clips carry their own audio unless it has been detached.
        const audible = Boolean(clip.mediaUrl) && (track.type === 'audio' || clip.type === 'video');
        if (!audible) continue;

        const offsetMs = playheadMs - clip.startTimeMs;
        const inside = offsetMs >= 0 && offsetMs < clip.durationMs;
        if (!inside) continue;

        live.add(clip.id);

        const voice = this.acquire(clip);
        if (!voice) continue;
        this.repatch(voice, clip);
        voice.lastUsedAt = now;

        if (clip.audio.ducking) duckedLive++; else keyLive++;

        const gain = this.gainFor(clip, track, offsetMs, anySolo);
        // A short ramp instead of a jump: stepping gain per frame clicks —
        // and only when the destination moved, because scheduling an
        // automation event to hold a level is sixty events a second of
        // nothing. See `GAIN_EPSILON`.
        if (Math.abs(gain - voice.lastGain) > GAIN_EPSILON) {
          voice.gain.gain.setTargetAtTime(gain, ctx.currentTime, 0.02);
          voice.lastGain = gain;
        }
        // A clip under the playhead on a muted or unsoloed track is silent,
        // and silence is not something the microphone has to be careful of.
        if (isPlaying && gain > 0) sounding++;

        // Where in the SOURCE this timeline position lands.
        const sourceSeconds =
          (clip.sourceStartMs + offsetMs * (clip.speed?.multiplier ?? 1)) / 1000;

        if (!isPlaying) {
          if (!voice.el.paused) voice.el.pause();
          // Keep the element parked so unpausing is instant and correct —
          // asking once per position, not once per frame. See
          // `shouldParkSeek`.
          if (shouldParkSeek({
            currentTime: voice.el.currentTime,
            requestedTime: voice.requestedTime,
            target: sourceSeconds,
            seeking: voice.el.seeking,
          })) {
            voice.requestedTime = sourceSeconds;
            try { voice.el.currentTime = sourceSeconds; } catch { /* not seekable yet */ }
          }
          continue;
        }

        /* Playing: the element owns its own position, so the last parked
           target must not veto the next seek. */
        voice.requestedTime = null;

        const targetRate = Math.max(0.25, Math.min(4, rate * (clip.speed?.multiplier ?? 1)));
        const signedDrift = sourceSeconds - voice.el.currentTime;
        const absDrift = Math.abs(signedDrift);

        if (absDrift > 1.2 && Number.isFinite(sourceSeconds)) {
          if (!voice.el.seeking) {
            try { voice.el.currentTime = sourceSeconds; } catch { /* not seekable yet */ }
          }
        } else if (absDrift > 0.03 && Number.isFinite(sourceSeconds)) {
          // Dynamic PLL rate adjustment instead of hard seeking: eliminates audio muting and stutter
          const nudge = Math.max(-0.15, Math.min(0.15, signedDrift * 0.3));
          const adjustedRate = Math.max(0.25, Math.min(4, targetRate * (1 + nudge)));
          if (Math.abs(voice.el.playbackRate - adjustedRate) > 0.01) {
            voice.el.playbackRate = adjustedRate;
          }
        } else {
          if (voice.el.playbackRate !== targetRate) voice.el.playbackRate = targetRate;
        }

        if (voice.el.paused) {
          // A rejected play() is normal before the first gesture — not an error.
          void voice.el.play().catch(() => {});
        }
      }
    }

    /*
      Anything no longer under the playhead stops immediately — and after
      a while is torn down rather than left resident.

      Both halves were wrong. The ramp to zero was unconditional, so a
      silent voice scheduled an automation event every frame to stay
      silent; and nothing ever released these, so every clip the playhead
      had ever crossed kept an `<audio>` element, a decoder and a filter
      chain alive for the life of the page. Scrub across a long timeline
      and that is what the memory and the audio thread go to.
    */
    for (const [clipId, voice] of this.voices) {
      if (live.has(clipId)) continue;
      if (!voice.el.paused) voice.el.pause();
      if (voice.lastGain > GAIN_EPSILON) {
        voice.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
        voice.lastGain = 0;
      }
      /* Kept long enough that scrubbing back and forth across a cut
         re-uses the voice rather than rebuilding its whole chain. */
      if (this.voices.size > VOICE_SOFT_LIMIT && now - voice.lastUsedAt > VOICE_IDLE_EVICT_MS) {
        this.release(clipId);
      }
    }

    this.applyDucking(ctx, duckedLive > 0 && keyLive > 0, isPlaying);
    this.reportAudible(sounding > 0 && !this.masterMuted);
  }

  /**
   * Pull the ducked bus down by how loud the key bus is.
   *
   * The render does this with `sidechaincompress`, which WebAudio has no
   * equivalent of — `DynamicsCompressorNode` can only compress against
   * its own input. So the key bus is measured through an analyser once
   * per frame and the reduction is written to the ducked bus's gain, with
   * the same threshold and ratio the filtergraph uses.
   *
   * Per frame is ~16ms against ffmpeg's per-sample envelope. The attack
   * and release that matter are 20ms and 320ms, so the audible result
   * lands in the same place, and `setTargetAtTime` smooths between frames
   * rather than stepping. It is close, not identical, and
   * `describe_audio_preview` says so.
   */
  private applyDucking(ctx: AudioContext, active: boolean, isPlaying: boolean): void {
    const bus = this.duckedBus;
    const analyser = this.keyAnalyser;
    if (!bus || !analyser) return;

    if (!active) {
      // Nothing to duck against — the export falls back to a plain mix
      // rather than compressing the track against itself, and so does this.
      bus.gain.setTargetAtTime(1, ctx.currentTime, DUCK_ATTACK_S);
      return;
    }

    let keyRms = 0;
    if (isPlaying) {
      analyser.getFloatTimeDomainData(this.duckBuffer);
      let sum = 0;
      for (let i = 0; i < this.duckBuffer.length; i++) sum += this.duckBuffer[i] * this.duckBuffer[i];
      keyRms = Math.sqrt(sum / this.duckBuffer.length);
    }

    const target = duckGainFor(keyRms);
    // Ducking fast and recovering slowly is the whole point of a ducker;
    // one time constant for both would either pump or arrive late.
    const tau = target < bus.gain.value ? DUCK_ATTACK_S : DUCK_RELEASE_S;
    bus.gain.setTargetAtTime(target, ctx.currentTime, tau);
  }

  /** Stop everything and drop every element. */
  stopAll(): void {
    for (const clipId of [...this.voices.keys()]) this.release(clipId);
    this.peakHold = 0;
    this.reportAudible(false);
  }

  /** Discard a clip's voice, so a changed source is reloaded next frame. */
  invalidate(clipId: string): void {
    this.release(clipId);
  }

  /* ── Metering ── */

  private rms(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (let i = 0; i < this.levelBuffer.length; i++) sum += this.levelBuffer[i] * this.levelBuffer[i];
    const rms = Math.sqrt(sum / this.levelBuffer.length);
    // Perceptual curve — a linear RMS bar sits near the floor at normal levels.
    return Math.min(1, Math.pow(rms, 0.55) * 1.6);
  }

  /** Real output levels, measured from the graph. */
  getLevels(): { l: number; r: number; peak: number } {
    if (!this.ctx) return { l: 0, r: 0, peak: 0 };
    const l = this.rms(this.analyserL);
    const r = this.rms(this.analyserR);
    this.peakHold = Math.max(this.peakHold * 0.94, l, r);
    return { l, r, peak: this.peakHold };
  }

  get isAvailable(): boolean {
    return this.ctx !== null;
  }
}

export const audioEngine = new AudioPlaybackEngine();
