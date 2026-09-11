/**
 * Teminali OS Port 8000 Realtime Voice Engine
 * Full-duplex Web Audio pipeline + Binary WebSocket Protocol
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

export class Realtime8000AudioEngine {
  audioContext: AudioContext | null = null;
  mediaStream: MediaStream | null = null;
  micWorklet: AudioWorkletNode | null = null;
  ttsWorklet: AudioWorkletNode | null = null;
  micSource: MediaStreamAudioSourceNode | null = null;
  userAnalyser: AnalyserNode | null = null;
  assistantAnalyser: AnalyserNode | null = null;
  isTTSPlaying = false;
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
    const flags = this.isTTSPlaying ? 1 : 0;
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

  async start() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioCtx({ sampleRate: 48000 });
    }
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    /*
      All three processors stay on. Chromium's audio processing applies a gain
      stage whenever noise suppression or AGC is enabled, and in a quiet room it
      drives the peaks to full scale -- measured through this app's own
      microphone, 2026-09-11, 102400 samples each, same room, back to back:

        nothing on        peak -12.9 dBFS   rms -31.1   0 clipped
        AEC only          peak  -9.8 dBFS   rms -31.2   0 clipped
        AEC + NS          peak   0.0 dBFS   rms -23.8   5 clipped
        AEC + AGC         peak   0.0 dBFS   rms -22.9   3 clipped
        AEC + NS + AGC    peak  -0.0 dBFS   rms -24.5   clipping

      Clipped audio is what Whisper answers with repetition loops and with its
      canonical silence artifact, "Thank you very much", so it is worth fixing.
      It was tried here and must not be tried again this way: turning AGC and NS
      off dropped what actually reached the pipeline to peak -29.2 dBFS, rms
      -58.3, measured off the wire in the frames the app sends. The recogniser
      never triggered at all. AGC is not decoration; it is the only thing
      putting a quiet room at a level the VAD can hear.

      The fix, when someone takes it on, belongs downstream of the gain rather
      than instead of it -- a limiter in `pcmWorkletProcessor`, which already
      clamps to +/-1 and so has the peak in its hands -- and it needs to be
      judged on what leaves the socket, not on what an AnalyserNode reads from a
      separate stream. Those two disagreed by 20 dB here.
    */
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
    });

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

export class Realtime8000ProtocolManager {
  socket: WebSocket | null = null;
  currentGenId = 0;
  ignoreTTS = false;
  explicitlyDisconnected = false;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by connect(); the gateway is the only source of this address. */
  serverUrl = "";

  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onError: ((err: Event) => void) | null = null;
  onMessage: ((msg: any) => void) | null = null;

  connect(url: string) {
    if (!url) return;
    this.serverUrl = url;
    this.explicitlyDisconnected = false;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      this.socket = new WebSocket(url);
      this.socket.binaryType = "arraybuffer";

      this.socket.onopen = () => {
        this.onConnected?.();
      };

      this.socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data);
            this.handleInboundMessage(msg);
          } catch (e) {
            console.error("Protocol parse error:", e);
          }
        }
      };

      this.socket.onclose = () => {
        this.onDisconnected?.();
        if (!this.explicitlyDisconnected) {
          this.scheduleReconnect();
        }
      };

      this.socket.onerror = (err) => {
        this.onError?.(err);
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.explicitlyDisconnected) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.explicitlyDisconnected) {
        this.connect(this.serverUrl);
      }
    }, 2000);
  }

  sendAudioChunk(buffer: ArrayBuffer) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(buffer);
    }
  }

  sendJSON(payload: unknown) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  sendUserText(text: string) {
    this.sendJSON({ type: "user_text", text });
  }

  /**
   * Cancel the reply the pipeline started generating the moment it sent us the
   * transcript. Used whenever the turn is answered here instead — a status
   * question, a stop, praise — so two voices never answer one sentence.
   */
  sendBargeIn() {
    this.sendJSON({ type: "user_barge_in" });
  }

  /**
   * A line the Teminali OS shell wants spoken now, in Temi's voice: an answer
   * built from the live agent run, or its final report.
   *
   * It is not a user turn, but the pipeline has one way in, so it enters as a
   * bracketed directive. `user_text` cannot carry these — the server drops
   * bracketed prose there, because an unrefreshed browser tab on the pipeline's
   * own preview page can replay it. A build old enough to be that stale tab
   * does not know this message type, which is the whole point of it existing.
   */
  /**
   * Is this "user turn" actually our own directive coming back?
   *
   * `sendAssistantDirective` is not a user turn, but the pipeline has one way
   * in, so `server.py` wraps it and delivers it through `on_final` -- the same
   * callback a spoken turn uses. It therefore returns to us as
   * `final_user_request`, indistinguishable from speech by type alone.
   *
   * Left unguarded that closes a loop: the shell delegates, speaks "On it.",
   * the directive returns as a user turn, the switch classifies it as work and
   * delegates again. Observed 2026-09-10 with the queue filling with identical
   * tasks and the assistant talking to itself.
   *
   * The prefix is `server.py`'s, and it is matched here rather than in the
   * consumer so the sender and the recogniser stay in one file.
   */
  static isAssistantDirectiveEcho(text: string): boolean {
    return /^\[\s*Say this to the user now\b/i.test((text ?? "").trim());
  }

  sendAssistantDirective(text: string) {
    const line = (text ?? "").trim();
    if (!line) return;
    this.sendJSON({ type: "assistant_directive", text: line });
  }

  sendTTSStart() {
    this.sendJSON({ type: "tts_start" });
  }

  sendTTSStop() {
    this.sendJSON({ type: "tts_stop" });
  }

  sendVoiceChange(voice: string) {
    this.sendJSON({ type: "set_voice", voice });
  }

  sendSpeedChange(speed: number) {
    this.sendJSON({ type: "set_speed", speed });
  }

  sendClearHistory() {
    this.sendJSON({ type: "clear_history" });
  }

  handleInboundMessage(msg: { type: string; gen_id?: number; content?: string }) {
    const { type, gen_id } = msg;

    if (gen_id !== undefined) {
      if (type === "tts_chunk" && gen_id < this.currentGenId) {
        return;
      }
      if (gen_id > this.currentGenId) {
        this.ignoreTTS = false;
        this.currentGenId = gen_id;
      }
    }

    if (type === "final_user_request" || type === "partial_user_request" || type === "partial_assistant_answer") {
      this.ignoreTTS = false;
    }

    if (type === "tts_interruption" || type === "stop_tts") {
      this.ignoreTTS = type === "stop_tts";
      this.onMessage?.({ type: "tts_interrupt", gen_id });
      return;
    }

    if (type === "tts_chunk" && msg.content) {
      if (this.ignoreTTS) return;
      const raw = atob(msg.content);
      const buf = new ArrayBuffer(raw.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
      const int16 = new Int16Array(buf);
      this.onMessage?.({ type: "tts_audio", int16, gen_id });
      return;
    }

    this.onMessage?.(msg);
  }

  disconnect() {
    this.explicitlyDisconnected = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}
