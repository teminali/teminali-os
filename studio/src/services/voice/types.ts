/**
 * Voice subsystem — shared contracts.
 *
 * The design goal is a hands-free conversation that behaves the way a person
 * does: it listens continuously, works out whether it was actually addressed,
 * lets you cut in mid-sentence, and never puts words in the chat that you did
 * not approve. Every one of those is a separate, testable concern, and this
 * file is the seam between them.
 */

/* ────────────────────────────────────────────────────────────────────────────
   Languages
   ──────────────────────────────────────────────────────────────────────────── */

export interface VoiceLanguage {
  /** BCP-47 tag handed to the recogniser. */
  tag: string;
  /** Endonym — what speakers of the language call it. */
  label: string;
  /** English name, for search. */
  english: string;
  /** Whether the built-in Web Speech engine is known to accept the tag. */
  webSpeech: boolean;
}

/**
 * The shipped language list. `auto` is not a tag — it asks the provider to
 * detect, which only the VibeVoice tier can genuinely do; the built-in tier
 * falls back to the preferred tag.
 */
export const VOICE_LANGUAGES: VoiceLanguage[] = [
  { tag: "sw-TZ", label: "Kiswahili (Tanzania)", english: "Swahili (Tanzania)", webSpeech: true },
  { tag: "sw-KE", label: "Kiswahili (Kenya)", english: "Swahili (Kenya)", webSpeech: true },
  { tag: "en-US", label: "English (US)", english: "English (US)", webSpeech: true },
  { tag: "en-GB", label: "English (UK)", english: "English (UK)", webSpeech: true },
  { tag: "ar-SA", label: "العربية", english: "Arabic", webSpeech: true },
  { tag: "zh-CN", label: "中文 (简体)", english: "Chinese (Simplified)", webSpeech: true },
  { tag: "nl-NL", label: "Nederlands", english: "Dutch", webSpeech: true },
  { tag: "fr-FR", label: "Français", english: "French", webSpeech: true },
  { tag: "de-DE", label: "Deutsch", english: "German", webSpeech: true },
  { tag: "hi-IN", label: "हिन्दी", english: "Hindi", webSpeech: true },
  { tag: "it-IT", label: "Italiano", english: "Italian", webSpeech: true },
  { tag: "ja-JP", label: "日本語", english: "Japanese", webSpeech: true },
  { tag: "ko-KR", label: "한국어", english: "Korean", webSpeech: true },
  { tag: "pt-BR", label: "Português (Brasil)", english: "Portuguese (Brazil)", webSpeech: true },
  { tag: "ru-RU", label: "Русский", english: "Russian", webSpeech: true },
  { tag: "es-ES", label: "Español", english: "Spanish", webSpeech: true },
  { tag: "tr-TR", label: "Türkçe", english: "Turkish", webSpeech: true },
  { tag: "am-ET", label: "አማርኛ", english: "Amharic", webSpeech: false },
  { tag: "yo-NG", label: "Yorùbá", english: "Yoruba", webSpeech: false },
  { tag: "ha-NG", label: "Hausa", english: "Hausa", webSpeech: false },
  { tag: "ig-NG", label: "Igbo", english: "Igbo", webSpeech: false },
  { tag: "zu-ZA", label: "isiZulu", english: "Zulu", webSpeech: false },
  { tag: "af-ZA", label: "Afrikaans", english: "Afrikaans", webSpeech: true },
  { tag: "so-SO", label: "Soomaali", english: "Somali", webSpeech: false },
  { tag: "rw-RW", label: "Kinyarwanda", english: "Kinyarwanda", webSpeech: false },
  { tag: "lg-UG", label: "Luganda", english: "Luganda", webSpeech: false },
];

export const DEFAULT_LANGUAGE = "en-US";

/** `auto` asks the provider to identify the language per utterance. */
export type LanguageSetting = string | "auto";

/* ────────────────────────────────────────────────────────────────────────────
   Recognition
   ──────────────────────────────────────────────────────────────────────────── */

export interface RecognitionResult {
  /** Best transcript for the utterance so far. */
  transcript: string;
  /** True once the engine will not revise this span again. */
  isFinal: boolean;
  /** 0–1 where the engine reports it; -1 when it does not. */
  confidence: number;
  /** Detected (or configured) BCP-47 tag for this utterance. */
  language: string;
}

export interface RecognitionOptions {
  language: LanguageSetting;
  /** Keep the stream open across utterances — the hands-free case. */
  continuous: boolean;
  /** Emit partial hypotheses as they arrive. */
  interim: boolean;
  /** Domain words the recogniser should bias toward (filenames, symbols). */
  hints?: string[];
  signal?: AbortSignal;
}

export interface RecognitionHandlers {
  onResult: (result: RecognitionResult) => void;
  /** The engine believes the speaker has stopped. Advisory, not authoritative. */
  onSpeechEnd?: () => void;
  onError?: (error: VoiceError) => void;
  /** Fired when the provider closes the stream for any reason. */
  onClose?: () => void;
}

export interface RecognitionSession {
  stop: () => void;
  /** Abandon without waiting for a final result. */
  abort: () => void;
  readonly active: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
   Synthesis
   ──────────────────────────────────────────────────────────────────────────── */

export interface SpeakOptions {
  text: string;
  language: string;
  voice?: string;
  rate?: number;
  pitch?: number;
  /**
   * Called as speech crosses each word boundary, with the character offset
   * reached. This is what makes a clean barge-in possible: when the user cuts
   * in, we know exactly how much of the reply was actually heard.
   */
  onBoundary?: (charIndex: number) => void;
  onStart?: () => void;
  onEnd?: (spokenChars: number) => void;
  signal?: AbortSignal;
}

export interface SynthesisHandle {
  /** Stop immediately. Resolves the speak() promise with what was spoken. */
  cancel: () => void;
  readonly speaking: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
   Providers
   ──────────────────────────────────────────────────────────────────────────── */

export type VoiceTier = "builtin" | "vibevoice";

export interface ProviderCapabilities {
  tier: VoiceTier;
  label: string;
  /** Speech-to-text available. */
  asr: boolean;
  /** Text-to-speech available. */
  tts: boolean;
  /** Can identify the spoken language without being told. */
  languageDetection: boolean;
  /** Emits partial transcripts mid-utterance. */
  streamingAsr: boolean;
  /** Begins audio before the full text is known. */
  streamingTts: boolean;
  /** Returns a per-utterance speaker embedding for addressee gating. */
  speakerEmbedding: boolean;
  languages: string[];
  /** Why the tier is unavailable, when it is. */
  detail?: string;
}

export interface VoiceProvider {
  readonly capabilities: ProviderCapabilities;
  /** Cheap liveness probe. Never throws; returns the reason instead. */
  probe(signal?: AbortSignal): Promise<ProviderCapabilities>;
  listen(options: RecognitionOptions, handlers: RecognitionHandlers): Promise<RecognitionSession>;
  speak(options: SpeakOptions): Promise<SynthesisHandle>;
  /** Transcribe a finished buffer. Used for the repair pass and re-scoring. */
  transcribeBlob?(blob: Blob, language: LanguageSetting, signal?: AbortSignal): Promise<RecognitionResult>;
}

/* ────────────────────────────────────────────────────────────────────────────
   Errors
   ──────────────────────────────────────────────────────────────────────────── */

export type VoiceErrorCode =
  | "MIC_DENIED"
  | "MIC_UNAVAILABLE"
  | "NO_PROVIDER"
  | "ASR_FAILED"
  | "TTS_FAILED"
  | "NETWORK"
  | "LANGUAGE_UNSUPPORTED"
  | "ABORTED";

export class VoiceError extends Error {
  readonly code: VoiceErrorCode;
  readonly recoverable: boolean;

  constructor(message: string, code: VoiceErrorCode, recoverable = true) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Conversation state machine
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * `idle`      — mic closed.
 * `listening` — mic open, nothing but room tone.
 * `hearing`   — speech detected, transcribing.
 * `deciding`  — utterance ended; working out if it was addressed to us.
 * `repairing` — cleaning the transcript before it can reach the chat.
 * `review`    — waiting for the operator to approve (or the auto-send timer).
 * `sending`   — handed to the chat engine.
 * `thinking`  — engine is generating.
 * `speaking`  — reading the reply back, mic still open for barge-in.
 */
export type VoiceState =
  | "idle"
  | "listening"
  | "hearing"
  | "deciding"
  | "repairing"
  | "review"
  | "sending"
  | "thinking"
  | "speaking";

export type VoiceMode =
  /** Hold the button, talk, release. One shot into the composer. */
  | "push-to-talk"
  /** Hands-free. Continuous listening, automatic turn-taking, spoken replies. */
  | "conversation";

/** Why an utterance was accepted or dropped — surfaced so it is never a mystery. */
export interface AddressingVerdict {
  directed: boolean;
  confidence: number;
  /** Human-readable, shown in the HUD. */
  reason: string;
  signals: {
    wakeWord: boolean;
    speakerMatch: number | null;
    followUpWindow: boolean;
    classifier: number | null;
    imperative: boolean;
  };
}

export interface RepairedTranscript {
  raw: string;
  repaired: string;
  language: string;
  /** Per-edit record so the operator can see exactly what changed. */
  edits: Array<{ from: string; to: string; kind: RepairKind }>;
  /** True when the repair pass changed nothing. */
  clean: boolean;
  /** Set when the utterance was translated into the workspace language. */
  translatedFrom?: string;
}

export type RepairKind =
  | "filler"
  | "punctuation"
  | "capitalisation"
  | "code-term"
  | "path"
  | "command"
  | "model"
  | "duplicate"
  | "translation";

export interface VoiceSettings {
  enabled: boolean;
  mode: VoiceMode;
  tier: VoiceTier | "auto";
  language: LanguageSetting;
  /** Read replies aloud in conversation mode. */
  speakReplies: boolean;
  /** Require an explicit approval tap before anything reaches the chat. */
  confirmBeforeSend: boolean;
  /** Grace period before an unconfirmed utterance auto-sends, ms. 0 disables. */
  autoSendAfterMs: number;
  /** Only accept speech that matches the enrolled voice profile. */
  requireSpeakerMatch: boolean;
  /** Only accept speech addressed to the assistant by name. */
  requireWakeWord: boolean;
  wakeWords: string[];
  /** Silence that ends a turn, ms. */
  endpointSilenceMs: number;
  /** Let the operator talk over a spoken reply. */
  allowBargeIn: boolean;
  /** Say a short line when an agent run starts something notable — "running the tests". */
  narrateProgress: boolean;
  /** Read the first few sentences of a long reply, then a spoken summary of the rest. */
  summariseLongReplies: boolean;
  ttsVoice: string | null;
  ttsRate: number;
  /** Spoken when hands-free conversation starts, so you know it is listening. */
  greeting: string;
  speakGreeting: boolean;
  /**
   * Keep what the addressing gate rejected, so "what did she just say?" has an
   * answer. Bounded to `AMBIENT_WINDOW_MS`, never sent anywhere, and cleared
   * whenever hands-free conversation stops.
   */
  ambientMemory: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: true,
  mode: "conversation",
  tier: "auto",
  language: "auto",
  speakReplies: true,
  confirmBeforeSend: false,
  autoSendAfterMs: 0,
  requireSpeakerMatch: false,
  requireWakeWord: false,
  wakeWords: ["temy", "teminali", "frontier", "studio"],
  endpointSilenceMs: 900,
  allowBargeIn: true,
  narrateProgress: true,
  summariseLongReplies: true,
  ttsVoice: null,
  ttsRate: 1.15,
  greeting: "Hey! What are we building today?",
  speakGreeting: true,
  ambientMemory: true,
};
