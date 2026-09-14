/**
 * Teminali OS full-duplex Web Audio pipeline.
 *
 * This file used to be "Port 8000 Realtime Voice Engine" and carried both
 * halves of the lane: the Web Audio graph and the binary WebSocket protocol
 * that talked to the local Python pipeline on :8000. The protocol half is gone
 * — the lane is Gemini Live now, and `geminiLiveEngine.ts` owns the wire.
 *
 * What is left is engine-agnostic and stays that way. It captures the
 * microphone through `pcmWorkletProcessor`, batches it into 8-byte-header +
 * 2048-Int16 frames at the AudioContext rate (pinned to 48000 Hz below), plays
 * assistant PCM through `ttsPlaybackProcessor`, and reports energy for the two
 * meters. Every processing choice here was settled by measurement — see the
 * AEC/NS/AGC table in `start()` — so a new protocol drives this class rather
 * than reimplementing it.
 */

/*
  The two worklets have exactly one copy each, in `./worklets`, and they reach
  the AudioContext as a blob built from those bytes.

  They used to be served as files from `public/` and loaded by URL, with an
  inline transcription as the fallback. Both halves of that were wrong. The URL
  was root-absolute, so in a packaged build, where the page is loaded from
  `file:///.../app.asar/dist/index.html`, it resolved to the root of the
  operator's filesystem and always failed -- invisible in dev, which serves from
  `/`. That threw every packaged session onto the fallback, and the fallback had
  drifted: `ttsPlaybackProcessor.js` learned a `resetProgress` message and the
  transcription never did, so the control object landed on the PCM queue,
  `samplesRemaining` went NaN, and the first spoken turn wedged the lane for the
  rest of the session. A blob from a `?raw` import has no origin to resolve
  against and no second copy to drift from.

  The import is deferred to the one place that needs it. `?raw` is a bundler
  specifier that bare Node cannot resolve, and `tests/voice-directive-echo.test.mjs`
  imports this module directly to pin a pure predicate; a static import would
  fail that test at load. A session needs a real AudioContext, so no Node test
  can reach these lines.
*/



/**
 * Register one worklet from its own source file. The object URL is revoked once
 * the module is parsed: `addModule` resolves after the worklet global scope has
 * the processor, so nothing reads the blob again.
 */
async function addWorklet(context: AudioContext, load: () => Promise<{ default: string }>): Promise<void> {
  const { default: code } = await load();
  const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class VoiceAudioEngine {
  audioContext: AudioContext | null = null;
  mediaStream: MediaStream | null = null;
  micWorklet: AudioWorkletNode | null = null;
  ttsWorklet: AudioWorkletNode | null = null;
  micSource: MediaStreamAudioSourceNode | null = null;
  userAnalyser: AnalyserNode | null = null;
  assistantAnalyser: AnalyserNode | null = null;
  isTTSPlaying = false;
  ttsStoppedAt = 0;
  isMuted = false;

  onAudioChunkReady: ((buf: ArrayBuffer) => void) | null = null;
  onTTSPlaybackStarted: (() => void) | null = null;
  onTTSPlaybackStopped: (() => void) | null = null;
  /** Seconds of this utterance the speaker has actually emitted. Drives the
      caption, which is paced by the voice rather than by generation. */
  onTTSProgress: ((secondsPlayed: number) => void) | null = null;

  BATCH_SAMPLES = 2048;
  HEADER_BYTES = 8;
  FRAME_BYTES = 2048 * 2;
  MESSAGE_BYTES = 8 + 2048 * 2;

  batchBuffer: ArrayBuffer | null = null;
  batchView: DataView | null = null;
  batchInt16: Int16Array | null = null;
  batchOffset = 0;

  initBatch() {
    if (!this.batchBuffer) {
      this.batchBuffer = new ArrayBuffer(this.MESSAGE_BYTES);
      this.batchView = new DataView(this.batchBuffer);
      this.batchInt16 = new Int16Array(this.batchBuffer, this.HEADER_BYTES);
      this.batchOffset = 0;
    }
  }

  flushBatch() {
    if (!this.batchBuffer || !this.batchView) return;
    const ts = Date.now() & 0xffffffff;
    this.batchView.setUint32(0, ts, false); // big-endian
    const isDucked = this.isTTSPlaying || Date.now() - this.ttsStoppedAt < 400;
    const flags = isDucked ? 1 : 0;
    this.batchView.setUint32(4, flags, false); // big-endian

    if (this.onAudioChunkReady && !this.isMuted) {
      this.onAudioChunkReady(this.batchBuffer);
    }

    this.batchBuffer = null;
    this.batchView = null;
    this.batchInt16 = null;
    this.batchOffset = 0;
  }

  flushRemainder() {
    if (this.batchOffset > 0 && this.batchInt16) {
      for (let i = this.batchOffset; i < this.BATCH_SAMPLES; i++) {
        this.batchInt16[i] = 0;
      }
      this.flushBatch();
    }
  }

  private startGeneration = 0;

  async start() {
    const generation = ++this.startGeneration;

    if (!this.audioContext || this.audioContext.state === "closed") {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioCtx({ sampleRate: 48000 });
    }
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    if (this.startGeneration !== generation) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
    });

    if (this.startGeneration !== generation) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.mediaStream = stream;

    if (!this.audioContext || this.audioContext.state === "closed") {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioCtx({ sampleRate: 48000 });
    }
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    this.userAnalyser = this.audioContext.createAnalyser();
    this.userAnalyser.fftSize = 128;
    this.userAnalyser.smoothingTimeConstant = 0.8;

    await addWorklet(this.audioContext, () => import("./worklets/pcmWorkletProcessor.js?raw"));
    this.micWorklet = new AudioWorkletNode(this.audioContext, "pcm-worklet-processor");

    this.micWorklet.port.onmessage = ({ data }) => {
      const incoming = new Int16Array(data);
      let read = 0;
      while (read < incoming.length) {
        this.initBatch();
        const toCopy = Math.min(incoming.length - read, this.BATCH_SAMPLES - this.batchOffset);
        if (this.batchInt16) {
          this.batchInt16.set(incoming.subarray(read, read + toCopy), this.batchOffset);
        }
        this.batchOffset += toCopy;
        read += toCopy;
        if (this.batchOffset === this.BATCH_SAMPLES) {
          this.flushBatch();
        }
      }
    };

    this.micSource = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.micSource.connect(this.micWorklet);
    this.micSource.connect(this.userAnalyser);

    const zeroGain = this.audioContext.createGain();
    zeroGain.gain.value = 0;
    this.micWorklet.connect(zeroGain);
    zeroGain.connect(this.audioContext.destination);

    await addWorklet(this.audioContext, () => import("./worklets/ttsPlaybackProcessor.js?raw"));
    this.ttsWorklet = new AudioWorkletNode(this.audioContext, "tts-playback-processor");

    this.assistantAnalyser = this.audioContext.createAnalyser();
    this.assistantAnalyser.fftSize = 128;
    this.assistantAnalyser.smoothingTimeConstant = 0.85;

    this.ttsWorklet.port.onmessage = (event) => {
      const { type } = event.data;
      if (type === "ttsPlaybackStarted") {
        this.isTTSPlaying = true;
        this.onTTSPlaybackStarted?.();
      } else if (type === "ttsPlaybackStopped") {
        this.isTTSPlaying = false;
        this.ttsStoppedAt = Date.now();
        this.onTTSPlaybackStopped?.();
      } else if (type === "ttsProgress") {
        this.onTTSProgress?.(event.data.secondsPlayed as number);
      }
    };

    this.ttsWorklet.connect(this.assistantAnalyser);
    this.ttsWorklet.connect(this.audioContext.destination);
  }

  playTTSChunk(int16Array: Int16Array) {
    if (this.ttsWorklet) {
      this.ttsWorklet.port.postMessage(int16Array);
    }
  }

  /** Start a new caption clock. A spoken turn is a conversational boundary; the
      worklet cannot infer one, because the buffer underruns between sentences
      all the time and that is not a new utterance. */
  resetTTSProgress() {
    this.ttsWorklet?.port.postMessage({ type: "resetProgress" });
  }

  stopTTSPlayback() {
    this.isTTSPlaying = false;
    this.ttsStoppedAt = Date.now();
    if (this.ttsWorklet) {
      this.ttsWorklet.port.postMessage({ type: "clear" });
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    return this.isMuted;
  }

  getUserEnergy() {
    if (!this.userAnalyser || this.isMuted) return 0;
    const data = new Uint8Array(this.userAnalyser.frequencyBinCount);
    this.userAnalyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum / data.length / 255;
  }

  getAssistantEnergy() {
    if (!this.assistantAnalyser || !this.isTTSPlaying) return 0;
    const data = new Uint8Array(this.assistantAnalyser.frequencyBinCount);
    this.assistantAnalyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum / data.length / 255;
  }

  cleanup() {
    this.startGeneration++;
    this.isTTSPlaying = false;
    this.ttsStoppedAt = 0;
    this.flushRemainder();
    if (this.micSource) {
      try { this.micSource.disconnect(); } catch {}
      this.micSource = null;
    }
    if (this.micWorklet) {
      try { this.micWorklet.disconnect(); } catch {}
      this.micWorklet = null;
    }
    if (this.ttsWorklet) {
      try { this.ttsWorklet.disconnect(); } catch {}
      this.ttsWorklet = null;
    }
    if (this.audioContext) {
      try { this.audioContext.close(); } catch {}
      this.audioContext = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    this.isTTSPlaying = false;
  }
}
