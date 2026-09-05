/**
 * Plays a streamed `/speak` reply as it arrives. Each clause frame becomes one
 * AudioBuffer scheduled to start the instant the previous one ends, so the
 * clauses play as a single utterance while the sidecar is still rendering the
 * later ones. The reply starts speaking after the first clause instead of
 * after the whole render.
 *
 * `SpeakOptions` keeps exactly the meaning it has on the whole-file path:
 * `onStart` when the first clause is audible, `onBoundary` with the character
 * offset each clause begins at, `onEnd` with how many characters were actually
 * heard. The offsets come from the sidecar, so a barge-in mid-reply reports the
 * clause it landed in rather than a proportion of the playback clock.
 */

import { VoiceError, type SpeakOptions, type SynthesisHandle } from "./types";
import {
  FrameReader,
  heardChars,
  isClauseFrame,
  nextStartTime,
  pcm16ToFloat32,
  type ClauseFrame,
} from "./speechStream";

let shared: AudioContext | null = null;

if (typeof window !== "undefined") {
  const unlock = () => {
    if (shared && shared.state === "suspended") {
      void shared.resume().catch(() => undefined);
    }
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
}

/**
 * One output context for every reply. A context per utterance pays a warm-up
 * each time and runs into Chromium's cap on live contexts; a buffer at 24 kHz
 * plays correctly on a 48 kHz context, so the rate never needs to match.
 */
async function outputContext(): Promise<AudioContext> {
  if (!shared) {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    shared = new Ctor();
  }
  if (shared.state === "suspended") {
    try {
      await shared.resume();
    } catch {}
  }
  return shared;
}

interface Scheduled {
  frame: ClauseFrame;
  source: AudioBufferSourceNode;
  startAt: number;
  endAt: number;
  /** Set by the source's own `ended` event: the only clock that is trusted for settling. */
  ended: boolean;
}

/**
 * Consume `response` as clause frames and play them. Resolves with the handle
 * once the first clause is scheduled — the moment the reply starts speaking —
 * and rejects if the stream ends before any audio arrived.
 */
export async function playSpeechStream(
  response: Response,
  options: SpeakOptions,
  controller: AbortController,
): Promise<SynthesisHandle> {
  if (!response.body) throw new VoiceError("The synthesised reply had no body.", "TTS_FAILED");
  const context = await outputContext();
  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch {}
  }
  const reader = response.body.getReader();
  const frames = new FrameReader();
  const schedule: Scheduled[] = [];

  let speaking = true;
  let streamDone = false;
  let started = false;
  let spokenChars = 0;
  let firstError: Error | null = null;
  let settleFirst: ((error?: Error) => void) | null = null;
  const analyser = (typeof context.createAnalyser === "function" && options.onAudioLevel)
    ? context.createAnalyser()
    : null;
  if (analyser) {
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.25;
    analyser.connect(context.destination);
  }

  let levelInterval: number | null = null;
  if (options.onAudioLevel && analyser) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    levelInterval = window.setInterval(() => {
      if (!speaking) return;
      const now = context.currentTime;
      const isAudible = started && schedule.some((entry) => !entry.ended && now >= entry.startAt && now < entry.endAt);
      if (!isAudible) {
        options.onAudioLevel?.(0);
        return;
      }
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const norm = (data[i] - 128) / 128;
        sum += norm * norm;
      }
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(1, Math.max(0, rms * 4.2));
      options.onAudioLevel?.(level);
    }, 35);
  }

  /**
   * The one exit. After the first clause it reports what was heard; before it
   * the `speak()` promise rejects instead, as the whole-file path does when
   * its fetch is aborted, so no caller sees an `onEnd` for a reply that never
   * started.
   */
  const finish = () => {
    if (!speaking) return;
    speaking = false;
    if (levelInterval !== null) {
      clearInterval(levelInterval);
      levelInterval = null;
    }
    options.onAudioLevel?.(0);
    for (const entry of schedule) {
      entry.source.onended = null;
      try {
        entry.source.stop();
      } catch {
        // Already stopped, or never started: either way it is silent.
      }
    }
    schedule.length = 0;
    reader.cancel().catch(() => undefined);
    if (started) options.onEnd?.(spokenChars);
    else settleFirst?.(firstError ?? new VoiceError("The reply was cancelled before it started.", "TTS_FAILED"));
  };

  /**
   * Everything received has been played and nothing more is coming. Settles
   * on the sources' own `ended` events, never on `currentTime` arithmetic: an
   * event that fires a render quantum early must not leave the engine
   * speaking forever.
   */
  const settleIfIdle = () => {
    if (streamDone && schedule.every((entry) => entry.ended)) finish();
  };

  const play = (frame: ClauseFrame, body: Uint8Array) => {
    const samples = pcm16ToFloat32(body);
    if (samples.length === 0) return;
    const buffer = context.createBuffer(1, samples.length, frame.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    if (analyser) {
      source.connect(analyser);
    } else {
      source.connect(context.destination);
    }

    const previous = schedule[schedule.length - 1];
    const startAt = nextStartTime(context.currentTime, previous?.endAt ?? 0);
    const entry: Scheduled = { frame, source, startAt, endAt: startAt + buffer.duration, ended: false };
    schedule.push(entry);

    source.onended = () => {
      if (!speaking) return;
      entry.ended = true;
      spokenChars = Math.max(spokenChars, frame.end);
      const next = schedule[schedule.indexOf(entry) + 1];
      if (next) options.onBoundary?.(next.frame.start);
      else settleIfIdle();
    };
    source.start(startAt);

    if (!started) {
      started = true;
      options.onStart?.();
      settleFirst?.();
    }
    // A clause that arrives after the previous one has already finished (the
    // renderer fell behind) is its own boundary; otherwise the previous
    // clause's `ended` event announces it. Never both.
    if (!previous || previous.ended) options.onBoundary?.(frame.start);
  };

  const cancel = () => {
    if (!speaking) return;
    // Report the clause the operator was hearing, not the last one received.
    const now = context.currentTime;
    for (const entry of schedule) {
      if (now >= entry.endAt) spokenChars = Math.max(spokenChars, entry.frame.end);
      else if (now > entry.startAt) spokenChars = Math.max(spokenChars, heardChars(entry.frame, now - entry.startAt));
    }
    controller.abort();
    finish();
  };
  controller.signal.addEventListener("abort", cancel);

  const pump = async () => {
    try {
      while (speaking && !streamDone) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of frames.push(value)) {
          if (frame.header.error) {
            if (!started) throw new VoiceError(frame.header.error, "TTS_FAILED");
            streamDone = true;
            break;
          }
          if (frame.header.done) {
            streamDone = true;
            break;
          }
          if (isClauseFrame(frame.header)) play(frame.header, frame.body);
        }
      }
      // A stream that ends without `done` was cut off; what arrived still plays out.
      streamDone = true;
      if (!started) throw new VoiceError("The synthesised reply was empty.", "TTS_FAILED");
      settleIfIdle();
    } catch (error) {
      streamDone = true;
      if (!speaking) return;
      if (!started) {
        firstError = error instanceof Error ? error : new VoiceError("The synthesised reply could not be read.", "TTS_FAILED");
        finish();
        return;
      }
      settleIfIdle();
    }
  };

  const firstAudio = new Promise<void>((resolve, reject) => {
    settleFirst = (error) => {
      settleFirst = null;
      if (error) reject(error);
      else resolve();
    };
  });
  void pump();
  await firstAudio;

  return {
    cancel,
    get speaking() {
      return speaking;
    },
  };
}
