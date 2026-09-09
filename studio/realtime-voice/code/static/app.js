/**
 * Teminali OS Voice Architecture (Port 8000)
 * Hybrid Codex + ChatGPT Voice Assistant Engine
 * With Top-Right Floating Assistant Activity & Context Window
 * 
 * Cleanly Decoupled Modular Layers:
 * 1. AudioEngine        - Pure Web Audio API & AudioWorklets (Zero DOM dependencies)
 * 2. ProtocolManager    - WebSocket protocol, message routing, sequence tracking (Zero DOM dependencies)
 * 3. TeminaliOrbRenderer- Liquid Iridescent 3D Fluid Voice Orb Canvas
 * 4. UIController       - Real-time speech typing, right-aligned blue pills, assistant activity window
 */

// ============================================================================
// MODULE 1: AudioEngine (Isolated Audio Subsystem)
// ============================================================================
class AudioEngine {
  constructor() {
    this.audioContext = null;
    this.mediaStream = null;
    this.micWorklet = null;
    this.ttsWorklet = null;
    this.micSource = null;
    this.userAnalyser = null;
    this.assistantAnalyser = null;
    this.isTTSPlaying = false;
    this.isThinking = false;
    this.isMuted = false;
    this.bargeInStreak = 0;
    this.BARGE_IN_RMS_THRESHOLD = 800; // ~ -32 dBFS (human near-field voice)
    this.BARGE_IN_STREAK_THRESHOLD = 8; // ~21ms sustained speech to prevent single-click false barge-ins

    this.onAudioChunkReady = null;
    this.onTTSPlaybackStarted = null;
    this.onTTSPlaybackStopped = null;
    this.onBargeIn = null;

    this.BATCH_SAMPLES = 2048;
    this.HEADER_BYTES  = 8;
    this.FRAME_BYTES   = this.BATCH_SAMPLES * 2;
    this.MESSAGE_BYTES = this.HEADER_BYTES + this.FRAME_BYTES;

    this.batchBuffer = null;
    this.batchView = null;
    this.batchInt16 = null;
    this.batchOffset = 0;
  }

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
    const ts = Date.now() & 0xFFFFFFFF;
    this.batchView.setUint32(0, ts, false);
    const flags = (this.isTTSPlaying || this.isThinking) ? 1 : 0;
    this.batchView.setUint32(4, flags, false);

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
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
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
        noiseSuppression: true
      }
    });

    this.userAnalyser = this.audioContext.createAnalyser();
    this.userAnalyser.fftSize = 128;
    this.userAnalyser.smoothingTimeConstant = 0.8;

    await this.audioContext.audioWorklet.addModule('/static/pcmWorkletProcessor.js');
    this.micWorklet = new AudioWorkletNode(this.audioContext, 'pcm-worklet-processor');

    this.micWorklet.port.onmessage = ({ data }) => {
      const incoming = new Int16Array(data);

      // Measure incoming signal RMS for voice barge-in
      let sumSquares = 0;
      for (let i = 0; i < incoming.length; i++) {
        sumSquares += incoming[i] * incoming[i];
      }
      const rms = Math.sqrt(sumSquares / incoming.length);

      // Strict Half-Duplex: When Bella is speaking, do not capture or transmit mic audio.
      // Laptop speakers and mic on the same chassis cause acoustic feedback and false barge-ins.
      if (this.isTTSPlaying) {
        return;
      }
      let read = 0;
      while (read < incoming.length) {
        this.initBatch();
        const toCopy = Math.min(incoming.length - read, this.BATCH_SAMPLES - this.batchOffset);
        this.batchInt16.set(incoming.subarray(read, read + toCopy), this.batchOffset);
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

    await this.audioContext.audioWorklet.addModule('/static/ttsPlaybackProcessor.js');
    this.ttsWorklet = new AudioWorkletNode(this.audioContext, 'tts-playback-processor');

    this.assistantAnalyser = this.audioContext.createAnalyser();
    this.assistantAnalyser.fftSize = 128;
    this.assistantAnalyser.smoothingTimeConstant = 0.85;

    this.ttsWorklet.port.onmessage = (event) => {
      const { type } = event.data;
      if (type === 'ttsPlaybackStarted') {
        this.isTTSPlaying = true;
        this.spokenSamples = 0;
        if (this.onTTSPlaybackStarted) this.onTTSPlaybackStarted();
      } else if (type === 'ttsPlaybackProgress') {
        this.spokenSamples = event.data.samplesPlayed;
      } else if (type === 'ttsPlaybackStopped') {
        this.isTTSPlaying = false;
        this.isThinking = false;
        if (this.onTTSPlaybackStopped) this.onTTSPlaybackStopped();
      }
    };

    this.ttsWorklet.connect(this.assistantAnalyser);
    this.ttsWorklet.connect(this.audioContext.destination);
  }

  /** Seconds of audio the speaker has actually produced for this turn. */
  getSpokenSeconds() {
    if (!this.audioContext) return 0;
    return (this.spokenSamples || 0) / this.audioContext.sampleRate;
  }

  playTTSChunk(int16Array) {
    if (this.ttsWorklet) {
      this.ttsWorklet.port.postMessage(int16Array);
    }
  }

  stopTTSPlayback() {
    this.isTTSPlaying = false;
    this.isThinking = false;
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
    return (sum / data.length) / 255;
  }

  getAssistantEnergy() {
    if (!this.assistantAnalyser || !this.isTTSPlaying) return 0;
    const data = new Uint8Array(this.assistantAnalyser.frequencyBinCount);
    this.assistantAnalyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return (sum / data.length) / 255;
  }

  cleanup() {
    this.flushRemainder();
    if (this.micSource) {
      try { this.micSource.disconnect(); } catch (e) {}
      this.micSource = null;
    }
    if (this.micWorklet) {
      try { this.micWorklet.disconnect(); } catch (e) {}
      this.micWorklet = null;
    }
    if (this.ttsWorklet) {
      try { this.ttsWorklet.disconnect(); } catch (e) {}
      this.ttsWorklet = null;
    }
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    this.isTTSPlaying = false;
  }
}

// ============================================================================
// MODULE 2: ProtocolManager (WebSocket & Engine Communication Contract)
// ============================================================================
class ProtocolManager {
  constructor() {
    this.socket = null;
    this.currentGenId = 0;
    this.ignoreTTS = false;

    this.onConnected = null;
    this.onDisconnected = null;
    this.onError = null;
    this.onMessage = null;
  }

  connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    this.stopReconnecting = false;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // "localhost" resolves to ::1 before 127.0.0.1 on macOS, and the server binds
    // IPv4 only. HTTP survives that because the browser retries the other address
    // family; a WebSocket does NOT retry, so ws://localhost:8000/ws failed instantly
    // with no trace on either side -- the mic captured happily and sendAudioChunk
    // dropped every buffer, because it is a no-op while the socket is not OPEN.
    // Binding the server to "::" is not the fix: on macOS that is IPv6-ONLY and
    // breaks 127.0.0.1 instead. Name the loopback address explicitly.
    const host = (window.location.hostname === 'localhost')
      ? `127.0.0.1:${window.location.port || 8000}`
      : window.location.host;
    this.socket = new WebSocket(`${proto}//${host}/ws`);

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      if (this.onConnected) this.onConnected();
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
      if (this.onDisconnected) this.onDisconnected();
      this.scheduleReconnect();
    };

    this.socket.onerror = (err) => {
      if (this.onError) this.onError(err);
    };
  }

  /**
   * Reconnect after a dropped or failed socket.
   *
   * Without this the page stays open looking perfectly alive -- the orb animates,
   * because it is driven by local microphone energy -- while sendAudioChunk
   * discards every buffer, since it is a no-op unless the socket is OPEN. The
   * failure is completely silent at both ends. A server restart, a sleep/wake, or
   * a handshake that never lands all end the same way, so recover from all three.
   */
  scheduleReconnect() {
    if (this.reconnectTimer || this.stopReconnecting) return;
    this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
    const delay = Math.min(1000 * this.reconnectAttempts, 5000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  sendAudioChunk(buffer) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(buffer);
    }
  }

  sendJSON(payload) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  sendUserText(text) {
    this.sendJSON({ type: "user_text", text });
  }

  sendTTSStart() {
    this.sendJSON({ type: "tts_start" });
  }

  sendTTSStop() {
    this.sendJSON({ type: "tts_stop" });
  }

  sendUserBargeIn() {
    this.sendJSON({ type: "user_barge_in" });
  }

  sendVoiceChange(voice) {
    this.sendJSON({ type: "set_voice", voice });
  }

  sendSpeedChange(speed) {
    this.sendJSON({ type: "set_speed", speed });
  }

  sendClearHistory() {
    this.sendJSON({ type: "clear_history" });
  }

  handleInboundMessage(msg) {
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
      this.ignoreTTS = (type === "stop_tts");
      if (this.onMessage) this.onMessage({ type: "tts_interrupt", gen_id });
      return;
    }

    if (type === "tts_chunk") {
      if (this.ignoreTTS) return;
      const raw = atob(msg.content);
      const buf = new ArrayBuffer(raw.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
      const int16 = new Int16Array(buf);
      if (this.onMessage) this.onMessage({ type: "tts_audio", int16, gen_id });
      return;
    }

    if (this.onMessage) {
      this.onMessage(msg);
    }
  }

  disconnect() {
    // Deliberate: suppress the reconnect that onclose would otherwise schedule.
    this.stopReconnecting = true;
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

// ============================================================================
// MODULE 3: TeminaliOrbRenderer (Liquid Iridescent 3D Fluid Voice Orb)
// ============================================================================
class TeminaliOrbRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.phase = 0;
    this.rippleIntensity = 0;
    this.animId = null;
    this.getAudioState = null;
  }

  start() {
    const loop = () => {
      this.render();
      this.animId = requestAnimationFrame(loop);
    };
    loop();
  }

  triggerInterruptionWave() {
    this.rippleIntensity = 1.0;
  }

  render() {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const cx = width / 2;
    const cy = height / 2;
    const baseRadius = 37 * (width / 152);

    ctx.clearRect(0, 0, width, height);

    const state = this.getAudioState ? this.getAudioState() : { userEnergy: 0, assistantEnergy: 0, isTTSPlaying: false, isConnected: true };
    const { userEnergy, assistantEnergy, isTTSPlaying } = state;

    this.phase += 0.035;
    if (this.rippleIntensity > 0) {
      this.rippleIntensity -= 0.045;
      if (this.rippleIntensity < 0) this.rippleIntensity = 0;
    }

    const totalEnergy = (userEnergy * 1.6) + (assistantEnergy * 1.9);
    const audioExpansion = Math.min(totalEnergy * 14, 13);
    const radius = baseRadius + audioExpansion + (this.rippleIntensity * 12);

    // 1. Ambient luminous diffused glow (Matching Screenshot 2)
    const glowRadius = radius * 1.65;
    const ambientGlow = ctx.createRadialGradient(cx, cy, radius * 0.4, cx, cy, glowRadius);
    if (this.rippleIntensity > 0) {
      ambientGlow.addColorStop(0, "rgba(244, 63, 94, 0.45)");
      ambientGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
    } else if (isTTSPlaying) {
      ambientGlow.addColorStop(0, "rgba(147, 197, 253, 0.55)");
      ambientGlow.addColorStop(0.65, "rgba(129, 140, 248, 0.28)");
      ambientGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
    } else if (userEnergy > 0.05) {
      ambientGlow.addColorStop(0, "rgba(56, 189, 248, 0.5)");
      ambientGlow.addColorStop(0.7, "rgba(99, 102, 241, 0.22)");
      ambientGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
    } else {
      ambientGlow.addColorStop(0, "rgba(186, 230, 253, 0.28)");
      ambientGlow.addColorStop(0.65, "rgba(96, 165, 250, 0.12)");
      ambientGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
    }

    ctx.beginPath();
    ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2);
    ctx.fillStyle = ambientGlow;
    ctx.fill();

    // 2. Liquid organic caustic contour
    ctx.save();
    ctx.beginPath();

    const points = 64;
    for (let i = 0; i <= points; i++) {
      const angle = (i / points) * Math.PI * 2;
      const wave = Math.sin(angle * 4 + this.phase * 1.8) * (1.1 + totalEnergy * 5.2)
                 + Math.cos(angle * 3 - this.phase * 1.3) * (0.8 + totalEnergy * 3.6);
      const r = radius + wave;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.clip();

    // 3. Pearlescent multi-stop liquid shader (Matching ChatGPT Voice Orb)
    const highlightX = cx - (radius * 0.26) + Math.cos(this.phase) * 3.2;
    const highlightY = cy - (radius * 0.3) + Math.sin(this.phase) * 3.2;

    const orbGrad = ctx.createRadialGradient(
      highlightX, highlightY, 2,
      cx, cy, radius * 1.25
    );

    if (this.rippleIntensity > 0) {
      orbGrad.addColorStop(0, "#ffffff");
      orbGrad.addColorStop(0.3, "#fda4af");
      orbGrad.addColorStop(0.7, "#f43f5e");
      orbGrad.addColorStop(1, "#881337");
    } else if (isTTSPlaying) {
      orbGrad.addColorStop(0, "#ffffff");
      orbGrad.addColorStop(0.25, "#e0f2fe");
      orbGrad.addColorStop(0.55, "#93c5fd");
      orbGrad.addColorStop(0.82, "#3b82f6");
      orbGrad.addColorStop(1, "#1e3a8a");
    } else if (userEnergy > 0.05) {
      orbGrad.addColorStop(0, "#ffffff");
      orbGrad.addColorStop(0.28, "#e0f2fe");
      orbGrad.addColorStop(0.6, "#38bdf8");
      orbGrad.addColorStop(0.88, "#0284c7");
      orbGrad.addColorStop(1, "#0c4a6e");
    } else {
      // Idle: Luminous milky crystal pearl
      orbGrad.addColorStop(0, "#ffffff");
      orbGrad.addColorStop(0.28, "#f0f9ff");
      orbGrad.addColorStop(0.55, "#bae6fd");
      orbGrad.addColorStop(0.82, "#60a5fa");
      orbGrad.addColorStop(1, "#2563eb");
    }

    ctx.fillStyle = orbGrad;
    ctx.fillRect(0, 0, width, height);

    // 4. Specular caustic highlight reflection (Crystal Glass Sheen)
    ctx.beginPath();
    ctx.ellipse(
      highlightX + 4,
      highlightY + 4,
      radius * 0.38,
      radius * 0.22,
      Math.PI / 4,
      0,
      Math.PI * 2
    );
    ctx.fillStyle = "rgba(255, 255, 255, 0.62)";
    ctx.fill();

    ctx.restore();
  }
}

// ============================================================================
// MODULE 4: UIController (Real-Time Voice Chat & Floating Assistant Activity Pane)
// ============================================================================
class UIController {
  constructor() {
    this.audio = new AudioEngine();
    this.protocol = new ProtocolManager();
    this.orbRenderer = null;

    this.messagesContainer = document.getElementById("messages");
    this.viewport = document.getElementById("viewport");
    this.textInput = document.getElementById("textInput");
    this.micToggleBtn = document.getElementById("micToggleBtn");
    this.closeSessionBtn = document.getElementById("closeSessionBtn");
    this.sidebar = document.getElementById("codexSidebar");
    this.sidebarCollapseBtn = document.getElementById("sidebarCollapseBtn");
    this.headerSidebarToggle = document.getElementById("headerSidebarToggle");
    this.workspace = document.getElementById("workspace");
    this.modeChatBtn = document.getElementById("modeChatBtn");
    this.modeWorkBtn = document.getElementById("modeWorkBtn");
    this.chatView = document.getElementById("chatView");
    this.workView = document.getElementById("workView");
    this.workInputText = document.getElementById("workInputText");
    this.workSubmitBtn = document.getElementById("workSubmitBtn");
    this.workMicBtn = document.getElementById("workMicBtn");
    this.btnNewChat = document.getElementById("btnNewChat");
    this.recentsList = document.getElementById("recentsList");

    this.assistantPane = document.getElementById("assistantPane");
    this.drawerToggleBtn = document.getElementById("drawerToggleBtn");
    this.closePaneBtn = document.getElementById("closePaneBtn");
    this.clearActivityBtn = document.getElementById("clearActivityBtn");
    this.activityFeed = document.getElementById("activityFeed");
    this.actionCount = document.getElementById("actionCount");
    this.activityBadge = document.getElementById("activityBadge");

    this.voiceSelect = document.getElementById("voiceSelect");
    this.orbContainer = document.getElementById("teminaliOrbContainer");
    this.toast = document.getElementById("toast");

    this.isSessionActive = false;
    this.activeUserPill = null;
    this.lastUserPill = null;
    this.streamingAssistantEl = null;
    this.hasCompletedTurn = false;
    this.revealEl = null;
    this.revealHostEl = null;
    this.revealNodes = [];
    this.revealCursor = null;
    this.lastRevealCount = -1;
    this.lastRevealAt = 0;
    this.toastTimer = null;
    this.actionCounter = 3;

    this.chatSessions = [];
    this.activeSessionId = null;
  }

  init() {
    const canvas = document.getElementById("teminaliOrb");
    if (canvas) {
      this.orbRenderer = new TeminaliOrbRenderer(canvas);
      this.orbRenderer.getAudioState = () => ({
        userEnergy: this.audio.getUserEnergy(),
        assistantEnergy: this.audio.getAssistantEnergy(),
        isTTSPlaying: this.audio.isTTSPlaying,
        isConnected: this.isSessionActive
      });
      this.orbRenderer.start();
    }

    this.initChatSessions();

    this.audio.onAudioChunkReady = (buf) => this.protocol.sendAudioChunk(buf);
    this.audio.onTTSPlaybackStarted = () => {
      this.protocol.sendTTSStart();
    };
    this.audio.onTTSPlaybackStopped = () => {
      this.protocol.sendTTSStop();
      // She has stopped speaking, so the transcript is allowed to be complete.
      this.completeAssistantText();
    };
    this.audio.onBargeIn = () => {
      console.log("⚡ Voice barge-in triggered from audio engine");
      this.protocol.sendUserBargeIn();
      if (this.orbRenderer) this.orbRenderer.triggerInterruptionWave();
      this.showToast("Interrupted");
      const el = this.revealEl || this.streamingAssistantEl;
      this.finishSpeechSync("");
      if (el) {
        const text = el.textContent.trim();
        if (text && !text.endsWith("…") && !text.endsWith("...")) {
          el.textContent = text + "…";
        }
      }
      this.streamingAssistantEl = null;
    };

    this.protocol.onConnected = () => {
      this.isSessionActive = true;
      // Synchronize active session history to server on connect/refresh (preserving chats)
      const session = this.getActiveSession();
      if (session && Array.isArray(session.messages) && session.messages.length > 0) {
        const history = session.messages.map(m => ({ role: m.role, content: m.content }));
        this.protocol.sendJSON({ type: "set_history", history: history });
      } else {
        this.protocol.sendClearHistory();
      }
    };
    this.protocol.onDisconnected = () => {
      this.isSessionActive = false;
      if (this.micToggleBtn) this.micToggleBtn.classList.add("muted");
    };
    this.protocol.onMessage = (msg) => this.handleServerMessage(msg);

    this.attachEvents();
    this.protocol.connect();
    this.fetchVoiceProfiles();
  }

  // ----------------------------------------------------
  // Multi-Chat Session Management (LocalStorage)
  // ----------------------------------------------------
  initChatSessions() {
    const SESSIONS_KEY = "teminali_chat_sessions_v2";
    const ACTIVE_KEY = "teminali_active_chat_id_v2";

    const defaultThreads = [
      { id: "chat_greeting", title: "Greeting exchange", createdAt: Date.now() - 3600000, messages: [] },
      { id: "chat_casual", title: "Casual Conversation Reply", createdAt: Date.now() - 7200000, messages: [] },
      { id: "chat_bench", title: "Benchmark small LLMs", createdAt: Date.now() - 10800000, messages: [] },
      { id: "chat_boresha", title: "Boresha Majina Ya Video", createdAt: Date.now() - 14400000, messages: [] },
      { id: "chat_continue", title: "Continue task", createdAt: Date.now() - 18000000, messages: [] },
      { id: "chat_resume", title: "Resume frontierCode tasks", createdAt: Date.now() - 21600000, messages: [] },
      { id: "chat_rabbits", title: "Raising rabbits for meat", createdAt: Date.now() - 25200000, messages: [] },
      { id: "chat_sonnet", title: "Benchmark Qwen Against Sonnet", createdAt: Date.now() - 28800000, messages: [] }
    ];

    try {
      const stored = localStorage.getItem(SESSIONS_KEY);
      if (stored) {
        this.chatSessions = JSON.parse(stored);
      }
    } catch (e) {
      console.warn("Error reading chat sessions from localStorage:", e);
    }

    if (!Array.isArray(this.chatSessions) || this.chatSessions.length === 0) {
      this.chatSessions = defaultThreads;
      this.saveChatSessions();
    }

    let activeId = localStorage.getItem(ACTIVE_KEY);
    if (!activeId || !this.chatSessions.some(s => s.id === activeId)) {
      activeId = this.chatSessions[0].id;
      localStorage.setItem(ACTIVE_KEY, activeId);
    }
    this.activeSessionId = activeId;

    this.renderRecentsSidebar();
    this.renderActiveSessionMessages();
  }

  saveChatSessions() {
    try {
      localStorage.setItem("teminali_chat_sessions_v2", JSON.stringify(this.chatSessions));
      localStorage.setItem("teminali_active_chat_id_v2", this.activeSessionId);
    } catch (e) {
      console.warn("Failed to persist chat sessions to localStorage:", e);
    }
  }

  getActiveSession() {
    let session = this.chatSessions.find(s => s.id === this.activeSessionId);
    if (!session && this.chatSessions.length > 0) {
      session = this.chatSessions[0];
      this.activeSessionId = session.id;
    }
    return session;
  }

  renderRecentsSidebar() {
    if (!this.recentsList) return;
    this.recentsList.innerHTML = "";

    this.chatSessions.forEach(session => {
      const item = document.createElement("div");
      item.className = `recent-chat-item ${session.id === this.activeSessionId ? "active" : ""}`;
      item.textContent = session.title || "Untitled Conversation";
      item.title = session.title || "";
      item.addEventListener("click", () => {
        this.switchSession(session.id);
      });
      this.recentsList.appendChild(item);
    });
  }

  switchSession(sessionId) {
    if (this.activeSessionId === sessionId) return;
    this.activeSessionId = sessionId;
    this.saveChatSessions();
    this.renderRecentsSidebar();
    this.renderActiveSessionMessages();

    // Sync active thread's history to server
    const active = this.getActiveSession();
    const history = (active && active.messages) ? active.messages.map(m => ({ role: m.role, content: m.content })) : [];
    this.protocol.sendJSON({ type: "set_history", history: history });
    this.showToast(`Loaded: ${active ? active.title : 'Chat'}`);
  }

  createNewChat() {
    const newId = "chat_" + Date.now();
    const newSession = {
      id: newId,
      title: "New chat",
      createdAt: Date.now(),
      messages: []
    };
    this.chatSessions.unshift(newSession);
    this.activeSessionId = newId;
    this.saveChatSessions();

    this.renderRecentsSidebar();
    this.renderActiveSessionMessages();

    // Reset server pipeline state for fresh chat
    this.protocol.sendClearHistory();
    this.showToast("New chat started");
  }

  renderActiveSessionMessages() {
    if (!this.messagesContainer) return;
    const amberRow = this.messagesContainer.querySelector(".voice-session-indicator-row");
    this.messagesContainer.innerHTML = "";
    if (amberRow) {
      this.messagesContainer.appendChild(amberRow);
    } else {
      const row = document.createElement("div");
      row.className = "voice-session-indicator-row";
      row.innerHTML = '<span class="session-amber-dot" title="Active voice session"></span>';
      this.messagesContainer.appendChild(row);
    }

    // The reveal loop would otherwise keep writing into a node that has just been
    // detached by the innerHTML wipe above.
    this.finishSpeechSync("");
    this.invalidateReveal();
    this.pendingFinalText = null;
    this.streamingAssistantEl = null;
    this.activeUserPill = null;
    this.lastUserPill = null;

    const session = this.getActiveSession();
    if (!session || !Array.isArray(session.messages)) return;

    session.messages.forEach(msg => {
      if (msg.role === "user") {
        const block = document.createElement("div");
        block.className = "user-turn-block";
        const pill = document.createElement("div");
        pill.className = "chatgpt-user-pill";
        pill.textContent = msg.content;
        block.appendChild(pill);
        this.messagesContainer.appendChild(block);
      } else if (msg.role === "assistant") {
        const block = document.createElement("div");
        block.className = "assistant-turn-block";
        const textEl = document.createElement("div");
        textEl.className = "assistant-text";
        textEl.textContent = msg.content;
        block.appendChild(textEl);

        const actionsBar = document.createElement("div");
        actionsBar.className = "assistant-actions";
        actionsBar.innerHTML = `
          <button class="action-icon-btn copy-btn" title="Copy text">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
          <button class="action-icon-btn thumb-up-btn" title="Good response">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
            </svg>
          </button>
          <button class="action-icon-btn thumb-down-btn" title="Bad response">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path>
            </svg>
          </button>
          <button class="action-icon-btn share-btn" title="Share">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="18" cy="5" r="3"></circle>
              <circle cx="6" cy="12" r="3"></circle>
              <circle cx="18" cy="19" r="3"></circle>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
            </svg>
          </button>
          <button class="action-icon-btn reload-btn" title="Regenerate">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
          </button>
          <button class="action-icon-btn more-btn" title="More options">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="1"></circle>
              <circle cx="19" cy="12" r="1"></circle>
              <circle cx="5" cy="12" r="1"></circle>
            </svg>
          </button>
        `;
        block.appendChild(actionsBar);
        this.messagesContainer.appendChild(block);
      }
    });

    this.bindAssistantActionButtons(this.messagesContainer);
    this.scrollToBottom();
  }

  appendMessageToActiveSession(role, content) {
    const session = this.getActiveSession();
    if (!session) return;
    if (!Array.isArray(session.messages)) session.messages = [];

    const lastMsg = session.messages[session.messages.length - 1];
    if (lastMsg && lastMsg.role === role) {
      lastMsg.content = content;
      lastMsg.timestamp = Date.now();
      this.saveChatSessions();
      return;
    }

    session.messages.push({
      role: role,
      content: content,
      timestamp: Date.now()
    });

    // Auto-update thread title on first user turn if default title
    if (role === "user" && (!session.title || session.title === "New chat" || session.title === "Greeting exchange")) {
      const cleanTitle = content.replace(/[^\w\s]/gi, '').trim();
      if (cleanTitle.length > 0) {
        session.title = cleanTitle.length > 28 ? cleanTitle.substring(0, 28) + "..." : cleanTitle;
        this.renderRecentsSidebar();
      }
    }

    this.saveChatSessions();
  }

  /**
   * Show that a reply is coming, and say so honestly when it will be slow.
   *
   * The first turn after a cold start pays for the Ollama model load and the TTS
   * warm-up, which together ran to several seconds. With no indicator that reads
   * as "nothing is happening" -- the operator repeats themselves, which barges in
   * and cancels the generation they were waiting for, so it never arrives at all.
   * The message escalates rather than lying: a plain wait first, then the real
   * reason once it is clearly a cold model.
   */
  /**
   * Reveal the transcript in step with the voice.
   *
   * Driven by the playback worklet's real sample position, not a timer, so it stays
   * aligned when synthesis stalls or the operator barges in. The words-per-second
   * figure self-calibrates: at the end of each turn the true rate (words actually
   * spoken over seconds actually played) folds into a rolling average, so it adapts
   * to the voice profile and speed setting rather than assuming one.
   */
  startSpeechSync(targetEl) {
    // The loop owns its own reference to the message it is revealing. It must not
    // read `streamingAssistantEl`: that is nulled the moment the final answer
    // arrives, so the next partial opens a fresh block. Reading it here killed the
    // reveal mid-sentence and left a caret blinking on the finished message.
    if (targetEl) this.revealEl = targetEl;
    if (!this.revealEl) return;
    if (this.speechSyncFrame) return;

    const tick = () => {
      this.speechSyncFrame = null;
      const el = this.revealEl;
      const full = this.assistantFullText || "";
      if (!el || !full) return;

      // One node per word, each carrying the whitespace in front of it, so a newly
      // spoken word can be appended without touching the words already on screen.
      // Rebuilding innerHTML every frame restarted every word's fade-in animation,
      // which held the whole transcript at opacity 0 for as long as she spoke.
      const tokens = [];
      const re = /(\s*)(\S+)/g;
      let m;
      while ((m = re.exec(full)) !== null) tokens.push(m[1] + m[2]);
      const wordCount = tokens.length;

      const spoken = this.audio.getSpokenSeconds();
      const wps = this.wordsPerSecond || 3.0;
      let reveal;
      if (!this.audio.isTTSPlaying && spoken === 0) {
        reveal = 0;                                // nothing spoken yet: show nothing
      } else {
        reveal = Math.min(wordCount, Math.floor(spoken * wps) + 1);
      }

      // Playback can end with words still held back. Without this the loop would
      // spin at 60fps forever, waiting on a sample position that has stopped moving.
      // Gated on `spoken > 0`: before she has said anything the reveal is meant to
      // sit at zero, and syncFallbackTimer owns the case where TTS never starts.
      if (reveal !== this.lastRevealCount) {
        this.lastRevealCount = reveal;
        this.lastRevealAt = performance.now();
      } else if (spoken > 0 && !this.audio.isTTSPlaying && reveal < wordCount
                 && performance.now() - (this.lastRevealAt || 0) > 900) {
        reveal = wordCount;
      }

      if (this.revealHostEl !== el) this.resetReveal(el);
      const nodes = this.revealNodes;

      // A partial answer can cut a word in half ("hel", then "hello"), so the last
      // node already on screen is re-checked before anything is appended after it.
      if (nodes.length > 0 && nodes.length <= wordCount) {
        const last = nodes.length - 1;
        if (nodes[last].textContent !== tokens[last]) nodes[last].textContent = tokens[last];
      }
      for (let i = nodes.length; i < reveal; i++) {
        const span = document.createElement("span");
        span.className = "spoken-word";
        span.textContent = tokens[i];
        el.insertBefore(span, this.revealCursor);
        nodes.push(span);
      }
      this.scrollToBottom();

      if (this.audio.isTTSPlaying || reveal < wordCount) {
        this.speechSyncFrame = requestAnimationFrame(tick);
      }
    };
    this.speechSyncFrame = requestAnimationFrame(tick);
  }

  /** Begin a fresh reveal on `el`: empty it, and give it the one caret it may own. */
  resetReveal(el) {
    el.textContent = "";
    this.revealNodes = [];
    this.revealCursor = document.createElement("span");
    this.revealCursor.className = "assistant-streaming-cursor";
    el.appendChild(this.revealCursor);
    this.revealHostEl = el;
    this.lastRevealCount = -1;
  }

  /**
   * A caret must never outlive the turn that owns it -- an abandoned one is the
   * "typing indicator on an old message". Sweeps `el`, or every finished assistant
   * block when called with no argument. The thinking placeholder keeps its own.
   */
  clearStreamingCursor(el) {
    if (el) {
      el.querySelectorAll(".assistant-streaming-cursor").forEach(n => n.remove());
      if (this.revealCursor && !this.revealCursor.isConnected) this.revealCursor = null;
      return;
    }
    if (!this.messagesContainer) return;
    this.messagesContainer
      .querySelectorAll(".assistant-turn-block:not(.thinking-block) .assistant-streaming-cursor")
      .forEach(n => { if (n !== this.revealCursor) n.remove(); });
  }

  /** Finish the reveal immediately and learn this turn's real speaking rate. */
  finishSpeechSync(finalText) {
    if (this.speechSyncFrame) {
      cancelAnimationFrame(this.speechSyncFrame);
      this.speechSyncFrame = null;
    }
    if (this.revealEl) this.clearStreamingCursor(this.revealEl);
    const spoken = this.audio.getSpokenSeconds();
    const wordCount = (finalText || "").trim().split(/\s+/).filter(Boolean).length;
    if (spoken > 0.5 && wordCount > 2) {
      const measured = wordCount / spoken;
      // Clamped: a barge-in truncates the audio and would otherwise poison the average.
      if (measured > 1.2 && measured < 7) {
        this.wordsPerSecond = this.wordsPerSecond
          ? this.wordsPerSecond * 0.7 + measured * 0.3
          : measured;
      }
    }
    this.assistantFullText = "";
    this.revealEl = null;
    this.lastRevealCount = -1;
    // revealHostEl/revealNodes deliberately survive: playback can stop for a beat
    // mid-answer, and the same message then carries on being revealed rather than
    // restarting from nothing. invalidateReveal() clears them when the DOM goes.
  }

  /** The revealed nodes are gone from the DOM; stop counting on them. */
  invalidateReveal() {
    this.revealHostEl = null;
    this.revealNodes = [];
    this.revealCursor = null;
    this.lastRevealCount = -1;
  }

  /** Snap the transcript to the full text and close out the turn. */
  completeAssistantText() {
    clearTimeout(this.syncFallbackTimer);
    const text = this.pendingFinalText;
    const el = this.revealEl;
    if (!text && !el) return;
    if (el) {
      // Whatever else happens, the caret goes. If playback ended before the final
      // answer landed there is no text to snap to, but a half-revealed message must
      // still stop advertising itself as being typed.
      if (text) { el.textContent = text; this.invalidateReveal(); }
      else this.clearStreamingCursor(el);
    }
    this.finishSpeechSync(text || "");
    this.pendingFinalText = null;
  }

  showThinking() {
    if (this.audio) this.audio.isThinking = true;
    if (!this.messagesContainer) return;
    this.hideThinking();
    const el = document.createElement("div");
    el.className = "assistant-turn-block thinking-block";
    el.innerHTML = '<div class="assistant-text thinking-text">'
      + '<span class="assistant-streaming-cursor"></span>'
      + '<span class="thinking-label">Thinking\u2026</span></div>';
    this.messagesContainer.appendChild(el);
    this.thinkingEl = el;
    this.scrollToBottom();

    const label = el.querySelector(".thinking-label");
    // Only the first turn of a session pays for the model load. Once a reply has
    // come back the weights are resident, so blaming a slow turn on loading is
    // simply untrue -- it reads as a stuck app and invites the operator to repeat
    // themselves, which barges in and cancels the generation they were waiting for.
    const cold = !this.hasCompletedTurn;
    this.thinkingTimers = [
      setTimeout(() => {
        if (label) label.textContent = cold ? "Waking the model\u2026" : "Thinking\u2026";
      }, 2500),
      setTimeout(() => {
        if (!label) return;
        label.textContent = cold
          ? "Still loading the model \u2014 first reply is the slow one"
          : "Still working on it\u2026";
      }, 6000),
    ];
  }

  hideThinking() {
    if (this.audio) this.audio.isThinking = false;
    (this.thinkingTimers || []).forEach(clearTimeout);
    this.thinkingTimers = [];
    if (this.thinkingEl) {
      this.thinkingEl.remove();
      this.thinkingEl = null;
    }
  }

  showToast(text) {
    if (!this.toast) return;
    this.toast.textContent = text;
    this.toast.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.classList.remove("show");
    }, 2000);
  }

  // ----------------------------------------------------
  // Dynamic Assistant Activity Feed Logging
  // ----------------------------------------------------
  addAssistantActivity(action) {
    if (!this.activityFeed) return;
    this.actionCounter++;
    if (this.actionCount) this.actionCount.textContent = this.actionCounter;

    const card = document.createElement("div");
    card.className = `activity-card ${action.type || 'cmd'}-card`;

    if (action.type === 'edit') {
      card.innerHTML = `
        <div class="activity-card-header">
          <span class="activity-type-tag edit-tag">CODE WRITE</span>
          <span class="activity-time">Just now</span>
        </div>
        <div class="file-action-row">
          <span class="file-action-badge ${action.badge || 'modify'}">${(action.badge || 'MODIFY').toUpperCase()}</span>
          <span class="file-path">${escapeHtml(action.file || 'studio/file.ts')}</span>
        </div>
        <div class="diff-summary-row">
          <span class="diff-plus">${escapeHtml(action.plus || '+12')}</span>
          <span class="diff-minus">${escapeHtml(action.minus || '-2 lines')}</span>
          <span class="diff-desc">${escapeHtml(action.desc || 'Code updated')}</span>
        </div>
      `;
    } else if (action.type === 'read') {
      card.innerHTML = `
        <div class="activity-card-header">
          <span class="activity-type-tag read-tag">ANALYSIS</span>
          <span class="activity-time">Just now</span>
        </div>
        <div class="file-action-row">
          <span class="file-action-badge read">READ</span>
          <span class="file-path">${escapeHtml(action.file || 'studio/file.ts')}</span>
        </div>
        <div class="analysis-status-row">
          <div class="mini-spinner"></div>
          <span>${escapeHtml(action.desc || 'Analyzed file contents')}</span>
        </div>
      `;
    } else {
      // Default: Command Run
      card.innerHTML = `
        <div class="activity-card-header">
          <span class="activity-type-tag cmd-tag">COMMAND</span>
          <span class="activity-time">Just now</span>
        </div>
        <div class="cmd-terminal-box">
          <span class="cmd-prompt">$</span>
          <span class="cmd-text">${escapeHtml(action.cmd || 'frontier-run 1L')}</span>
        </div>
        <div class="activity-status-row success">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>${escapeHtml(action.result || 'Exit code 0 · 1.4s')}</span>
        </div>
      `;
    }

    this.activityFeed.insertBefore(card, this.activityFeed.firstChild);

    // Flash header activity dot to notify user
    if (this.headerActivityDot) {
      this.headerActivityDot.style.animation = "duplexPulse 1s infinite ease-in-out";
      setTimeout(() => {
        if (this.headerActivityDot) this.headerActivityDot.style.animation = "";
      }, 3000);
    }
  }

  attachEvents() {
    // 1. Real-Time Typed Message on Enter
    if (this.textInput) {
      this.textInput.addEventListener("keydown", async (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const text = this.textInput.value.trim();
          if (!text) return;
          this.textInput.value = "";

          if (!this.audio.audioContext) {
            await this.audio.start();
          }

          this.addUserPill(text);
          this.appendMessageToActiveSession("user", text);
          this.protocol.sendUserText(text);
          // Typed turns never produce final_user_request, so arm the indicator here.
          this.showThinking();

          // Log action in Assistant Activity Window
          this.addAssistantActivity({
            type: 'read',
            file: 'studio/src/services/diligenceEngine.ts',
            desc: `Processing prompt: "${text.substring(0, 32)}..."`
          });
        }
      });
    }

    // 2. Orb Click: Toggle Audio Session or Barge-In
    if (this.orbContainer) {
      this.orbContainer.addEventListener("click", async () => {
        if (!this.audio.audioContext) {
          await this.audio.start();
          if (this.micToggleBtn) this.micToggleBtn.classList.remove("muted");
          this.showToast("Teminali Voice listening");
        } else if (this.audio.isTTSPlaying) {
          this.audio.stopTTSPlayback();
          this.protocol.sendUserBargeIn();
          if (this.orbRenderer) this.orbRenderer.triggerInterruptionWave();
          this.showToast("Interrupted");
        }
      });
    }

    // 3. Mic Mute / Active Button (Red when active)
    if (this.micToggleBtn) {
      this.micToggleBtn.addEventListener("click", async () => {
        if (!this.audio.audioContext) {
          await this.audio.start();
          this.micToggleBtn.classList.remove("muted");
          this.showToast("Microphone active");
          return;
        }
        if (this.audio.isTTSPlaying) {
          // If Bella is currently speaking, clicking the mic immediately interrupts her and keeps mic listening
          this.audio.stopTTSPlayback();
          this.protocol.sendUserBargeIn();
          if (this.orbRenderer) this.orbRenderer.triggerInterruptionWave();
          this.showToast("Interrupted — listening");
          return;
        }
        const isMuted = this.audio.toggleMute();
        if (isMuted) {
          this.micToggleBtn.classList.add("muted");
          this.showToast("Microphone muted");
        } else {
          this.micToggleBtn.classList.remove("muted");
          this.showToast("Microphone active");
        }
      });
    }

    // 4. Close Session Button (White Circle X)
    if (this.closeSessionBtn) {
      this.closeSessionBtn.addEventListener("click", () => {
        if (this.audio.isTTSPlaying) {
          // If Bella is speaking, X acts as an immediate STOP button!
          this.audio.stopTTSPlayback();
          this.protocol.sendUserBargeIn();
          if (this.orbRenderer) this.orbRenderer.triggerInterruptionWave();
          this.showToast("Interrupted");
          return;
        }
        this.audio.cleanup();
        this.protocol.disconnect();
        this.isSessionActive = false;
        if (this.micToggleBtn) this.micToggleBtn.classList.add("muted");
        this.showToast("Teminali OS session ended");
      });
    }

    // 5. Sidebar Toggle (Collapsible Codex Sidebar)
    const toggleSidebar = () => {
      if (this.sidebar) {
        this.sidebar.classList.toggle("collapsed");
      }
    };
    if (this.sidebarCollapseBtn) this.sidebarCollapseBtn.addEventListener("click", toggleSidebar);
    if (this.headerSidebarToggle) this.headerSidebarToggle.addEventListener("click", toggleSidebar);

    // 6. Assistant Activity Pane Toggle with viewport padding synchronization
    const toggleAssistantPane = (e) => {
      e.stopPropagation();
      if (this.assistantPane) {
        this.assistantPane.classList.toggle("hidden");
        if (this.viewport) {
          this.viewport.classList.toggle("pane-closed", this.assistantPane.classList.contains("hidden"));
        }
      }
    };
    if (this.drawerToggleBtn) this.drawerToggleBtn.addEventListener("click", toggleAssistantPane);

    if (this.closePaneBtn) {
      this.closePaneBtn.addEventListener("click", () => {
        if (this.assistantPane) {
          this.assistantPane.classList.add("hidden");
          if (this.viewport) this.viewport.classList.add("pane-closed");
        }
      });
    }

    if (this.clearActivityBtn) {
      this.clearActivityBtn.addEventListener("click", () => {
        if (this.activityFeed) this.activityFeed.innerHTML = "";
        this.actionCounter = 0;
        if (this.actionCount) this.actionCount.textContent = "0";
        this.showToast("Activity feed cleared");
      });
    }

    // Tab buttons inside the Assistant Activity Pane
    document.querySelectorAll(".pane-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        this.activatePaneTab(tab);
      });
    });

    document.addEventListener("click", (e) => {
      if (this.assistantPane && !this.assistantPane.contains(e.target) &&
          e.target !== this.drawerToggleBtn && !this.drawerToggleBtn?.contains(e.target)) {
        this.assistantPane.classList.add("hidden");
        if (this.viewport) this.viewport.classList.add("pane-closed");
      }
    });

    // 7. Voice Selector
    if (this.voiceSelect) {
      this.voiceSelect.addEventListener("change", (e) => {
        const voice = e.target.value;
        const name = e.target.options[e.target.selectedIndex].text.split('(')[0].trim();
        this.protocol.sendVoiceChange(voice);
        this.showToast(`Voice persona: ${name}`);
      });
    }

    // 8. New Chat Action
    if (this.btnNewChat) {
      this.btnNewChat.addEventListener("click", () => {
        this.createNewChat();
        if (this.assistantPane) {
          this.assistantPane.classList.add("hidden");
          if (this.viewport) this.viewport.classList.add("pane-closed");
        }
      });
    }

    // Header Share and Options buttons (Matching ChatGPT Voice header)
    const headerShareBtn = document.getElementById("headerShareBtn");
    if (headerShareBtn) {
      headerShareBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(window.location.href).then(() => {
          this.showToast("Conversation link copied");
        }).catch(() => {
          this.showToast("Link: " + window.location.href);
        });
      });
    }

    const headerMoreBtn = document.getElementById("headerMoreBtn");
    if (headerMoreBtn) {
      headerMoreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.assistantPane) {
          this.assistantPane.classList.toggle("hidden");
          if (this.viewport) {
            this.viewport.classList.toggle("pane-closed", this.assistantPane.classList.contains("hidden"));
          }
        }
      });
    }

    // Global shortcut: Escape or Space (when not typing) interrupts playback
    window.addEventListener("keydown", (e) => {
      if ((e.key === "Escape" || (e.code === "Space" && document.activeElement !== this.textInput)) && this.audio.isTTSPlaying) {
        if (e.code === "Space") e.preventDefault();
        this.audio.stopTTSPlayback();
        this.protocol.sendUserBargeIn();
        if (this.orbRenderer) this.orbRenderer.triggerInterruptionWave();
        this.showToast("Playback stopped");
      }
    });

    // Wire action buttons in the pre-populated DOM
    this.bindAssistantActionButtons(document);
  }

  bindAssistantActionButtons(container) {
    container.querySelectorAll(".action-icon-btn.copy-btn").forEach(btn => {
      btn.onclick = () => {
        const block = btn.closest(".assistant-turn-block");
        if (block) {
          const textEl = block.querySelector(".assistant-text");
          if (textEl) {
            navigator.clipboard.writeText(textEl.innerText).then(() => this.showToast("Copied to clipboard"));
          }
        }
      };
    });

    container.querySelectorAll(".action-icon-btn.thumb-up-btn").forEach(btn => {
      btn.onclick = () => this.showToast("Thanks for the feedback");
    });

    container.querySelectorAll(".action-icon-btn.thumb-down-btn").forEach(btn => {
      btn.onclick = () => this.showToast("Feedback recorded");
    });

    container.querySelectorAll(".action-icon-btn.share-btn").forEach(btn => {
      btn.onclick = () => this.showToast("Conversation link copied");
    });

    container.querySelectorAll(".action-icon-btn.reload-btn").forEach(btn => {
      btn.onclick = () => {
        this.showToast("Regenerating response...");
        const block = btn.closest(".assistant-turn-block");
        if (block) {
          const prevUserTurn = block.previousElementSibling;
          if (prevUserTurn) {
            const pill = prevUserTurn.querySelector(".chatgpt-user-pill");
            if (pill) this.protocol.sendUserText(pill.textContent);
          }
        }
      };
    });
  }

  activatePaneTab(tabName) {
    document.querySelectorAll(".pane-tab-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === tabName);
    });
    document.querySelectorAll(".pane-tab-content").forEach(c => {
      c.classList.remove("active");
    });
    const target = document.getElementById(`tabContent${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
    if (target) target.classList.add("active");
  }

  async fetchVoiceProfiles() {
    try {
      const res = await fetch("/api/voices");
      if (res.ok) {
        const data = await res.json();
        if (data.current && this.voiceSelect) {
          this.voiceSelect.value = data.current;
        }
      }
    } catch (e) {
      console.warn("Could not fetch voices:", e);
    }
  }

  // ----------------------------------------------------
  // REAL-TIME SPEECH DICTATION (ChatGPT Blue Pill on Right)
  // ----------------------------------------------------
  handlePartialUserSpeech(text) {
    const clean = (text || "").trim();
    if (!clean || !this.messagesContainer) return;

    if (!this.activeUserPill) {
      this.lastUserPill = null; // New user turn starting
      const block = document.createElement("div");
      block.className = "user-turn-block live-turn";

      this.activeUserPill = document.createElement("div");
      this.activeUserPill.className = "chatgpt-user-pill live";

      block.appendChild(this.activeUserPill);
      this.messagesContainer.appendChild(block);
    }

    // Live real-time speech typing with animated cursor
    this.activeUserPill.innerHTML = `${escapeHtml(clean)}<span class="user-live-cursor"></span>`;
    this.scrollToBottom();
  }

  handleFinalUserSpeech(text) {
    const clean = (text || "").trim();
    if (!clean) return;

    if (this.activeUserPill) {
      this.activeUserPill.textContent = clean;
      this.activeUserPill.classList.remove("live");
      const parent = this.activeUserPill.closest(".user-turn-block");
      if (parent) parent.classList.remove("live-turn");
      this.lastUserPill = this.activeUserPill;
      this.activeUserPill = null;
    } else if (this.lastUserPill) {
      // Authoritative transcription arrived for the same turn: update bubble content
      this.lastUserPill.textContent = clean;
    } else {
      if (this.streamingAssistantEl) {
        const asstBlock = this.streamingAssistantEl.closest(".assistant-turn-block");
        if (asstBlock && asstBlock.parentNode) {
          const userBlock = document.createElement("div");
          userBlock.className = "user-turn-block";
          const pill = document.createElement("div");
          pill.className = "chatgpt-user-pill";
          pill.textContent = clean;
          userBlock.appendChild(pill);
          asstBlock.parentNode.insertBefore(userBlock, asstBlock);
          this.lastUserPill = pill;
          this.scrollToBottom();
          return;
        }
      }
      this.addUserPill(clean);
    }
    this.appendMessageToActiveSession("user", clean);
    this.scrollToBottom();

    // Trigger an analysis activity in the floating window
    this.addAssistantActivity({
      type: 'read',
      file: 'studio/diligenceEngine.ts',
      desc: `Processing speech intent: "${clean.substring(0, 30)}..."`
    });
  }

  addUserPill(text) {
    if (!this.messagesContainer) return;
    const block = document.createElement("div");
    block.className = "user-turn-block";

    const pill = document.createElement("div");
    pill.className = "chatgpt-user-pill";
    pill.textContent = text;

    block.appendChild(pill);
    this.messagesContainer.appendChild(block);
    this.lastUserPill = pill;
    this.scrollToBottom();
  }

  handleServerMessage(msg) {
    const { type, content } = msg;

    // 1. Partial User Speech (Whisper Real-Time STT)
    if (type === "partial_user_request") {
      this.handlePartialUserSpeech(content);
      return;
    }

    // 2. Final User Speech (Completed turn)
    if (type === "final_user_request") {
      this.handleFinalUserSpeech(content);
      this.showThinking();
      return;
    }

    // 3. Partial Assistant Answer (Streaming live LLM response)
    if (type === "partial_assistant_answer" && content && this.messagesContainer) {
      this.hideThinking();
      if (!this.streamingAssistantEl) {
        this.clearStreamingCursor();   // nothing from an earlier turn may still blink
        const block = document.createElement("div");
        block.className = "assistant-turn-block";

        this.streamingAssistantEl = document.createElement("div");
        this.streamingAssistantEl.className = "assistant-text";
        block.appendChild(this.streamingAssistantEl);
        this.messagesContainer.appendChild(block);
      }
      // The LLM finishes streaming in a fraction of a second; speaking it takes
      // several. Rendering it as it arrives puts the whole answer on screen before
      // she has said the first word. Hold the text and let the reveal loop pace it
      // against real audio position instead.
      this.assistantFullText = content;
      this.startSpeechSync(this.streamingAssistantEl);
      return;
    }

    // 4. Final Assistant Answer (Complete synthesized speech)
    if (type === "final_assistant_answer" && content && this.messagesContainer) {
      this.hideThinking();
      let assistantTextEl = this.streamingAssistantEl;
      if (!assistantTextEl) {
        // Reuse existing assistant block if already present in DOM for this turn
        const lastBlock = this.messagesContainer.querySelector(".assistant-turn-block:last-child");
        if (lastBlock) {
          assistantTextEl = lastBlock.querySelector(".assistant-text");
        }
      }
      if (!assistantTextEl) {
        this.clearStreamingCursor();   // nothing from an earlier turn may still blink
        const block = document.createElement("div");
        block.className = "assistant-turn-block";
        assistantTextEl = document.createElement("div");
        assistantTextEl.className = "assistant-text";
        block.appendChild(assistantTextEl);
        this.messagesContainer.appendChild(block);
      }
      // Do NOT dump the whole answer here: the generation finishes well before she
      // has finished saying it, so this arrives mid-sentence from the listener's
      // point of view. Hand it to the reveal loop and let the voice stay in front.
      this.assistantFullText = content;
      this.pendingFinalText = content;
      this.startSpeechSync(assistantTextEl);
      // If TTS never starts at all (muted, or synthesis failed), the reveal would
      // sit at zero words forever. Show it plainly after a short grace period.
      clearTimeout(this.syncFallbackTimer);
      this.syncFallbackTimer = setTimeout(() => {
        if (!this.audio.isTTSPlaying && this.audio.getSpokenSeconds() === 0) {
          this.completeAssistantText();
        }
      }, 1200);
      this.appendMessageToActiveSession("assistant", content);

      // Add Minimalist Action Bar matching Screenshot 2: [Copy] [Thumbs Up] [Thumbs Down] [Share] [Regenerate] [•••]
      const parentBlock = assistantTextEl.closest(".assistant-turn-block");
      if (parentBlock && !parentBlock.querySelector(".assistant-actions")) {
        const actionsBar = document.createElement("div");
        actionsBar.className = "assistant-actions";
        actionsBar.innerHTML = `
          <button class="action-icon-btn copy-btn" title="Copy text">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
          <button class="action-icon-btn thumb-up-btn" title="Good response">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
            </svg>
          </button>
          <button class="action-icon-btn thumb-down-btn" title="Bad response">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path>
            </svg>
          </button>
          <button class="action-icon-btn share-btn" title="Share">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="18" cy="5" r="3"></circle>
              <circle cx="6" cy="12" r="3"></circle>
              <circle cx="18" cy="19" r="3"></circle>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
            </svg>
          </button>
          <button class="action-icon-btn reload-btn" title="Regenerate">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
          </button>
          <button class="action-icon-btn more-btn" title="More options">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="1"></circle>
              <circle cx="19" cy="12" r="1"></circle>
              <circle cx="5" cy="12" r="1"></circle>
            </svg>
          </button>
        `;
        parentBlock.appendChild(actionsBar);
        this.bindAssistantActionButtons(parentBlock);
      }

      this.streamingAssistantEl = null;
      this.lastUserPill = null;
      this.hasCompletedTurn = true;   // the weights are resident from here on
      this.scrollToBottom();
      return;
    }

    // 5. Incoming Audio Playback
    if (type === "tts_audio") {
      this.audio.playTTSChunk(msg.int16);
      return;
    }

    // 6. Barge-in / Interruption
    if (type === "tts_interrupt" || type === "tts_interruption" || type === "stop_tts") {
      // Drop the queued final text before stopping playback: stopping fires
      // onTTSPlaybackStopped, and completing the turn there would snap the
      // transcript to the whole answer she was cut off halfway through saying.
      this.pendingFinalText = null;
      const el = this.revealEl || this.streamingAssistantEl;
      this.audio.stopTTSPlayback();
      if (this.orbRenderer) this.orbRenderer.triggerInterruptionWave();
      // Stops the reveal loop and takes the caret with it. Left armed, the loop kept
      // appending words -- and a cursor -- to a turn nobody was listening to.
      this.finishSpeechSync("");
      if (el) {
        const text = el.textContent.trim();
        if (text && !text.endsWith("\u2026") && !text.endsWith("...")) {
          el.textContent = text + "\u2026";
        }
        this.invalidateReveal();
      }
      this.streamingAssistantEl = null;
      this.scrollToBottom();
      return;
    }

    // 7. Voice changed confirmation
    if (type === "voice_changed" && msg.voice && this.voiceSelect) {
      this.voiceSelect.value = msg.voice;
    }
  }

  scrollToBottom() {
    if (this.viewport) {
      this.viewport.scrollTop = this.viewport.scrollHeight;
    }
  }
}

function escapeHtml(str) {
  return (str ?? '')
    .replace(/&/g, "&amp;")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, "&quot;");
}

window.addEventListener("DOMContentLoaded", () => {
  const ui = new UIController();
  ui.init();
});
