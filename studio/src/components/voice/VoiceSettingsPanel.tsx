import React, { useEffect, useState } from "react";
import { Cpu, Globe, Languages, Zap } from "lucide-react";
import { VOICE_LANGUAGES, type ProviderCapabilities, type VoiceSettings, type VoiceTier } from "../../services/voice";
import { VoiceEnrolment } from "./VoiceEnrolment";

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

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="flex items-start justify-between gap-4 py-2.5">
    <div className="min-w-0">
      <div className="text-xs text-ink-prose">{label}</div>
      {hint && <div className="text-2xs text-ink-faint mt-0.5 leading-relaxed">{hint}</div>}
    </div>
    <div className="flex-shrink-0">{children}</div>
  </div>
);

const Toggle: React.FC<{ checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }> = ({
  checked,
  onChange,
  disabled = false,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`w-9 h-5 rounded-full relative transition-colors duration-ds ease-ds disabled:opacity-35 ${
      checked ? "bg-accent" : "bg-surface-hover"
    }`}
  >
    <span
      className="absolute top-0.5 w-4 h-4 rounded-full bg-ink-high transition-[left] duration-ds ease-ds"
      style={{ left: checked ? 18 : 2 }}
    />
  </button>
);

const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = ({ className = "", ...props }) => (
  <select
    className={`lit lit-inner h-7 bg-surface-raised rounded-md px-2 text-xs text-ink-body outline-none max-w-[190px] ${className}`}
    {...props}
  />
);

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
    <div className="flex flex-col divide-y divide-edge-subtle">
      {/* ── Engine ─────────────────────────────────────────────────────── */}
      <section className="pb-1">
        <Row
          label="Speech engine"
          hint={
            activeAsrTier === "vibevoice"
              ? `${vibe?.label ?? "The local engine"} is running on this machine. Audio never leaves it.`
              : activeAsrTier === "builtin"
                ? "Using the browser engine, which sends audio to its speech service."
                : (vibe?.detail ?? capabilities?.builtin.detail ?? "No speech engine is available.")
          }
        >
          <Select value={settings.tier} onChange={(event) => update({ tier: event.target.value as VoiceTier | "auto" })}>
            <option value="auto">Auto (best available)</option>
            <option value="vibevoice">{vibe?.label ?? "Local engine"}</option>
            <option value="builtin">
              {capabilities?.builtin.asr ? "Built-in (browser)" : "Built-in (unavailable here)"}
            </option>
          </Select>
        </Row>

        <div className="flex items-center gap-2 pb-2.5">
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
      </section>

      {/* ── Language ───────────────────────────────────────────────────── */}
      <section>
        <Row
          label="Language"
          hint={
            activeAsrTier === "vibevoice"
              ? "The local engine detects the spoken language per utterance, Kiswahili included."
              : "The browser engine cannot detect language — it uses your system language. Pick one explicitly."
          }
        >
          <Select value={settings.language} onChange={(event) => update({ language: event.target.value })}>
            <option value="auto">Detect automatically</option>
            {VOICE_LANGUAGES.map((language) => (
              <option key={language.tag} value={language.tag}>
                {language.label}
                {!language.webSpeech && activeAsrTier === "builtin" ? " — needs VibeVoice" : ""}
              </option>
            ))}
          </Select>
        </Row>
      </section>

      {/* ── Who may speak ──────────────────────────────────────────────── */}
      <section>
        <Row
          label="Only respond to my voice"
          hint={
            hasProfile
              ? "Speech that does not match your enrolled profile is ignored."
              : "Record a voice profile below to switch this on."
          }
        >
          <Toggle
            checked={settings.requireSpeakerMatch}
            disabled={!hasProfile}
            onChange={(value) => update({ requireSpeakerMatch: value })}
          />
        </Row>

        <Row
          label="Require my name"
          hint={`Only act on speech that starts with ${settings.wakeWords.map((word) => `“${word}”`).join(", ")}. Strictest setting; use it in a busy room.`}
        >
          <Toggle checked={settings.requireWakeWord} onChange={(value) => update({ requireWakeWord: value })} />
        </Row>

        <div className="pb-3 pt-1">
          <VoiceEnrolment
            hasProfile={hasProfile}
            strongMatching={strongMatching}
            captureClip={captureClip}
            finish={finishEnrolment}
            clear={clearEnrolment}
          />
        </div>
      </section>

      {/* ── Conversation ───────────────────────────────────────────────── */}
      <section>
        <Row label="Read replies aloud" hint="Applies to hands-free conversation mode only.">
          <Toggle checked={settings.speakReplies} onChange={(value) => update({ speakReplies: value })} />
        </Row>

        <Row label="Greet me when it starts" hint="A short line when hands-free mode opens, so you know the microphone is live. You can talk over it.">
          <div className="flex items-center gap-2">
            <input
              value={settings.greeting}
              onChange={(event) => update({ greeting: event.target.value })}
              disabled={!settings.speakGreeting}
              maxLength={60}
              className="lit lit-inner h-7 w-36 px-2 bg-surface-raised rounded-md text-xs text-ink-body outline-none disabled:opacity-40"
            />
            <Toggle checked={settings.speakGreeting} onChange={(value) => update({ speakGreeting: value })} />
          </div>
        </Row>

        <Row label="Narrate progress" hint="While an agent run is working, say a short line when it starts something notable — “running the tests”. Never more than one every few seconds, and only when nothing else is being said.">
          <Toggle checked={settings.narrateProgress} onChange={(value) => update({ narrateProgress: value })} />
        </Row>

        <Row label="Summarise long replies" hint="Read the first few sentences as they arrive, then a two-sentence spoken summary of the rest instead of the whole answer. The full text is always in the chat.">
          <Toggle checked={settings.summariseLongReplies} onChange={(value) => update({ summariseLongReplies: value })} />
        </Row>

        <Row label="Remember what it overhears" hint="Speech that was not addressed to the assistant is kept for ten minutes, so you can ask “what did she just say?” — and, where the local sidecar can name sounds, “did you hear that car?”. The words are transcribed either way; naming a sound is an extra pass this switch turns on. Nothing is sent anywhere, and it is cleared whenever hands-free conversation stops.">
          <Toggle checked={settings.ambientMemory} onChange={(value) => update({ ambientMemory: value })} />
        </Row>

        <Row label="Let me interrupt" hint="Talking over a spoken reply stops it immediately and starts your turn. Praise, “keep going” and “how's it going?” do not cancel a run; a new instruction or “stop” does.">
          <Toggle checked={settings.allowBargeIn} onChange={(value) => update({ allowBargeIn: value })} />
        </Row>

        <Row label="Confirm before sending" hint="Show the cleaned-up text and wait for approval. Turning this off sends as soon as it is understood.">
          <Toggle checked={settings.confirmBeforeSend} onChange={(value) => update({ confirmBeforeSend: value })} />
        </Row>

        <Row
          label="Auto-send after"
          hint="In conversation mode, how long the cleaned-up text waits before sending itself. Any interaction cancels it."
        >
          <Select
            value={String(settings.autoSendAfterMs)}
            onChange={(event) => update({ autoSendAfterMs: Number(event.target.value) })}
          >
            <option value="0">Never — always wait for me</option>
            <option value="1500">1.5 seconds</option>
            <option value="2500">2.5 seconds</option>
            <option value="4000">4 seconds</option>
          </Select>
        </Row>

        <Row label="Pause before I'm finished" hint="How long a silence has to last before your turn ends. Shorter feels snappier; longer forgives thinking.">
          <Select
            value={String(settings.endpointSilenceMs)}
            onChange={(event) => update({ endpointSilenceMs: Number(event.target.value) })}
          >
            <option value="600">Snappy — 0.6s</option>
            <option value="900">Balanced — 0.9s</option>
            <option value="1400">Patient — 1.4s</option>
          </Select>
        </Row>

        <Row label="Voice" hint={voiceHint}>
          <Select
            value={settings.ttsVoice ?? "auto"}
            onChange={(event) => update({ ttsVoice: event.target.value === "auto" ? null : event.target.value })}
          >
            <option value="auto">Natural AI (Auto-selected)</option>
            {availableVoices.map((v: SpeechSynthesisVoice) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </Select>
        </Row>

        <Row label="Speaking rate">
          <div className="flex items-center gap-2">
            <Zap size={11} className="text-ink-faint" />
            <input
              type="range"
              min={0.7}
              max={1.6}
              step={0.02}
              value={settings.ttsRate}
              onChange={(event) => update({ ttsRate: Number(event.target.value) })}
              className="w-24 accent-[var(--accent)]"
            />
            <span className="font-mono text-3xs text-ink-faint w-8">{settings.ttsRate.toFixed(2)}×</span>
          </div>
        </Row>
      </section>

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
