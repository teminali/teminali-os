/**
 * Provider negotiation.
 *
 * Two tiers, probed at startup and re-probed whenever the operator changes the
 * setting. The rule is simple: prefer VibeVoice when it is actually running,
 * fall back to the browser engine when it is not, and never leave the operator
 * with a dead microphone because a sidecar was missing.
 *
 * Tiers can be split across capabilities. It is normal to have VibeVoice for
 * recognition (better Kiswahili, real language detection) while still using the
 * browser for synthesis, or the reverse. `resolve` returns the best provider
 * for each job independently rather than picking one for both.
 */

import type { ProviderCapabilities, VoiceProvider, VoiceTier } from "../types";
import { resolveProviders, type ResolvedProviders } from "../resolution";
import { WebSpeechProvider } from "./webSpeech";
import { VibeVoiceProvider } from "./vibeVoice";

export { WebSpeechProvider, VibeVoiceProvider };

export interface ProviderRoster {
  builtin: WebSpeechProvider;
  vibevoice: VibeVoiceProvider;
}

export type { ResolvedProviders };

export function createRoster(): ProviderRoster {
  return { builtin: new WebSpeechProvider(), vibevoice: new VibeVoiceProvider() };
}

export async function probeAll(roster: ProviderRoster, signal?: AbortSignal): Promise<Record<VoiceTier, ProviderCapabilities>> {
  // Probe together — the sidecar check is a network round trip and there is no
  // reason to make the operator wait for it serially.
  const [builtin, vibevoice] = await Promise.all([
    roster.builtin.probe(),
    roster.vibevoice.probe(signal),
  ]);
  return { builtin, vibevoice };
}

export function resolve(
  roster: ProviderRoster,
  capabilities: Record<VoiceTier, ProviderCapabilities>,
  preferred: VoiceTier | "auto",
): ResolvedProviders {
  return resolveProviders(
    roster as unknown as Record<VoiceTier, VoiceProvider>,
    capabilities,
    preferred,
  );
}
