/**
 * Built-in tier — the browser's own speech engine.
 *
 * Always available in Chromium (so, in the Electron shell), needs no install
 * and no sidecar, which makes it the right default and the right fallback. Its
 * limits are real and worth naming: it cannot detect the spoken language (you
 * must tell it), its African-language coverage is thin, and in Chrome it sends
 * audio to Google's servers rather than staying on the machine. The VibeVoice
 * tier exists to fix all three.
 */

import {
  VoiceError,
  type LanguageSetting,
  type ProviderCapabilities,
  type RecognitionHandlers,
  type RecognitionOptions,
  type RecognitionSession,
  type SpeakOptions,
  type SynthesisHandle,
  type VoiceProvider,
  VOICE_LANGUAGES,
  DEFAULT_LANGUAGE,
} from "../types";

/* The Web Speech API is still unprefixed-optional and absent from lib.dom. */
interface SpeechRecognitionAlternative { transcript: string; confidence: number }
interface SpeechRecognitionResult { readonly length: number; isFinal: boolean; [index: number]: SpeechRecognitionAlternative }
interface SpeechRecognitionResultList { readonly length: number; [index: number]: SpeechRecognitionResult }
interface SpeechRecognitionEventLike { resultIndex: number; results: SpeechRecognitionResultList }
interface SpeechRecognitionErrorEventLike { error: string; message?: string }
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onspeechend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

const ERROR_MESSAGES: Record<string, string> = {
  "not-allowed": "Microphone permission was denied.",
  "service-not-allowed": "The browser blocked its speech service.",
  network: "The speech service could not be reached.",
  "audio-capture": "No microphone was found.",
  "language-not-supported": "This language is not supported by the built-in engine.",
  aborted: "Listening was stopped.",
  "no-speech": "No speech was detected.",
};

const NOVELTY_VOICES = new Set([
  "albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos",
  "deranged", "good news", "hysterical", "jester", "organ", "pipe organ",
  "princess", "superstar", "trinoids", "whisper", "wobble", "zarvox",
]);

/**
 * Eloquence and pre-Vocalizer MacinTalk voices: intelligible but flat, so they
 * lose to a real voice without being scored out. "Alex" is on neither list —
 * it is Apple's flagship US male voice and the largest asset macOS ships.
 * Mirrors LEGACY_VOICES in server/speech-local.js.
 */
const LEGACY_VOICES = new Set([
  "eddy", "flo", "grandma", "grandpa", "reed", "rocko", "sandy", "shelley",
  "agnes", "bruce", "fred", "junior", "kathy", "ralph", "vicki", "victoria",
]);

let cachedVoices: SpeechSynthesisVoice[] = [];
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  cachedVoices = window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoices = window.speechSynthesis.getVoices();
  };
}

async function getAvailableVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const current = synth.getVoices();
  if (current.length > 0) {
    cachedVoices = current;
    return current;
  }
  if (cachedVoices.length > 0) return cachedVoices;

  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(synth.getVoices());
      }
    }, 350);

    const onVoices = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        cachedVoices = synth.getVoices();
        synth.removeEventListener("voiceschanged", onVoices);
        resolve(cachedVoices);
      }
    };
    synth.addEventListener("voiceschanged", onVoices);
  });
}

export class WebSpeechProvider implements VoiceProvider {
  capabilities: ProviderCapabilities = {
    tier: "builtin",
    label: "Built-in (browser)",
    asr: false,
    tts: false,
    languageDetection: false,
    streamingAsr: true,
    streamingTts: false,
    speakerEmbedding: false,
    // The Chromium recogniser reports words or nothing; there is no audio to
    // classify on this tier.
    soundLabels: false,
    languages: VOICE_LANGUAGES.filter((language) => language.webSpeech).map((language) => language.tag),
  };

  async probe(): Promise<ProviderCapabilities> {
    const constructible = recognitionCtor() !== null;
    const tts = typeof window !== "undefined" && "speechSynthesis" in window;

    // Chromium's recogniser is not self-contained: it streams audio to Google's
    // speech service using an API key that Chrome ships and Electron does not.
    // Inside the desktop shell the constructor exists and every session then
    // dies with a bare `network` error, so reporting it as available would be a
    // lie that costs the operator a broken microphone instead of a clear
    // message. Detect the shell and route to the local engine instead.
    const electron = typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent);
    const asr = constructible && !electron;

    this.capabilities = {
      ...this.capabilities,
      asr,
      tts,
      // Says only what this provider knows. Whether anything takes over is the
      // resolver's business, and claiming a fallback that did not happen is
      // how an operator ends up staring at a dead microphone being told it
      // works.
      detail: electron
        ? "The browser recogniser needs Google's speech service, which the desktop shell cannot reach."
        : constructible
          ? undefined
          : "This browser has no SpeechRecognition implementation.",
    };
    return this.capabilities;
  }

  async listen(options: RecognitionOptions, handlers: RecognitionHandlers): Promise<RecognitionSession> {
    const Ctor = recognitionCtor();
    if (!Ctor) throw new VoiceError("The built-in speech engine is unavailable.", "NO_PROVIDER", false);

    const recognition = new Ctor();
    recognition.lang = resolveLanguage(options.language);
    recognition.continuous = options.continuous;
    recognition.interimResults = options.interim;
    recognition.maxAlternatives = 1;

    let active = true;
    // In continuous mode Chromium still ends the stream on its own after a
    // silence. Restart transparently so the operator sees one unbroken session.
    let restartWanted = options.continuous;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const alternative = result[0];
        if (!alternative) continue;
        handlers.onResult({
          transcript: alternative.transcript,
          isFinal: result.isFinal,
          confidence: typeof alternative.confidence === "number" ? alternative.confidence : -1,
          language: recognition.lang,
        });
      }
    };

    recognition.onspeechend = () => handlers.onSpeechEnd?.();

    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are routine in an always-open session.
      if (event.error === "no-speech" || event.error === "aborted") return;
      restartWanted = false;
      const code =
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "MIC_DENIED"
          : event.error === "network"
            ? "NETWORK"
            : event.error === "language-not-supported"
              ? "LANGUAGE_UNSUPPORTED"
              : "ASR_FAILED";
      handlers.onError?.(
        new VoiceError(ERROR_MESSAGES[event.error] ?? `Speech recognition failed (${event.error}).`, code),
      );
    };

    recognition.onend = () => {
      if (restartWanted && active) {
        try {
          recognition.start();
          return;
        } catch {
          /* Falls through to closing the session. */
        }
      }
      active = false;
      handlers.onClose?.();
    };

    try {
      recognition.start();
    } catch (error) {
      throw new VoiceError(
        `The speech engine refused to start (${(error as Error).message}).`,
        "ASR_FAILED",
      );
    }

    options.signal?.addEventListener("abort", () => {
      restartWanted = false;
      active = false;
      recognition.abort();
    });

    return {
      get active() {
        return active;
      },
      stop: () => {
        restartWanted = false;
        recognition.stop();
      },
      abort: () => {
        restartWanted = false;
        active = false;
        recognition.abort();
      },
    };
  }


  async speak(options: SpeakOptions): Promise<SynthesisHandle> {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      throw new VoiceError("This browser cannot synthesise speech.", "TTS_FAILED", false);
    }

    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(options.text);
    utterance.lang = options.language || DEFAULT_LANGUAGE;
    utterance.rate = options.rate ?? 1.0;
    utterance.pitch = options.pitch ?? 1.0;

    const voices = await getAvailableVoices(synth);

    if (options.voice) {
      const match = voices.find((voice) => voice.name === options.voice);
      if (match) utterance.voice = match;
    }

    if (!utterance.voice && voices.length > 0) {
      const prefix = (utterance.lang || "en").split("-")[0].toLowerCase();
      const matchingVoices = voices.filter((v) => v.lang.toLowerCase().startsWith(prefix));

      const scoreVoice = (v: SpeechSynthesisVoice) => {
        // macOS reports the quality tier in the URI as often as in the name.
        const name = `${v.name} ${v.voiceURI}`.toLowerCase();
        for (const novelty of NOVELTY_VOICES) {
          if (name.includes(novelty)) return -1000;
        }
        if (name.includes("compact")) return -300;

        let score = 0;
        for (const legacy of LEGACY_VOICES) {
          if (name.includes(legacy)) {
            score -= 200;
            break;
          }
        }
        // Chrome built-in Google neural voices are high-quality, human-sounding and smooth
        if (name.includes("google")) {
          score += 450;
          if (name.includes("us english") || name.includes("uk english female")) score += 60;
        }
        // Apple Siri voices
        if (name.includes("siri")) score += 400;
        // Premium & enhanced Apple voices
        if (name.includes("premium")) score += 350;
        if (name.includes("enhanced")) score += 320;
        if (name.includes("natural")) score += 280;

        // Named high-quality natural voices
        if (name.includes("ava")) score += 220;
        if (name.includes("zoe")) score += 200;
        if (name.includes("samantha")) score += 180;
        if (name.includes("daniel") || name.includes("allison") || name.includes("serena")) score += 160;
        if (name.includes("karen")) score += 140;

        return score;
      };

      const pool = matchingVoices.length > 0 ? matchingVoices : voices;
      const sorted = [...pool].sort((a, b) => scoreVoice(b) - scoreVoice(a));
      if (sorted.length > 0 && scoreVoice(sorted[0]) > -500) {
        utterance.voice = sorted[0];
      }
    }

    let spokenChars = 0;
    let speaking = true;

    utterance.onstart = () => options.onStart?.();
    utterance.onboundary = (event) => {
      spokenChars = event.charIndex ?? spokenChars;
      options.onBoundary?.(spokenChars);
    };
    const finish = () => {
      if (!speaking) return;
      speaking = false;
      options.onEnd?.(spokenChars);
    };
    utterance.onend = () => {
      spokenChars = options.text.length;
      finish();
    };
    utterance.onerror = finish;

    // Chromium keeps a paused queue alive across cancels; clear it first.
    synth.cancel();
    synth.speak(utterance);

    const cancel = () => {
      if (!speaking) return;
      synth.cancel();
      finish();
    };
    options.signal?.addEventListener("abort", cancel);

    return {
      cancel,
      get speaking() {
        return speaking;
      },
    };
  }
}

function resolveLanguage(setting: LanguageSetting): string {
  // The built-in engine cannot detect; "auto" means "use the default".
  if (setting === "auto") return navigator.language || DEFAULT_LANGUAGE;
  return setting;
}
