/** Voice subsystem — public surface. */
export * from "./types";
export { VoiceEngine, type VoiceHost, type VoiceSnapshot } from "./conversation";
export { speakableText, sanitizeOngoingAssist, smoothConversationalPunctuation } from "./speakable";
export { SpeakerProfile, type EnrolledProfile } from "./speakerProfile";
export { completenessScore } from "./turnTaking";
export { repairDeterministic, polishIsTrustworthy, cleanTranscript, isNonSpeechOrBlank } from "./transcriptRepair";
export { scoreAddressing, stripWakeWord } from "./addressing";
export { classifyTurnIntent, type TurnIntent, type TurnIntentVerdict } from "./turnIntent";
export { getImmediateAcknowledgment } from "./acknowledgment";
export { EchoGuard, stripSelfEcho } from "./echoGuard";
export { describeToolCall, summariseProgress, summariseOutcome, speakablePath, type RunProgress } from "./progressNarration";
export {
  planSpokenDigest,
  digestPrompt,
  digestSource,
  digestBudgetMs,
  tidyDigest,
  fallbackDigest,
  DigestStream,
  STREAMED_SENTENCE_LIMIT,
  DIGEST_MAX_TOKENS,
  DIGEST_TAIL_IDLE_MS,
} from "./spokenDigest";
export { createRoster, probeAll, resolve } from "./providers";
export { resolveProviders, type ResolvedProviders } from "./resolution";
export { AudioGraph, encodeWav } from "./audioGraph";
export { VoiceDirector, type VoiceDirectorOptions } from "./voiceDirector";
export { VoiceTextSync, type VoiceTextSyncOptions } from "./voiceTextSync";
