import React, { useCallback, useEffect, useState } from "react";
import { Cpu, Globe, Languages, Radio, Zap } from "lucide-react";
import { VOICE_LANGUAGES, type ProviderCapabilities, type VoiceSettings, type VoiceTier } from "../../services/voice";
import { describeGeminiLive, fetchGeminiLiveToken } from "../../services/voice/geminiLiveToken";
import { VoiceEnrolment } from "./VoiceEnrolment";
import { SettingGroup, SettingList, SettingRow, SettingSelect, SettingSlider, SettingToggle } from "../ui";

/**
 * Every voice control in one place, grouped by the question it answers:
 * which engine, which language, who may speak, and how much to confirm.
 *
 * There are TWO voice lanes in this app and this pane governs both, which is
 * the thing its copy got wrong for a whole release. Saying which lane a
 * control reaches is not pedantry here, it is the difference between a true
 * privacy claim and a false one:
 *
 *   1. Temi's live conversation. `components/voice/TemiVoiceStage.tsx` driving
 *      `services/voice/geminiLiveEngine.ts`, mounted by `chat/StudioChat.tsx`.
 *      A Gemini Live socket: microphone audio is streamed to Google. It reads
 *      exactly ONE key out of `VoiceSettings`, `wakeWords`, at
 *      TemiVoiceStage.tsx:517. Nothing else on this page reaches it.
 *   2. Dictation and hands-free. `services/voice/conversation.ts` through
 *      `hooks/useVoice.ts`, started from the composer's microphone. It reads
 *      every other key on this page, and its recognition can be on-device.
 *
 * So a control's description says which lane it moves. A row that claimed to
 * govern "the assistant" while only reaching lane 2 read as a guarantee about
 * Temi that the code does not make.
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

/**
 * What the last credential check found.
 *
 * Deliberately on demand rather than on mount. Each check asks the gateway to
 * mint a real ephemeral token, and a token is single use, so a check that ran
 * every time the pane opened would spend one to tell the operator nothing they
 * asked for. `fetchGeminiLiveToken` never throws, so there is no error branch
 * beyond the failure value it returns.
 */
type LiveLaneCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ready"; model: string; voice: string }
  | { state: "blocked"; detail: string };

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
  const [liveLane, setLiveLane] = useState<LiveLaneCheck>({ state: "idle" });

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

  /* The model and the voice are not hardcoded here. The gateway mints the
     token for a specific model and names the voice it wants used, and that is
     what the session actually runs, so the pane reports what came back rather
     than a constant that can drift out of agreement with `server/gateway.js`. */
  const checkLiveLane = useCallback(async () => {
    setLiveLane({ state: "checking" });
    const result = await fetchGeminiLiveToken();
    if (result.ok) {
      setLiveLane({ state: "ready", model: result.model, voice: result.voice });
      return;
    }
    setLiveLane({ state: "blocked", detail: describeGeminiLive(result) });
  }, []);

  // Apple's compact voices are what every Mac ships with, and they are the
  // robotic ones. The natural voices are a download the operator has to make.
  const hasNaturalVoice = availableVoices.some((v) =>
    /premium|enhanced|natural|google|siri|neural/i.test(`${v.name} ${v.voiceURI}`),
  );
  const voiceHint = hasNaturalVoice
    ? "Choose between Google neural voices or Apple natural voices. This is the dictation lane's voice, not Temi's."
    : "Only Apple's compact voices are installed. For a natural voice, download a Premium voice in System Settings › Accessibility › Read & Speak (Spoken Content on older macOS) › System Voice › Manage Voices, then restart and leave Auto or pick it here. This is the dictation lane's voice, not Temi's.";
  const vibe = capabilities?.vibevoice;
  const strongMatching = Boolean(vibe?.speakerEmbedding && vibe.asr && activeAsrTier === "vibevoice");

  return (
    <div className="space-y-5">
      {/* ── Temi's live conversation ────────────────────────────────────────
          Statements, not controls. Every capability listed here is real and
          none of it is configurable from this pane, so a toggle would be a
          lie with a hit area. The one control is a credential check, because
          "can Temi connect at all" is the single question this page could not
          answer before. */}
      <SettingGroup
        label="Temi, the live conversation"
        description="The assistant you talk to in the chat. She runs on Google's Gemini Live service, not on this machine."
      >
        <SettingRow
          label="Where Temi runs"
          description={
            liveLane.state === "ready"
              ? `Ready. The gateway minted a session token for ${liveLane.model || "the configured Live model"}, speaking as ${liveLane.voice || "the configured voice"}. While she is listening, your microphone audio is streamed to Google, and her reply comes back as audio. This lane does not work offline.`
              : liveLane.state === "blocked"
                ? liveLane.detail
                : "Temi needs a Google Gemini API key, set in Provider Settings or as GEMINI_API_KEY. The local gateway holds the key and mints a single-use session token for the app, so the key itself stays out of the window. While she is listening, your microphone audio is streamed to Google, and her reply comes back as audio. This lane does not work offline."
          }
        >
          <button
            type="button"
            onClick={() => void checkLiveLane()}
            disabled={liveLane.state === "checking"}
            className="h-7 px-2.5 rounded-md bg-surface-raised text-2xs text-ink-body hover:text-ink-high disabled:opacity-40 transition-colors duration-ds ease-ds"
          >
            {liveLane.state === "checking" ? "Checking…" : "Check"}
          </button>
        </SettingRow>

        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <span
            className={`inline-flex items-center gap-1.5 text-3xs font-mono rounded px-1.5 py-0.5 ${
              liveLane.state === "ready"
                ? "bg-success/10 text-success"
                : liveLane.state === "blocked"
                  ? "bg-danger/10 text-danger"
                  : "bg-surface-chip text-ink-muted"
            }`}
          >
            <Radio size={10} />
            {liveLane.state === "ready" ? "cloud, ready" : liveLane.state === "blocked" ? "cloud, blocked" : "cloud"}
          </span>
          <span className="text-3xs text-ink-faint">Audio leaves this machine on this lane.</span>
        </div>

        <SettingRow
          label="While the app is playing sound"
          description="A video in Files, a page in Browser, or your own footage on the timeline all reach the microphone as real speech, so Temi ignores anything that does not start with one of her names below. One exemption: with a player pane open, a bare “pause”, “play” or “play/pause” is accepted without her name. Seek, volume, mute, fullscreen, speed, subtitles and everything else still need it, so the worst a film can do is pause or resume itself."
        />

        {/* Only what the path actually carries. An earlier draft of this row
            said a bare "switch to Claude Code" picks the assistant; it does
            not on this lane, because `machineAction.ts` has no engine-switch
            pattern, so the turn routes as conversation and never reaches
            `interceptAside`. Naming the assistant INSIDE a task does work:
            `delegateTask` reads it off the prompt at teminaliAgentBridge.ts:379. */}
        <SettingRow
          label="When she hands work over"
          description="Temi has no filesystem and no shell of her own. Anything that needs a file read, a command run, this machine inspected or the web searched is passed to the Teminali OS assistant, and she says a short line while it works. Naming an assistant inside the task, “Claude Code, run the tests”, decides who runs it; Codex, Frontier and Frontier Max are the others. Say “mute” to send her quiet and “stop” to end a run."
        />
      </SettingGroup>

      {/* ── Speech recognition (dictation lane) ─────────────────────────────
          This section is about ASR for lane 2 only. It used to be titled
          "Engine" and read as though it chose the engine behind the whole
          feature, which put an "audio never leaves it" claim on a page whose
          headline lane streams audio to Google. */}
      <SettingGroup
        label="Speech recognition"
        description="Which recogniser transcribes dictation and hands-free turns from the composer. It has no bearing on Temi, who does her own listening."
      >
        <SettingRow
          label="Speech engine"
          description={
            activeAsrTier === "vibevoice"
              ? `${vibe?.label ?? "The local engine"} is running on this machine. Dictation audio never leaves it.`
              : activeAsrTier === "builtin"
                ? "Using the browser engine, which sends dictation audio to its speech service."
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
      <SettingGroup
        label="Language"
        description="Dictation and hands-free only. Temi detects the spoken language herself and is not told one from here."
      >
        <SettingRow
          label="Language"
          description={
            activeAsrTier === "vibevoice"
              ? "The local engine detects the spoken language per utterance, Kiswahili included."
              : "The browser engine cannot detect language, it uses your system language. Pick one explicitly."
          }
        >
          <SettingSelect value={settings.language} onChange={(event) => update({ language: event.target.value })}>
            <option value="auto">Detect automatically</option>
            {VOICE_LANGUAGES.map((language) => (
              <option key={language.tag} value={language.tag}>
                {language.label}
                {!language.webSpeech && activeAsrTier === "builtin" ? " (needs VibeVoice)" : ""}
              </option>
            ))}
          </SettingSelect>
        </SettingRow>
      </SettingGroup>

      {/* ── Who may speak ──────────────────────────────────────────────────
          The two toggles reach lane 2 and only lane 2: TemiVoiceStage.tsx
          passes `requireWakeWord: false`, `requireSpeakerMatch: false` and
          `hasProfile: false` into `scoreAddressing` as literals. The names
          list is the one thing on this page both lanes read. */}
      <SettingGroup
        label="Who may speak"
        description="These two switches gate dictation and hands-free turns. Temi's own gate is different: on her lane an ordinary sentence is taken as addressed to her, and her name is only required while the app is making sound."
      >
        <SettingRow
          label="Only respond to my voice"
          description={
            hasProfile
              ? "Dictated speech that does not match your enrolled profile is ignored. Temi does not check the voiceprint."
              // On by default, but the gate also tests `hasProfile`, so it does
              // nothing until there is a voiceprint to compare against. Saying
              // "switch this on" over a toggle already showing on read as a bug.
              : "Waiting on a voice profile, record one below and this starts working. Applies to dictation only."
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
          description="Only act on dictated speech that starts with one of the names below. Strictest setting, use it in a busy room. Temi is not bound by it, she applies the name rule only while the app is audible."
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
          description="The one setting on this page both lanes read. Temi strips these off the front of a sentence, and they are what gets her past the gate while the app is playing sound. Add the spellings speech recognition actually produces for your name, “temmy” is heard as often as “temy”. A name that is also a common word in your own work will be matched often, so keep the list short."
        />
        <SettingList
          entries={settings.wakeWords}
          onChange={(wakeWords) => update({ wakeWords })}
          placeholder="temy"
          label="Add a name the assistant answers to"
          emptyNote="No names left. With none of them, “Require my name” can never match, and while the app is playing sound Temi will hear nothing but a bare “pause” or “play”."
          validate={(entry) =>
            /\s/.test(entry) ? "One word per entry, it is matched against the start of a sentence." : null
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

      {/* ── Dictation and hands-free ────────────────────────────────────────
          Retitled from "Conversation", which read as though it governed the
          conversation the operator actually has. Every key below is consumed
          by `services/voice/conversation.ts` and by nothing on Temi's lane. */}
      <SettingGroup
        label="Dictation and hands-free"
        description="The composer's microphone: what it does with a turn once it has heard one. None of it reaches Temi, who speaks with her own voice and runs her own turn-taking."
      >
        <SettingRow label="Read replies aloud" description="Applies to hands-free mode from the composer. Temi speaks either way.">
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

        <SettingRow label="Narrate progress" description="While an agent run is working, say a short line when it starts something notable, “running the tests”. Never more than one every few seconds, and only when nothing else is being said.">
          <SettingToggle checked={settings.narrateProgress} onChange={(value) => update({ narrateProgress: value })} />
        </SettingRow>

        <SettingRow label="Summarise long replies" description="Read the first few sentences as they arrive, then a two-sentence spoken summary of the rest instead of the whole answer. The full text is always in the chat.">
          <SettingToggle checked={settings.summariseLongReplies} onChange={(value) => update({ summariseLongReplies: value })} />
        </SettingRow>

        <SettingRow label="Remember what it overhears" description="Speech that was not addressed to the assistant is kept for ten minutes, so you can ask “what did she just say?”, and, where the local sidecar can name sounds, “did you hear that car?”. The words are transcribed either way; naming a sound is an extra pass this switch turns on. Nothing is sent anywhere, and it is cleared whenever hands-free mode stops.">
          <SettingToggle checked={settings.ambientMemory} onChange={(value) => update({ ambientMemory: value })} />
        </SettingRow>

        <SettingRow label="Let me interrupt" description="Talking over a spoken reply stops it immediately and starts your turn. Praise, “keep going” and “how's it going?” do not cancel a run; a new instruction or “stop” does. Temi is always interruptible, Google's service handles that end.">
          <SettingToggle checked={settings.allowBargeIn} onChange={(value) => update({ allowBargeIn: value })} />
        </SettingRow>

        <SettingRow label="Confirm before sending" description="Show the cleaned-up text and wait for approval. Turning this off sends as soon as it is understood. Off by default, and Temi never holds a turn for approval.">
          <SettingToggle checked={settings.confirmBeforeSend} onChange={(value) => update({ confirmBeforeSend: value })} />
        </SettingRow>

        <SettingRow
          label="Auto-send after"
          description="When “Confirm before sending” is on, how long the cleaned-up text waits before sending itself. Any interaction cancels it."
        >
          <SettingSelect
            value={String(settings.autoSendAfterMs)}
            onChange={(event) => update({ autoSendAfterMs: Number(event.target.value) })}
          >
            <option value="0">Never, always wait for me</option>
            <option value="1500">1.5 seconds</option>
            <option value="2500">2.5 seconds</option>
            <option value="4000">4 seconds</option>
          </SettingSelect>
        </SettingRow>

        {/* 0.5s is here because `DEFAULT_VOICE_SETTINGS.endpointSilenceMs` is
            500 and the list started at 600, so a fresh install rendered a
            select with no option selected and the shipped default could not be
            chosen again once it had been changed. */}
        <SettingRow label="Pause before I'm finished" description="Roughly how long a silence has to last before your turn ends. The recogniser takes half of this as its floor and twice it as its ceiling, so it is a centre point, not a hard cut. Temi's turn end is fixed at 1.8 seconds by her own service and cannot be set from here.">
          <SettingSelect
            value={String(settings.endpointSilenceMs)}
            onChange={(event) => update({ endpointSilenceMs: Number(event.target.value) })}
          >
            <option value="500">Quick, 0.5s</option>
            <option value="600">Snappy, 0.6s</option>
            <option value="900">Balanced, 0.9s</option>
            <option value="1400">Patient, 1.4s</option>
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

        <SettingRow label="Speaking rate" description="The dictation lane's speaking rate. Temi's pace is her own.">
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
              ? "Dictation is transcribed on this machine and is multilingual, say a sentence in Kiswahili and it will be recognised as Kiswahili. Temi is a separate lane and listens over the network."
              : (vibe?.detail ?? "Install whisper.cpp, or run the VibeVoice sidecar, for on-device multilingual dictation.")}
          </p>
        </div>
      </section>
    </div>
  );
};
