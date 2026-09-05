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

/**
 * A non-speech event the sidecar's classifier named in the clip: a car, a
 * knock, a phone. `label` is the raw AudioSet class, kept because it is the
 * thing that can be reasoned about; `sound` is how to say it out loud.
 */
export interface AmbientSound {
  label: string;
  sound: string;
  /** 0-1 from the classifier. */
  confidence: number;
}

export interface RecognitionResult {
  /** Best transcript for the utterance so far. */
  transcript: string;
  /** True once the engine will not revise this span again. */
  isFinal: boolean;
  /**
   * 0–1 where the engine reports it; -1 when it does not.
   *
   * The weaker of the two components below, not their average: the recogniser
   * must be sure both that this was speech in a language it knows and of the
   * words it then chose, and averaging lets a confident transcription of an
   * empty room pass. See DESIGN.md §6.12 for the measurements behind it.
   */
  confidence: number;
  /**
   * How sure the engine was that this was the language it picked — the signal
   * that actually separates speech from a room (measured: 0.37–0.81 across
   * silence, noise and music; 0.96–1.00 across speech). -1 when unreported,
   * which is always the case on the whisper-cli fallback and the sidecar.
   */
  languageConfidence?: number;
  /**
   * Mean per-word probability. A much weaker signal than it looks: silence
   * transcribed as "Thank you." scores 0.73 here. -1 when unreported.
   */
  acousticConfidence?: number;
  /** Detected (or configured) BCP-47 tag for this utterance. */
  language: string;
  /** Non-speech sounds in the same clip, when they were asked for. */
  sounds?: AmbientSound[];
}

export interface RecognitionOptions {
  language: LanguageSetting;
  /** Keep the stream open across utterances — the hands-free case. */
  continuous: boolean;
  /** Emit partial hypotheses as they arrive. */
  interim: boolean;
  /** Domain words the recogniser should bias toward (filenames, symbols). */
  hints?: string[];
  /**
   * Also name the non-speech sounds in each clip. Off by default and driven by
   * the ambient-memory setting: labelling the room is a second model per clip,
   * and an operator who has turned the ambient log off must not pay for it.
   */
  sounds?: boolean;
  signal?: AbortSignal;
}

export interface RecognitionHandlers {
  onResult: (result: RecognitionResult) => void;
  /**
   * Non-speech sounds heard in the clip. Separate from `onResult` on purpose:
   * a passing car produces no transcript at all, so folding it into a result
   * would push an empty utterance through the endpointer and the addressing
   * gate. This is an observation about the room, not a turn.
   */
  onSound?: (sounds: AmbientSound[]) => void;
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
  /**
   * Chunked engines only. Close the slice being recorded now and deliver the
   * utterance so far as one final result, without stopping the session. The
   * endpointer calls it the moment a turn ends, so the tail of the sentence is
   * not left waiting for the next slice boundary (or lost to the next turn).
   */
  flush?: () => void;
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
  /** Real-time speech playback amplitude for mouth sync modulation (0–1). */
  onAudioLevel?: (level: number) => void;
  signal?: AbortSignal;
}

/**
 * Emotional & expressive posture of the Teminali character face.
 */
export type VoiceEmotion =
  | "neutral"
  | "happy"
  | "thinking"
  | "focused"
  | "surprised"
  | "error"
  | "speaking"
  | "listening"
  | "relaxed";

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
  /** Names non-speech sounds ("a car", "a knock") alongside the transcript. */
  soundLabels: boolean;
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
  /*
    "temi" is here because that is what recognition actually returns. Measured
    on this machine with whisper large-v3-turbo: "Temy" comes back as "Temi"
    whether or not the decoder is given the spelling in its prompt, and the
    lexicon cannot repair it — `phoneticKey` reduces "Temy", "Temi", "Timmy"
    and "Tammy" all to "tm", which is below `MIN_KEY_LENGTH` precisely so a
    repair cannot rewrite somebody's name. A wake word list is the right place
    for "what the recogniser produces" rather than "how the word is spelt".
  */
  wakeWords: ["temy", "temi", "teminali", "frontier", "studio"],
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

/* ────────────────────────────────────────────────────────────────────────────
   Turn origin
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Where the words in a chat turn came from.
 *
 * A typed turn is what the operator meant, character for character. A spoken
 * one is a recogniser's best guess at it, and the two must not be read the
 * same way — see `VOICE_TRANSCRIPT_NOTICE`.
 */
export type TurnOrigin = "text" | "voice";

/** What the host learns about an utterance beyond its words. */
export interface SubmitOptions {
  origin: TurnOrigin;
}

/**
 * What the model is told when the turn it is reading was heard, not typed.
 *
 * Written after a real session: the recogniser heard a folder name that does
 * not exist, the agent ran `du -sh` on it, got "No such file or directory",
 * and answered "it does not exist, please verify" without ever listing the
 * directory it had just been standing in. The transcript was wrong; the answer
 * was worse. Kept to a handful of lines because Flash runs an 8k window.
 */
export const VOICE_TRANSCRIPT_NOTICE = `[SPOKEN TURN — THIS MESSAGE IS A TRANSCRIPT]
The user spoke this; speech recognition wrote it down and may have got words wrong, especially proper nouns, file and directory names, paths, commands and technical identifiers. Treat the words as approximate and the intent as exact.
When a name you were given is not found, look at what IS there before you say anything: list the directory, or search the workspace. Then either act on the obvious near-match, saying which name you used, or ask one specific question naming the candidates you found.
Never end a turn with "it does not exist, please verify the name" — that is a transcription error report, not an answer, and you have the shell to check.`;

/** The prompt fragment for a turn of this origin. Empty for anything typed. */
export function transcriptNotice(origin: TurnOrigin | undefined): string {
  return origin === "voice" ? `\n\n${VOICE_TRANSCRIPT_NOTICE}` : "";
}
