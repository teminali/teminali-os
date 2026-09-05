/**
 * Premium tier — VibeVoice (microsoft/VibeVoice, MIT).
 *
 * Why this one. It is the only open stack that covers everything the built-in
 * tier cannot, without sending a syllable off the machine:
 *
 *   - VibeVoice-ASR-7B is natively multilingual across 50+ languages, so
 *     Kiswahili is a first-class language rather than a best-effort tag.
 *   - VibeVoice-ASR-BitNet runs on 3+ CPU threads with no GPU, which matters
 *     on an Apple Silicon laptop that is already hosting the code model.
 *   - VibeVoice-Realtime-0.5B synthesises from streaming text at roughly 300ms
 *     to first audio, which is what lets a reply start speaking while it is
 *     still being generated.
 *   - MIT licence, so it can ship inside the product.
 *
 * It talks to a local sidecar through the Teminali gateway rather than being
 * bundled: the models are large, and an operator who has not installed them
 * should still get a working assistant on the built-in tier. Everything here
 * degrades to "unavailable" rather than throwing on a missing sidecar.
 */

import { GatewayClient } from "../../gatewayClient";
import { playSpeechStream } from "../clausePlayer";
import { isSpeechStream } from "../speechStream";
import {
  VoiceError,
  type AmbientSound,
  type LanguageSetting,
  type ProviderCapabilities,
  type RecognitionHandlers,
  type RecognitionOptions,
  type RecognitionResult,
  type RecognitionSession,
  type SpeakOptions,
  type SynthesisHandle,
  type VoiceProvider,
} from "../types";

interface VoiceStatusResponse {
  available: boolean;
  /** Which engine answered: the VibeVoice sidecar, or the local binaries. */
  engine?: "vibevoice" | "local";
  detail?: string;
  asr?: { model: string; languages: string[]; streaming: boolean; embedding: boolean; sounds?: boolean };
  tts?: { model: string; voices: string[]; streaming: boolean };
}

interface TranscribeResponse {
  text: string;
  language: string;
  confidence?: number;
  /** Speaker embedding, when the sidecar was built with the verifier head. */
  embedding?: number[];
  /** Named non-speech sounds, when the request asked for them. */
  sounds?: AmbientSound[];
}

/**
 * Chunk size for a streaming engine. A non-streaming one (whisper.cpp) records
 * the whole utterance instead: feeding it 700ms slices would transcribe each
 * fragment out of context and produce far worse text than one pass over the
 * complete sentence.
 */
const CHUNK_MS = 700;

export class VibeVoiceProvider implements VoiceProvider {
  capabilities: ProviderCapabilities = {
    tier: "vibevoice",
    label: "VibeVoice (local)",
    asr: false,
    tts: false,
    languageDetection: true,
    streamingAsr: true,
    streamingTts: true,
    speakerEmbedding: true,
    soundLabels: false,
    languages: [],
    detail: "Not probed yet.",
  };

  /** Live capture stream, injected by the engine so we share one microphone. */
  private stream: MediaStream | null = null;

  attachStream(stream: MediaStream | null): void {
    this.stream = stream;
  }

  async probe(signal?: AbortSignal): Promise<ProviderCapabilities> {
    try {
      const response = await GatewayClient.request("/api/voice/status", { method: "GET", signal });
      if (!response.ok) {
        this.capabilities = {
          ...this.capabilities,
          asr: false,
          tts: false,
          detail: `The voice sidecar answered ${response.status}.`,
        };
        return this.capabilities;
      }
      const status = (await response.json()) as VoiceStatusResponse;
      // `available` means the sidecar answered, not that it can transcribe — the
      // server sets it when *either* ASR or TTS is up. Gating the detail on it
      // meant a sidecar with working `say` but no whisper reported no reason at
      // all, so the engine's joined error fell back to the Chromium note: the one
      // tier that can never work in the desktop shell.
      const asrAvailable = Boolean(status.available && status.asr);
      this.capabilities = {
        ...this.capabilities,
        label: status.engine === "local" ? "Local (whisper.cpp)" : "VibeVoice (local)",
        asr: asrAvailable,
        tts: Boolean(status.available && status.tts),
        languageDetection: Boolean(status.asr),
        streamingAsr: status.asr?.streaming ?? false,
        streamingTts: status.tts?.streaming ?? false,
        speakerEmbedding: status.asr?.embedding ?? false,
        soundLabels: Boolean(asrAvailable && status.asr?.sounds),
        languages: status.asr?.languages ?? [],
        detail: asrAvailable ? undefined : (status.detail ?? "The VibeVoice sidecar is not running."),
      };
    } catch (error) {
      this.capabilities = {
        ...this.capabilities,
        asr: false,
        tts: false,
        detail:
          (error as Error)?.name === "AbortError"
            ? "Probe cancelled."
            : "The gateway is not reachable, so the voice sidecar could not be checked.",
      };
    }
    return this.capabilities;
  }

  /**
   * Chunked recognition over the shared capture stream. Each chunk is sent as
   * it closes and the running transcript is re-emitted, which gives the same
   * interim-then-final shape the built-in engine produces.
   */
  async listen(options: RecognitionOptions, handlers: RecognitionHandlers): Promise<RecognitionSession> {
    if (!this.capabilities.asr) {
      throw new VoiceError(this.capabilities.detail ?? "VibeVoice ASR is unavailable.", "NO_PROVIDER", false);
    }
    if (!this.stream) {
      throw new VoiceError("No microphone stream was attached to the provider.", "MIC_UNAVAILABLE", false);
    }
    if (typeof MediaRecorder === "undefined") {
      throw new VoiceError("This build cannot record audio.", "MIC_UNAVAILABLE", false);
    }

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    const controller = new AbortController();
    const streaming = this.capabilities.streamingAsr;
    const wantSounds = Boolean(options.sounds && this.capabilities.soundLabels);
    let active = true;
    let settled = "";
    let inFlight = 0;
    /** Buffered audio for the single-pass path. */
    const parts: Blob[] = [];

    const close = () => {
      if (!active) return;
      active = false;
      controller.abort();
      if (recorder.state !== "inactive") recorder.stop();
      handlers.onClose?.();
    };

    recorder.ondataavailable = async (event) => {
      if (!active || event.data.size < 1200) return;
      if (!streaming) {
        // Hold everything; the whole utterance is transcribed on stop.
        parts.push(event.data);
        return;
      }
      inFlight += 1;
      try {
        const result = await this.transcribeBlob(event.data, options.language, controller.signal, {
          sounds: wantSounds,
        });
        const chunk = result.transcript.trim();
        if (!active) return;
        if (result.sounds?.length) handlers.onSound?.(result.sounds);
        if (!chunk) return;
        settled = settled ? `${settled} ${chunk}` : chunk;
        handlers.onResult({
          transcript: settled,
          // A chunk boundary is not an utterance boundary; the engine's
          // endpointer decides when the turn is over, not the recorder.
          isFinal: false,
          confidence: result.confidence,
          language: result.language,
        });
      } catch (error) {
        if ((error as Error)?.name === "AbortError") return;
        handlers.onError?.(
          error instanceof VoiceError
            ? error
            : new VoiceError(`VibeVoice transcription failed: ${(error as Error).message}`, "ASR_FAILED"),
        );
      } finally {
        inFlight -= 1;
      }
    };

    recorder.onstop = async () => {
      if (!streaming) {
        // One pass over the complete utterance — the accurate path.
        const blob = new Blob(parts, mimeType ? { type: mimeType } : undefined);
        parts.length = 0;
        if (blob.size > 1200 && active) {
          try {
            const result = await this.transcribeBlob(blob, options.language, controller.signal, {
              sounds: wantSounds,
            });
            // Before the transcript check, not after: a car makes no words, so
            // the clip worth labelling is exactly the one that returns none.
            if (result.sounds?.length) handlers.onSound?.(result.sounds);
            if (result.transcript.trim()) {
              handlers.onResult({
                transcript: result.transcript.trim(),
                isFinal: true,
                confidence: result.confidence,
                language: result.language,
              });
            }
          } catch (error) {
            if ((error as Error)?.name !== "AbortError") {
              handlers.onError?.(
                error instanceof VoiceError
                  ? error
                  : new VoiceError(`Transcription failed: ${(error as Error).message}`, "ASR_FAILED"),
              );
            }
          }
        }
        close();
        return;
      }

      // Streaming path: let any outstanding chunk resolve before finishing.
      const settle = () => {
        if (inFlight > 0 && active) {
          window.setTimeout(settle, 60);
          return;
        }
        if (settled.trim()) {
          handlers.onResult({ transcript: settled, isFinal: true, confidence: -1, language: "" });
        }
        close();
      };
      settle();
    };

    recorder.onerror = () => {
      handlers.onError?.(new VoiceError("The recorder failed mid-capture.", "ASR_FAILED"));
      close();
    };

    // A non-streaming engine gets one blob; a streaming one gets slices.
    if (streaming) recorder.start(CHUNK_MS);
    else recorder.start();
    options.signal?.addEventListener("abort", close);

    return {
      get active() {
        return active;
      },
      stop: () => {
        if (recorder.state !== "inactive") recorder.stop();
      },
      abort: close,
    };
  }

  async transcribeBlob(
    blob: Blob,
    language: LanguageSetting,
    signal?: AbortSignal,
    options: { sounds?: boolean } = {},
  ): Promise<RecognitionResult> {
    const form = new FormData();
    form.append("audio", blob, "utterance.webm");
    form.append("language", language);
    // Only when both sides want it: the caller has the ambient log switched on
    // and the sidecar has a classifier warm.
    if (options.sounds && this.capabilities.soundLabels) form.append("sounds", "1");

    const response = await GatewayClient.request("/api/voice/transcribe", {
      method: "POST",
      signal,
      body: form,
    });
    await GatewayClient.expectOk(response);
    const data = (await response.json()) as TranscribeResponse;
    return {
      transcript: data.text ?? "",
      isFinal: true,
      confidence: data.confidence ?? -1,
      language: data.language ?? "",
      sounds: data.sounds ?? [],
    };
  }

  /** Speaker embedding for the addressing gate, when the sidecar exposes one. */
  async embed(blob: Blob, signal?: AbortSignal): Promise<number[] | null> {
    if (!this.capabilities.speakerEmbedding) return null;
    const form = new FormData();
    form.append("audio", blob, "utterance.webm");
    form.append("embedding", "1");
    try {
      const response = await GatewayClient.request("/api/voice/transcribe", {
        method: "POST",
        signal,
        body: form,
      });
      if (!response.ok) return null;
      const data = (await response.json()) as TranscribeResponse;
      return data.embedding ?? null;
    } catch {
      return null;
    }
  }

  async speak(options: SpeakOptions): Promise<SynthesisHandle> {
    if (!this.capabilities.tts) {
      throw new VoiceError(this.capabilities.detail ?? "VibeVoice TTS is unavailable.", "TTS_FAILED", false);
    }

    const controller = new AbortController();
    options.signal?.addEventListener("abort", () => controller.abort());

    const response = await GatewayClient.request("/api/voice/speak", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        text: options.text,
        language: options.language,
        voice: options.voice ?? null,
        rate: options.rate ?? 1,
        // Ask for clause frames when the sidecar renders them, so the reply
        // starts speaking after the first clause. A whole-file engine ignores
        // the flag and answers with one WAV, which the path below plays.
        stream: this.capabilities.streamingTts,
      }),
    });
    await GatewayClient.expectOk(response);

    if (isSpeechStream(response.headers.get("content-type"))) {
      return playSpeechStream(response, options, controller);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.preload = "auto";

    let speaking = true;
    let spokenChars = 0;

    const finish = () => {
      if (!speaking) return;
      speaking = false;
      URL.revokeObjectURL(url);
      options.onEnd?.(spokenChars);
    };

    // No word boundaries from a rendered file, so approximate the read
    // position from playback progress. That is all barge-in needs: how much of
    // the reply the operator actually heard.
    audio.ontimeupdate = () => {
      if (!audio.duration || !Number.isFinite(audio.duration)) return;
      spokenChars = Math.round((audio.currentTime / audio.duration) * options.text.length);
      options.onBoundary?.(spokenChars);
    };
    audio.onplay = () => options.onStart?.();
    audio.onended = () => {
      spokenChars = options.text.length;
      finish();
    };
    audio.onerror = finish;

    try {
      await audio.play();
    } catch {
      finish();
      throw new VoiceError("The synthesised reply could not be played.", "TTS_FAILED");
    }

    const cancel = () => {
      audio.pause();
      finish();
    };
    controller.signal.addEventListener("abort", cancel);

    return {
      cancel,
      get speaking() {
        return speaking;
      },
    };
  }
}

/** First container the browser will actually record. */
function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}
