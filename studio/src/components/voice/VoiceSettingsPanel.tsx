import React, { useEffect, useState } from "react";
import { Cpu, Globe, Languages, Zap } from "lucide-react";
import { VOICE_LANGUAGES, type ProviderCapabilities, type VoiceSettings, type VoiceTier } from "../../services/voice";
import { VoiceEnrolment } from "./VoiceEnrolment";
import { SettingGroup, SettingList, SettingRow, SettingSelect, SettingSlider, SettingToggle } from "../ui";

/**
 * Every voice control in one place, grouped by the question it answers:
 * which engine, which language, who may speak, and how much to confirm.
 */

export interface VoiceSettingsPanelProps {
  settings: VoiceSettings;
  update: (patch: Partial<VoiceSettings>) => void;
  capabilities: Record<VoiceTier, ProviderCapabilities> | null;
  activeAsrTier: VoiceTier | null;
  hasProfile: boolean;
  captureClip: (seconds?: number) => Promise<{ samples: Float32Array; sampleRate: number }>;
  finishEnrolment: (clips: Array<{ samples: Float32Array; sampleRate: number }>) => boolean;
  clearEnrolment: () => void;
  onProbe: () => void;
}


export const VoiceSettingsPanel: React.FC<VoiceSettingsPanelProps> = ({
  settings,
  update,
  capabilities,
  activeAsrTier,
  hasProfile,
  captureClip,
  finishEnrolment,
  clearEnrolment,
  onProbe,
}) => {
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const load = () => {
      const all = window.speechSynthesis.getVoices();
      const filtered = all.filter((v) => {
        const n = v.name.toLowerCase();
        return (
          !n.includes("bad news") &&
          !n.includes("bells") &&
          !n.includes("boing") &&
          !n.includes("bubbles") &&
          !n.includes("cellos") &&
          !n.includes("deranged") &&
          !n.includes("good news") &&
          !n.includes("hysterical") &&
          !n.includes("organ") &&
          !n.includes("whisper") &&
          !n.includes("zarvox") &&
          !n.includes("albert") &&
          !n.includes("fred") &&
          !n.includes("alex") &&
          !n.includes("victoria") &&
          !n.includes("wobble") &&
          !n.includes("jester") &&
          !n.includes("superstar") &&
          !n.includes("grandma") &&
          !n.includes("grandpa") &&
          !n.includes("rocko") &&
          !n.includes("compact")
        );
      });
      setAvailableVoices(filtered);
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
  }, []);
  // Apple's compact voices are what every Mac ships with, and they are the
  // robotic ones. The natural voices are a download the operator has to make.
  const hasNaturalVoice = availableVoices.some((v) =>
    /premium|enhanced|natural|google|siri|neural/i.test(`${v.name} ${v.voiceURI}`),
  );
  const voiceHint = hasNaturalVoice
    ? "Choose between Google neural voices or Apple natural voices."
    : "Only Apple's compact voices are installed. For a natural voice, download a Premium voice in System Settings › Accessibility › Read & Speak (Spoken Content on older macOS) › System Voice › Manage Voices, then restart and leave Auto or pick it here.";
  const vibe = capabilities?.vibevoice;
  const strongMatching = Boolean(vibe?.speakerEmbedding && vibe.asr && activeAsrTier === "vibevoice");

  return (
    <div className="space-y-5">
      {/* ── Engine ─────────────────────────────────────────────────────── */}
      <SettingGroup label="Engine">
        <SettingRow
          label="Speech engine"
          description={
            activeAsrTier === "vibevoice"
              ? `${vibe?.label ?? "The local engine"} is running on this machine. Audio never leaves it.`
              : activeAsrTier === "builtin"
                ? "Using the browser engine, which sends audio to its speech service."
                : (vibe?.detail ?? capabilities?.builtin.detail ?? "No speech engine is available.")
          }
        >
          <SettingSelect value={settings.tier} onChange={(event) => update({ tier: event.target.value as VoiceTier | "auto" })}>
            <option value="auto">Auto (best available)</option>
            <option value="vibevoice">{vibe?.label ?? "Local engine"}</option>
            <option value="builtin">
              {capabilities?.builtin.asr ? "Built-in (browser)" : "Built-in (unavailable here)"}
            </option>
          </SettingSelect>
        </SettingRow>

        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <span
            className={`inline-flex items-center gap-1.5 text-3xs font-mono rounded px-1.5 py-0.5 ${
              activeAsrTier === "vibevoice"
                ? "bg-success/10 text-success"
                : activeAsrTier
                  ? "bg-surface-chip text-ink-muted"
                  : "bg-danger/10 text-danger"
            }`}
          >
            {activeAsrTier === "vibevoice" ? <Cpu size={10} /> : <Globe size={10} />}
            {activeAsrTier === "vibevoice" ? "on-device" : activeAsrTier === "builtin" ? "browser" : "unavailable"}
          </span>
          <button
            type="button"
            onClick={onProbe}
            className="text-3xs text-ink-faint hover:text-ink-dim transition-colors duration-ds ease-ds"
          >
            Re-check
          </button>
        </div>
      </SettingGroup>

      {/* ── Language ───────────────────────────────────────────────────── */}
      <SettingGroup label="Language">
        <SettingRow
          label="Language"
          description={
            activeAsrTier === "vibevoice"
              ? "The local engine detects the spoken language per utterance, Kiswahili included."
              : "The browser engine cannot detect language — it uses your system language. Pick one explicitly."
          }
        >
          <SettingSelect value={settings.language} onChange={(event) => update({ language: event.target.value })}>
            <option value="auto">Detect automatically</option>
            {VOICE_LANGUAGES.map((language) => (
              <option key={language.tag} value={language.tag}>
                {language.label}
                {!language.webSpeech && activeAsrTier === "builtin" ? " — needs VibeVoice" : ""}
              </option>
            ))}
          </SettingSelect>
        </SettingRow>
      </SettingGroup>

      {/* ── Who may speak ──────────────────────────────────────────────── */}
      <SettingGroup label="Who may speak">
        <SettingRow
          label="Only respond to my voice"
          description={
            hasProfile
              ? "Speech that does not match your enrolled profile is ignored."
              // On by default, but the gate also tests `hasProfile`, so it does
              // nothing until there is a voiceprint to compare against. Saying
              // "switch this on" over a toggle already showing on read as a bug.
              : "Waiting on a voice profile — record one below and this starts working."
          }
        >
          <SettingToggle
            checked={settings.requireSpeakerMatch}
            disabled={!hasProfile}
            onChange={(value) => update({ requireSpeakerMatch: value })}
          />
        </SettingRow>

        <SettingRow
          label="Require my name"
          description="Only act on speech that starts with one of the words below. Strictest setting; use it in a busy room."
        >
          <SettingToggle checked={settings.requireWakeWord} onChange={(value) => update({ requireWakeWord: value })} />
        </SettingRow>

        {/* The words themselves were printed into the row above and could not be
            changed, which made them read like a property of the build rather
            than a choice. They are neither secret nor fixed: `addressing.ts`
            matches the front of an utterance against this list, and a name the
            recogniser mishears is worth being able to add a spelling for. */}
        <SettingRow
          label="Names it answers to"
          description="What the assistant listens for at the start of a sentence, when the setting above is on. Add the spellings speech recognition actually produces for your name — “temmy” is heard as often as “temy”."
        />
        <SettingList
          entries={settings.wakeWords}
          onChange={(wakeWords) => update({ wakeWords })}
          placeholder="temy"
          label="Add a name the assistant answers to"
          emptyNote="No names left. With none of them, “Require my name” can never match and the assistant will not answer."
          validate={(entry) =>
            /\s/.test(entry) ? "One word per entry \u2014 it is matched against the start of a sentence." : null
          }
        />

        <div className="px-3.5 py-3">
          <VoiceEnrolment
            hasProfile={hasProfile}
            strongMatching={strongMatching}
            captureClip={captureClip}
            finish={finishEnrolment}
            clear={clearEnrolment}
          />
        </div>
      </SettingGroup>

      {/* ── Conversation ───────────────────────────────────────────────── */}
      <SettingGroup label="Conversation">
        <SettingRow label="Read replies aloud" description="Applies to hands-free conversation mode only.">
          <SettingToggle checked={settings.speakReplies} onChange={(value) => update({ speakReplies: value })} />
        </SettingRow>

        <SettingRow label="Greet me when it starts" description="A short line when hands-free mode opens, so you know the microphone is live. You can talk over it.">
          <div className="flex items-center gap-2">
            <input
              value={settings.greeting}
              onChange={(event) => update({ greeting: event.target.value })}
              disabled={!settings.speakGreeting}
              maxLength={60}
              /* Wide enough to read the default greeting without scrolling it:
                 w-36 showed 144px of a 205px value, so the shipped default was
                 cut off in its own field. */
              className="lit lit-inner h-7 w-64 px-2 bg-surface-raised rounded-md text-xs text-ink-body outline-none disabled:opacity-40"
            />
            <SettingToggle checked={settings.speakGreeting} onChange={(value) => update({ speakGreeting: value })} />
          </div>
        </SettingRow>

        <SettingRow label="Narrate progress" description="While an agent run is working, say a short line when it starts something notable — “running the tests”. Never more than one every few seconds, and only when nothing else is being said.">
          <SettingToggle checked={settings.narrateProgress} onChange={(value) => update({ narrateProgress: value })} />
        </SettingRow>

        <SettingRow label="Summarise long replies" description="Read the first few sentences as they arrive, then a two-sentence spoken summary of the rest instead of the whole answer. The full text is always in the chat.">
          <SettingToggle checked={settings.summariseLongReplies} onChange={(value) => update({ summariseLongReplies: value })} />
        </SettingRow>

        <SettingRow label="Remember what it overhears" description="Speech that was not addressed to the assistant is kept for ten minutes, so you can ask “what did she just say?” — and, where the local sidecar can name sounds, “did you hear that car?”. The words are transcribed either way; naming a sound is an extra pass this switch turns on. Nothing is sent anywhere, and it is cleared whenever hands-free conversation stops.">
          <SettingToggle checked={settings.ambientMemory} onChange={(value) => update({ ambientMemory: value })} />
        </SettingRow>

        <SettingRow label="Let me interrupt" description="Talking over a spoken reply stops it immediately and starts your turn. Praise, “keep going” and “how's it going?” do not cancel a run; a new instruction or “stop” does.">
          <SettingToggle checked={settings.allowBargeIn} onChange={(value) => update({ allowBargeIn: value })} />
        </SettingRow>

        <SettingRow label="Confirm before sending" description="Show the cleaned-up text and wait for approval. Turning this off sends as soon as it is understood.">
          <SettingToggle checked={settings.confirmBeforeSend} onChange={(value) => update({ confirmBeforeSend: value })} />
        </SettingRow>

        <SettingRow
          label="Auto-send after"
          description="In conversation mode, how long the cleaned-up text waits before sending itself. Any interaction cancels it."
        >
          <SettingSelect
            value={String(settings.autoSendAfterMs)}
            onChange={(event) => update({ autoSendAfterMs: Number(event.target.value) })}
          >
            <option value="0">Never — always wait for me</option>
            <option value="1500">1.5 seconds</option>
            <option value="2500">2.5 seconds</option>
            <option value="4000">4 seconds</option>
          </SettingSelect>
        </SettingRow>

        <SettingRow label="Pause before I'm finished" description="How long a silence has to last before your turn ends. Shorter feels snappier; longer forgives thinking.">
          <SettingSelect
            value={String(settings.endpointSilenceMs)}
            onChange={(event) => update({ endpointSilenceMs: Number(event.target.value) })}
          >
            <option value="600">Snappy — 0.6s</option>
            <option value="900">Balanced — 0.9s</option>
            <option value="1400">Patient — 1.4s</option>
          </SettingSelect>
        </SettingRow>

        <SettingRow label="Voice" description={voiceHint}>
          <SettingSelect
            value={settings.ttsVoice ?? "auto"}
            onChange={(event) => update({ ttsVoice: event.target.value === "auto" ? null : event.target.value })}
          >
            <option value="auto">Natural AI (Auto-selected)</option>
            {availableVoices.map((v: SpeechSynthesisVoice) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </SettingSelect>
        </SettingRow>

        <SettingRow label="Speaking rate">
          <Zap size={11} className="text-ink-faint" />
          <SettingSlider
            label="Speaking rate"
            min={0.7}
            max={1.6}
            step={0.02}
            value={settings.ttsRate}
            onChange={(ttsRate) => update({ ttsRate })}
            format={(rate) => `${rate.toFixed(2)}×`}
          />
        </SettingRow>
      </SettingGroup>

      <section className="pt-2.5">
        <div className="flex items-start gap-2 text-3xs text-ink-disabled">
          <Languages size={12} className="flex-shrink-0 mt-px" />
          <p>
            {activeAsrTier === "vibevoice"
              ? "Transcription runs on this machine and is multilingual — say a sentence in Kiswahili and it will be recognised as Kiswahili."
              : (vibe?.detail ?? "Install whisper.cpp, or run the VibeVoice sidecar, for on-device multilingual transcription.")}
          </p>
        </div>
      </section>
    </div>
  );
};
