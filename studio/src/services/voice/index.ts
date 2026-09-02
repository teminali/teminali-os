/** Voice subsystem — public surface. */
export * from "./types";
export { VoiceEngine, type VoiceHost, type VoiceSnapshot } from "./conversation";
export { speakableText } from "./speakable";
export { SpeakerProfile, type EnrolledProfile } from "./speakerProfile";
export { completenessScore } from "./turnTaking";
export { repairDeterministic, polishIsTrustworthy } from "./transcriptRepair";
export { scoreAddressing, stripWakeWord } from "./addressing";
export { createRoster, probeAll, resolve } from "./providers";
export { resolveProviders, type ResolvedProviders } from "./resolution";
export { AudioGraph, encodeWav } from "./audioGraph";
