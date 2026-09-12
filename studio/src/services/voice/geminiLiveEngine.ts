/**
 * The Gemini Live half of the voice lane.
 *
 * This is a drop-in for the `Realtime8000ProtocolManager` that used to live in
 * `voiceAudioEngine.ts` and talk a binary WebSocket protocol to a local Python
 * pipeline on :8000 (Whisper in, Kokoro out). That pipeline is gone. The shape
 * of this class is deliberately unchanged from it — same callbacks, same
 * `send*` methods, same six inbound message types — because the consumer,
 * `components/voice/TemiVoiceStage.tsx`, is a large state machine that was
 * tuned against that surface and should not have to learn a new one.
 *
 * Everything that changed is behind the surface:
 *
 *  - the SDK owns the socket, so there is no `url` to pass to `connect()`;
 *    the engine fetches its own single-use token instead (`geminiLiveToken.ts`)
 *  - the server runs its own VAD and its own barge-in, so several of the old
 *    control messages no longer have a counterpart. They are kept as
 *    documented no-ops rather than deleted — see TASK 5 comments below.
 *  - two sample-rate conversions the Python lane did elsewhere now happen here.
 *    Both are load-bearing; both are explained where they are implemented.
 *
 * The reference implementation this mapping was read off is the sandbox at
 * `../full-duplex-assistant/web/script.js` (`startRealtime()`), which has been
 * driving a real Gemini Live session for weeks.
 */

import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from "@google/genai";
import { TEMI_PERSONA, TEMI_DEFAULT_VOICE } from "./temiPersona.ts";
import { fetchGeminiLiveToken, describeGeminiLive } from "./geminiLiveToken.ts";

/**
 * Native-audio Live model. Measured working with `enableAffectiveDialog`, which
 * the half-cascade models reject: she hears how something was said, not only
 * what was said. The gateway may name a different model when it mints the
 * token; that wins, because the token is minted for a specific model.
 */
const DEFAULT_MODEL = "gemini-2.5-flash-native-audio-latest";

/** Gemini Live takes 16 kHz PCM in. Not negotiable; it is in the mime type. */
const MIC_RATE = 16000;
/**
 * The AudioContext in `voiceAudioEngine.ts` is pinned to `new AudioCtx({
 * sampleRate: 48000 })`, and `pcmWorkletProcessor` runs at context rate, so
 * every Int16 that arrives at `sendAudioChunk` is a 48 kHz sample.
 */
const MIC_CONTEXT_RATE = 48000;
/** Gemini Live always returns PCM16 mono at 24 kHz. */
const MODEL_AUDIO_RATE = 24000;
/** …and the playback worklet runs at the context rate. See `upsampleTo48k`. */
const PLAYBACK_RATE = 48000;

/** The eight bytes `voiceAudioEngine.flushBatch()` writes in front of a frame:
    a big-endian uint32 timestamp, then a big-endian uint32 flags word whose
    bit 0 is "TTS is playing". The Python lane used both for its own echo
    suppression; Gemini does that server-side, so we only skip past them. */
const FRAME_HEADER_BYTES = 8;

/** The six shapes this engine emits, and nothing else. The consumer switches
    on `type`, so adding a seventh here is a change to a contract, not a detail. */
export type GeminiLiveMessage =
  | { type: "partial_user_request"; content: string }
  | { type: "final_user_request"; content: string }
  | { type: "partial_assistant_answer"; content: string }
  | { type: "final_assistant_answer"; content: string }
  | { type: "tts_audio"; int16: Int16Array }
  | { type: "tts_interrupt" };

/**
 * Average 48 kHz Int16 down to 16 kHz Int16.
 *
 * This is `downsampleTo16k` from the sandbox (`web/script.js:852`) with one
 * difference, stated so nobody reads it as a mistake: the sandbox rounds the
 * output length per chunk, which at 2048 input samples asks for 683 outputs and
 * builds the last one from two samples instead of three. Here the leftover
 * input samples are carried into the next chunk instead, so the ratio is
 * exactly 3:1 forever and the stream neither stretches nor drifts.
 *
 * It averages rather than decimating, and that part matters: dropping two of
 * every three samples aliases everything above 8 kHz back down into the band
 * the recogniser listens to, and consonants are exactly what lives up there.
 */
function downsampleTo16k(input: Int16Array, carry: Int16Array): { out: Int16Array; carry: Int16Array } {
  const ratio = MIC_CONTEXT_RATE / MIC_RATE; // exactly 3
  const total = carry.length + input.length;
  const outLength = Math.floor(total / ratio);
  const out = new Int16Array(outLength);

  const at = (i: number) => (i < carry.length ? carry[i] : input[i - carry.length]);

  for (let o = 0; o < outLength; o++) {
    let sum = 0;
    const base = o * ratio;
    for (let k = 0; k < ratio; k++) sum += at(base + k);
    out[o] = (sum / ratio) | 0;
  }

  const consumed = outLength * ratio;
  const leftover = new Int16Array(total - consumed);
  for (let i = 0; i < leftover.length; i++) leftover[i] = at(consumed + i);
  return { out, carry: leftover };
}

/**
 * Linear-interpolate 24 kHz Int16 up to 48 kHz Int16.
 *
 * THIS IS NOT COSMETIC AND IT IS EASY TO DELETE BY ACCIDENT. Gemini returns
 * PCM16 at 24000 Hz. `worklets/ttsPlaybackProcessor.js` writes exactly one
 * queued sample per output frame — read its `process()`; there is no resampling
 * anywhere in it — and the AudioContext it runs in is 48000 Hz. Hand it 24 kHz
 * samples and every one of them lasts half as long as it should: Temi plays
 * back at double speed and an octave high.
 *
 * The old Python lane never hit this because it resampled before the renderer
 * ever saw the audio — `realtime-voice/code/upsample_overlap.py:54`,
 * `resample_poly(audio_float, 48000, 24000)`. That file is gone, so the
 * conversion moved here. If you are deleting this because "the worklet handles
 * it", it does not.
 *
 * Linear interpolation is enough at 2x: the inserted sample sits between two
 * real ones, and the error is inaudible against a 24 kHz-bandlimited source.
 * The last real sample of each chunk is kept as the anchor for the next one,
 * because otherwise every chunk boundary interpolates from zero and the stream
 * clicks at the buffer rate.
 */
function upsampleTo48k(input: Int16Array, anchor: number): { out: Int16Array; anchor: number } {
  const factor = PLAYBACK_RATE / MODEL_AUDIO_RATE; // exactly 2
  const out = new Int16Array(input.length * factor);
  let previous = anchor;
  for (let i = 0; i < input.length; i++) {
    const current = input[i];
    out[i * 2] = ((previous + current) / 2) | 0;
    out[i * 2 + 1] = current;
    previous = current;
  }
  return { out, anchor: previous };
}

/** Base64 in chunks: `String.fromCharCode(...bytes)` on a whole 40 ms frame
    blows the argument limit on some engines, and this is on the hot path. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export class GeminiLiveEngine {
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onError: ((err: unknown) => void) | null = null;
  onMessage: ((msg: any) => void) | null = null;
  /**
   * The one sentence the operator sees about the state of the voice lane —
   * "" when all is well, something actionable otherwise. Fired on every token
   * fetch, which means first connect and every reconnect. The engine reports it
   * because the engine is the only thing that fetches tokens: they are
   * `uses: 1`, so a second fetch anywhere else would spend one for nothing.
   */
  onNote: ((note: string) => void) | null = null;

  private ai: GoogleGenAI | null = null;
  private session: Session | null = null;
  private connecting = false;

  /** Set by `disconnect()` so a deliberate close does not schedule a reconnect.
      Carried over unchanged from the old protocol manager. */
  explicitlyDisconnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while `restartSession()` is tearing one session down to build the
      next: its `onclose` is expected and must not look like a dropped link. */
  private replacingSession = false;

  private model = DEFAULT_MODEL;
  private voice = TEMI_DEFAULT_VOICE;

  /** Running transcripts. Gemini streams both sides as deltas and never resends
      the whole line, so the accumulation has to happen on this side. */
  private inputTranscript = "";
  private outputTranscript = "";

  /** Generation guard — see `sendBargeIn()`. */
  private generation = 0;
  private suppressedGeneration = -1;
  private turnActive = false;

  private micCarry: Int16Array = new Int16Array(0);
  /** Odd trailing byte of a base64 audio chunk. Gemini's chunks are not
      guaranteed to split on a sample boundary, and one orphaned byte would
      shift every following sample by 8 bits — white noise, not audio. */
  private pcmByteCarry = new Uint8Array(0);
  private upsampleAnchor = 0;

  /**
   * Open a session. No URL argument any more: the address is the SDK's problem
   * and the credential is a token this method fetches for itself.
   */
  async connect(): Promise<void> {
    if (this.connecting) return;
    if (this.session) return;
    this.explicitlyDisconnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connecting = true;

    try {
      // Every connect spends a fresh token. `uses: 1` and ~30 minutes of life
      // mean the one from the last attempt is already worthless.
      const result = await fetchGeminiLiveToken();
      this.onNote?.(describeGeminiLive(result));
      if (!result.ok) {
        this.onError?.(new Error(`${result.reason}: ${result.detail}`));
        this.connecting = false;
        // Only a gateway that is not up yet is worth retrying — that resolves
        // on its own within seconds of a cold start. A missing or rejected key
        // does not become valid in two seconds, and retrying it would bury the
        // note above under a loop the operator cannot act on.
        if (result.reason === "gateway-unreachable") this.scheduleReconnect();
        return;
      }

      if (result.model) this.model = result.model;
      if (result.voice) this.voice = result.voice;

      // v1alpha is not a preference. Ephemeral tokens exist only on that API
      // version, and the SDK defaults to v1beta, where this token is rejected.
      this.ai = new GoogleGenAI({ apiKey: result.token, httpOptions: { apiVersion: "v1alpha" } });

      this.resetStreamState();

      this.session = await this.ai.live.connect({
        model: this.model,
        config: {
          // `Modality.AUDIO` is the string "AUDIO"; the enum is used so the
          // SDK's own types accept it.
          responseModalities: [Modality.AUDIO],
          // Native-audio only. She answers the tone as well as the words.
          enableAffectiveDialog: true,
          // Both transcriptions on: they are the only source of the captions,
          // and of the user turns the shell routes as commands.
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            // Only the end-of-turn wait is tuned. Measured in the sandbox:
            // LOW start sensitivity stopped hearing the user at all, and a
            // shorter silence window cut her off mid-sentence at every comma.
            automaticActivityDetection: { silenceDurationMs: 700 },
          },
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } },
          },
          systemInstruction: TEMI_PERSONA,
        },
        callbacks: {
          onopen: () => {
            this.onConnected?.();
          },
          onmessage: (message: LiveServerMessage) => {
            try {
              this.handleServerMessage(message);
            } catch (err) {
              this.onError?.(err);
            }
          },
          onerror: (event: ErrorEvent) => {
            this.onError?.(event);
          },
          onclose: () => {
            this.session = null;
            if (this.replacingSession) return;
            this.onDisconnected?.();
            if (!this.explicitlyDisconnected) this.scheduleReconnect();
          },
        },
      });
    } catch (err) {
      this.session = null;
      this.onError?.(err);
      if (!this.explicitlyDisconnected && !this.replacingSession) this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  /** The old lane's 2-second backoff, kept as it was. The difference is that
      the retry goes back through `connect()`, which mints a new token — reusing
      the spent one would fail every time and look like an outage. */
  private scheduleReconnect() {
    if (this.reconnectTimer || this.explicitlyDisconnected) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.explicitlyDisconnected) void this.connect();
    }, 2000);
  }

  disconnect(): void {
    this.explicitlyDisconnected = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSession();
    this.ai = null;
    this.resetStreamState();
  }

  private closeSession() {
    const session = this.session;
    this.session = null;
    if (!session) return;
    try {
      session.close();
    } catch {
      // A socket that is already gone is the outcome we wanted.
    }
  }

  /**
   * Tear the session down and build a fresh one.
   *
   * Two of the old control messages land here, because in Gemini Live the
   * session *is* the thing they were changing: the voice is fixed at setup and
   * the conversation history is the session's own state. There is no message
   * for either, so the only honest implementation is a new session.
   */
  private async restartSession(): Promise<void> {
    if (this.explicitlyDisconnected) return;
    this.replacingSession = true;
    try {
      this.closeSession();
      this.resetStreamState();
      await this.connect();
    } finally {
      this.replacingSession = false;
    }
  }

  private resetStreamState() {
    this.inputTranscript = "";
    this.outputTranscript = "";
    this.turnActive = false;
    this.micCarry = new Int16Array(0);
    this.pcmByteCarry = new Uint8Array(0);
    this.upsampleAnchor = 0;
  }

  // ---------------------------------------------------------------- inbound

  private emit(msg: GeminiLiveMessage) {
    this.onMessage?.(msg);
  }

  private handleServerMessage(message: LiveServerMessage) {
    const content = message.serverContent;

    // Server-side barge-in: its VAD heard the user over her. Drop everything
    // still queued, because the audio already in the worklet is a reply to a
    // sentence the user has stopped waiting for.
    if (content?.interrupted) {
      this.upsampleAnchor = 0;
      this.pcmByteCarry = new Uint8Array(0);
      this.turnActive = false;
      this.emit({ type: "tts_interrupt" });
      return;
    }

    const inputText = content?.inputTranscription?.text;
    if (inputText) {
      this.inputTranscript += inputText;
      this.emit({ type: "partial_user_request", content: this.inputTranscript });
    }

    const outputText = content?.outputTranscription?.text;
    if (outputText) {
      // Her first word is the only proof the user's turn ended. Nothing else in
      // the stream says so — there is no `inputTranscription` terminator — so
      // without this the operator's half of the conversation is never finalised
      // and never reaches the router.
      this.finalizeUserTurn();
      this.outputTranscript += outputText;
      this.emit({ type: "partial_assistant_answer", content: this.outputTranscript });
    }

    // Audio arrives on the SDK fast path as `message.data`; when the SDK does
    // not lift it, it is still down in the model turn's inline parts.
    const chunks: string[] = [];
    if (message.data) chunks.push(message.data);
    else {
      for (const part of content?.modelTurn?.parts || []) {
        if (part?.inlineData?.data) chunks.push(part.inlineData.data);
      }
    }

    if (chunks.length) {
      if (!this.turnActive) {
        this.turnActive = true;
        this.generation += 1;
        this.upsampleAnchor = 0;
        this.pcmByteCarry = new Uint8Array(0);
      }
      if (this.generation !== this.suppressedGeneration) {
        for (const b64 of chunks) this.emitAudio(b64);
      }
    }

    if (content?.turnComplete) {
      // Backstop for a turn she answered with silence: the user's line still
      // has to be finalised or it is lost.
      this.finalizeUserTurn();
      this.turnActive = false;
      const answer = this.outputTranscript;
      this.outputTranscript = "";
      if (answer) this.emit({ type: "final_assistant_answer", content: answer });
    }
  }

  private finalizeUserTurn() {
    if (!this.inputTranscript) return;
    const request = this.inputTranscript;
    this.inputTranscript = "";
    this.emit({ type: "final_user_request", content: request });
  }

  private emitAudio(b64: string) {
    const incoming = base64ToBytes(b64);

    // Re-attach any half sample left over from the previous chunk before
    // reading Int16s, or the whole stream shifts by a byte.
    let bytes: Uint8Array;
    if (this.pcmByteCarry.length) {
      bytes = new Uint8Array(this.pcmByteCarry.length + incoming.length);
      bytes.set(this.pcmByteCarry, 0);
      bytes.set(incoming, this.pcmByteCarry.length);
      this.pcmByteCarry = new Uint8Array(0);
    } else {
      bytes = incoming;
    }
    const usable = bytes.length - (bytes.length % 2);
    if (usable < bytes.length) this.pcmByteCarry = bytes.slice(usable);
    if (usable === 0) return;

    // PCM16 little-endian, which is what an Int16Array view reads on every
    // platform this app ships to.
    const at24k = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2);
    const { out, anchor } = upsampleTo48k(at24k, this.upsampleAnchor);
    this.upsampleAnchor = anchor;
    this.emit({ type: "tts_audio", int16: out });
  }

  // --------------------------------------------------------------- outbound

  /**
   * A frame from `voiceAudioEngine`: 8 header bytes, then 2048 Int16 samples at
   * the AudioContext's 48000 Hz. Strip the header, average 3:1 down to the
   * 16000 Hz Gemini insists on, and hand it over as base64.
   *
   * The header is not forwarded. Its flags word told the Python pipeline when
   * our own speaker was live so it could gate its recogniser; Gemini's VAD and
   * echo handling are server-side and want the raw stream.
   */
  sendAudioChunk(buffer: ArrayBuffer): void {
    if (!this.session) return;
    if (buffer.byteLength <= FRAME_HEADER_BYTES) return;

    const samples = new Int16Array(buffer, FRAME_HEADER_BYTES);
    const { out, carry } = downsampleTo16k(samples, this.micCarry);
    this.micCarry = carry;
    if (!out.length) return;

    const data = bytesToBase64(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
    try {
      this.session.sendRealtimeInput({ audio: { data, mimeType: `audio/pcm;rate=${MIC_RATE}` } });
    } catch (err) {
      this.onError?.(err);
    }
  }

  /** A typed turn. `sendClientContent` is the ordered channel, which is what a
      typed line wants: it lands in context in sequence rather than racing the
      realtime audio stream. */
  sendUserText(text: string): void {
    const line = (text ?? "").trim();
    if (!line || !this.session) return;
    try {
      this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text: line }] }], turnComplete: true });
    } catch (err) {
      this.onError?.(err);
    }
  }

  /**
   * A line the Teminali OS shell wants spoken now, in Temi's voice: an answer
   * built from the live agent run, or its final report. It is not a user turn,
   * but the model has one way in, so it enters bracketed and the persona is
   * told what the bracket means.
   */
  sendAssistantDirective(text: string): void {
    const line = (text ?? "").trim();
    if (!line || !this.session) return;
    const framed = `[Say this to the user now: ${line}]`;
    try {
      this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text: framed }] }], turnComplete: true });
    } catch (err) {
      this.onError?.(err);
    }
  }

  /**
   * Is this "user turn" actually our own directive coming back?
   *
   * On the Python lane this was a real defence. `server.py` delivered a
   * directive through `on_final`, the same callback a spoken turn used, so it
   * returned as `final_user_request` and was indistinguishable from speech.
   * That closed a loop: the shell delegated, said "On it.", the directive came
   * back as a user turn, the switch classified it as work and delegated again.
   * Observed 2026-09-10, with the queue filling with identical tasks and the
   * assistant talking to itself.
   *
   * With Gemini Live that specific loop cannot happen: a directive goes in
   * through `sendClientContent` as text, and a text turn produces no
   * `inputTranscription` — only spoken audio does — so it never re-enters as a
   * `final_user_request`. The predicate stays anyway, for two reasons. It is
   * still the correct guard if a bracketed line ever reaches the user turn path
   * by another route, and `tests/voice-directive-echo.test.mjs` pins it as a
   * pure predicate. The regex is unchanged from the version that shipped.
   */
  static isAssistantDirectiveEcho(text: string): boolean {
    return /^\[\s*Say this to the user now\b/i.test((text ?? "").trim());
  }

  /**
   * Stop the reply that is being spoken, because the turn is being answered
   * here instead — a status question, a stop, praise — so two voices never
   * answer one sentence.
   *
   * Gemini Live has no "cancel this generation" message. Be clear about what
   * this therefore is and is not: it is a LOCAL guard. The model may well
   * carry on generating server-side, and we will keep receiving its audio; we
   * simply stop forwarding it. The generation counter is what makes that
   * precise — audio for the superseded generation is dropped, audio for the
   * next real turn is not.
   *
   * If no turn is in flight yet, the barge-in suppresses the NEXT one. That is
   * the common case, not an edge: the shell decides to answer locally the
   * moment the transcript lands, which is before she has said a word.
   */
  sendBargeIn(): void {
    this.suppressedGeneration = this.turnActive ? this.generation : this.generation + 1;
    this.turnActive = false;
    this.outputTranscript = "";
    this.upsampleAnchor = 0;
    this.pcmByteCarry = new Uint8Array(0);
    this.emit({ type: "tts_interrupt" });
  }

  /**
   * No-ops, and they stay no-ops.
   *
   * The Python lane used these to gate its own microphone while our speaker was
   * live, because its recogniser would otherwise transcribe Temi. Gemini runs
   * its VAD and its barge-in on the server and expects an unbroken input
   * stream, so telling it about our playback is neither possible nor wanted.
   * They are kept because the consumer calls them on every spoken turn, and
   * deleting them would only move an `if` into the state machine.
   */
  sendTTSStart(): void {}

  /** See `sendTTSStart`. */
  sendTTSStop(): void {}

  /**
   * Gemini Live fixes the voice at session setup; there is no message that
   * changes it mid-session. So this stores the choice and builds a new session
   * with it, which costs a reconnect and a fresh token. The conversation so far
   * is lost with the old session — an honest cost of the model, not a bug here.
   */
  sendVoiceChange(voice: string): void {
    const next = (voice ?? "").trim();
    if (!next || next === this.voice) return;
    this.voice = next;
    void this.restartSession();
  }

  /**
   * No-op. The Python lane passed a speed to Kokoro; Gemini's native audio has
   * no rate control, and the persona is where pace is asked for now. Kept
   * because the settings panel still offers the slider to the other lane.
   */
  sendSpeedChange(_speed: number): void {}

  /** The session *is* the history, so clearing it means a new session. */
  sendClearHistory(): void {
    void this.restartSession();
  }
}
