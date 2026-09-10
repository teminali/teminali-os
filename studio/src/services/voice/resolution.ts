/**
 * Which provider serves which job.
 *
 * Kept free of imports so it can be reasoned about — and tested — without
 * constructing a recogniser or touching a microphone. The rule it encodes is
 * the one that matters most in the desktop build: recognition and synthesis are
 * chosen *independently*, because the browser can usually speak even where it
 * cannot listen, and forcing both onto one tier would give up a working half.
 */

import type { ProviderCapabilities, VoiceProvider, VoiceTier } from "./types";

export interface ResolvedProviders {
  asr: VoiceProvider | null;
  tts: VoiceProvider | null;
  asrTier: VoiceTier | null;
  ttsTier: VoiceTier | null;
  capabilities: Record<VoiceTier, ProviderCapabilities>;
  /** Set when the requested tier could not serve and another one did. */
  downgradedFrom?: VoiceTier;
  downgradeReason?: string;
}

export function resolveProviders(
  roster: Record<VoiceTier, VoiceProvider | Record<string, never>>,
  capabilities: Record<VoiceTier, ProviderCapabilities>,
  preferred: VoiceTier | "auto",
): ResolvedProviders {
  // For ASR on auto mode, prioritize built-in real-time streaming recognition (0ms latency, no silence hallucinations).
  // For TTS, prioritize VibeVoice / high-fidelity natural speech.
  const asrOrder: VoiceTier[] =
    preferred === "vibevoice" ? ["vibevoice", "builtin"] : ["builtin", "vibevoice"];
  const ttsOrder: VoiceTier[] =
    preferred === "builtin" ? ["builtin", "vibevoice"] : ["vibevoice", "builtin"];

  const pick = (job: "asr" | "tts"): { provider: VoiceProvider | null; tier: VoiceTier | null } => {
    const order = job === "asr" ? asrOrder : ttsOrder;
    for (const tier of order) {
      if (capabilities[tier]?.[job]) return { provider: roster[tier] as VoiceProvider, tier };
    }
    return { provider: null, tier: null };
  };

  const asr = pick("asr");
  const tts = pick("tts");

  const wanted = preferred === "auto" ? null : preferred;
  const downgraded = wanted !== null && asr.tier !== null && asr.tier !== wanted;

  return {
    asr: asr.provider,
    tts: tts.provider,
    asrTier: asr.tier,
    ttsTier: tts.tier,
    capabilities,
    ...(downgraded
      ? {
          downgradedFrom: wanted,
          downgradeReason:
            capabilities[wanted]?.detail ?? `The ${wanted} tier cannot handle recognition here.`,
        }
      : {}),
  };
}
