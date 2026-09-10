/**
 * Teminali OS Port 8000 Realtime Voice Engine
 * Full-duplex Web Audio pipeline + Binary WebSocket Protocol
 */

const PCM_WORKLET_CODE = `
class PCMWorkletProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const in32 = inputs[0][0];
    if (in32) {
      const int16 = new Int16Array(in32.length);
      for (let i = 0; i < in32.length; i++) {
        let s = in32[i];
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-worklet-processor', PCMWorkletProcessor);
`;

const TTS_WORKLET_CODE = `
class TTSPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferQueue = [];
    this.readOffset = 0;
    this.samplesRemaining = 0;
    this.isPlaying = false;
    this.silenceSamples = 0;
    this.debounceSampleThreshold = 5760;

    this.port.onmessage = (event) => {
      if (event.data && typeof event.data === "object" && event.data.type === "clear") {
        this.bufferQueue = [];
        this.readOffset = 0;
        this.samplesRemaining = 0;
        this.silenceSamples = 0;
        if (this.isPlaying) {
          this.isPlaying = false;
          this.port.postMessage({ type: 'ttsPlaybackStopped' });
        }
        return;
      }
      this.bufferQueue.push(event.data);
      this.samplesRemaining += event.data.length;
      this.silenceSamples = 0;
    };
  }

  process(inputs, outputs) {
    const outputChannel = outputs[0][0];
    if (this.samplesRemaining === 0) {
      outputChannel.fill(0);
      if (this.isPlaying) {
        this.silenceSamples += outputChannel.length;
        if (this.silenceSamples >= this.debounceSampleThreshold) {
          this.isPlaying = false;
          this.silenceSamples = 0;
          this.port.postMessage({ type: 'ttsPlaybackStopped' });
        }
      }
      return true;
    }

    this.silenceSamples = 0;
    if (!this.isPlaying) {
      this.isPlaying = true;
      this.port.postMessage({ type: 'ttsPlaybackStarted' });
    }

    let outIdx = 0;
    while (outIdx < outputChannel.length && this.bufferQueue.length > 0) {
      const currentBuffer = this.bufferQueue[0];
      const sampleValue = currentBuffer[this.readOffset] / 32768;
      outputChannel[outIdx++] = sampleValue;
      this.readOffset++;
      this.samplesRemaining--;

      if (this.readOffset >= currentBuffer.length) {
        this.bufferQueue.shift();
        this.readOffset = 0;
      }
    }

    while (outIdx < outputChannel.length) {
      outputChannel[outIdx++] = 0;
    }
    return true;
  }
}
registerProcessor('tts-playback-processor', TTSPlaybackProcessor);
`;

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

    try {
      await this.audioContext.audioWorklet.addModule("/pcmWorkletProcessor.js");
    } catch {
      const blob = new Blob([PCM_WORKLET_CODE], { type: "application/javascript" });
      await this.audioContext.audioWorklet.addModule(URL.createObjectURL(blob));
    }
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

    try {
      await this.audioContext.audioWorklet.addModule("/ttsPlaybackProcessor.js");
    } catch {
      const blob = new Blob([TTS_WORKLET_CODE], { type: "application/javascript" });
      await this.audioContext.audioWorklet.addModule(URL.createObjectURL(blob));
    }
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
