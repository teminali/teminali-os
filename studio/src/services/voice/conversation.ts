/**
 * The voice engine — the state machine that makes the pieces behave like a
 * conversation rather than a dictation box.
 *
 * The loop, in conversation mode:
 *
 *   listening ──speech──► hearing ──endpoint──► deciding ──directed──► repairing
 *        ▲                    │                     │                      │
 *        │                    └──barge-in──┐        └──not directed────────┤
 *        │                                 │                               ▼
 *    speaking ◄──reply── thinking ◄──sending ◄──approved── review ◄────────┘
 *
 * Two things make it feel human rather than mechanical. First, the microphone
 * never closes: the assistant can be interrupted mid-sentence and the barge-in
 * is handled as a real turn, not as an error. Second, nothing reaches the chat
 * without passing the addressing gate and the repair pass, so an always-open
 * mic in a shared room does not fill the transcript with other people's
 * conversations.
 */

import { AudioGraph, encodeWav, type AudioFrame } from "./audioGraph";
import { speakableText } from "./speakable";
import { Endpointer, DEFAULT_ENDPOINTER } from "./turnTaking";
import {
  applyClassifier,
  classifierPrompt,
  parseClassifier,
  scoreAddressing,
  stripWakeWord,
  type AddressingContext,
} from "./addressing";
import { SpeakerProfile, type EnrolledProfile } from "./speakerProfile";
import { polishIsTrustworthy, polishPrompt, repairDeterministic, withPolish } from "./transcriptRepair";
import { createRoster, probeAll, resolve, type ProviderRoster, type ResolvedProviders } from "./providers";
import {
  DEFAULT_VOICE_SETTINGS,
  VoiceError,
  type AddressingVerdict,
  type RecognitionSession,
  type RepairedTranscript,
  type SynthesisHandle,
  type VoiceMode,
  type VoiceSettings,
  type VoiceState,
} from "./types";

/** What the engine needs from the application around it. */
export interface VoiceHost {
  /** Hand an approved utterance to the chat. */
  submit: (text: string) => void | Promise<void>;
  /** The assistant's most recent reply, for follow-up and barge-in context. */
  lastAssistantText: () => string;
  /** True while the chat engine is generating. */
  isBusy: () => boolean;
  /**
   * Run a short local completion. Used for the addressing tiebreak and the
   * transcript polish. Optional: without it both fall back to the rule layer.
   */
  complete?: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /** Terms the recogniser should bias toward — open filenames, symbols. */
  hints?: () => string[];
}

export interface VoiceSnapshot {
  state: VoiceState;
  mode: VoiceMode;
  /** Mic level, 0–1, for the meter. */
  level: number;
  /** Live transcript for the current turn. */
  transcript: string;
  /** Result of the repair pass, present from `review` onward. */
  pending: RepairedTranscript | null;
  /** Why the last utterance was accepted or dropped. */
  verdict: AddressingVerdict | null;
  /** ms left on the auto-send timer, or null when not counting down. */
  autoSendIn: number | null;
  /** The last utterance the gate rejected, kept so it can be recovered. */
  lastRejected: { text: string; verdict: AddressingVerdict } | null;
  error: VoiceError | null;
  providers: ResolvedProviders | null;
  listening: boolean;
  speaking: boolean;
  /** True when a spoken reply was cut short by the operator. */
  interrupted: boolean;
  hasProfile: boolean;
}

type Listener = (snapshot: VoiceSnapshot) => void;

/** Sustained speech needed to count as a barge-in rather than a cough. */
const BARGE_IN_FRAMES = 5;

export class VoiceEngine {
  private readonly roster: ProviderRoster = createRoster();
  private readonly graph: AudioGraph;
  private readonly endpointer = new Endpointer();
  private listeners = new Set<Listener>();

  private settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS };
  private providers: ResolvedProviders | null = null;
  private session: RecognitionSession | null = null;
  private synthesis: SynthesisHandle | null = null;
  private profile: EnrolledProfile | null = null;

  private state: VoiceState = "idle";
  private mode: VoiceMode = "push-to-talk";
  private level = 0;
  private transcript = "";
  private finalTranscript = "";
  private pending: RepairedTranscript | null = null;
  private verdict: AddressingVerdict | null = null;
  private lastRejected: VoiceSnapshot["lastRejected"] = null;
  private error: VoiceError | null = null;
  private interrupted = false;

  private autoSendTimer: number | null = null;
  private autoSendDeadline: number | null = null;
  private tickTimer: number | null = null;

  private assistantTurnEndedAt = 0;
  private assistantAskedQuestion = false;
  private bargeInRun = 0;
  private turnStartedAt = 0;
  /**
   * Whether the recogniser emits partial text mid-utterance. whisper.cpp does
   * not — it transcribes the whole turn in one pass — so the commit has to wait
   * for the final result instead of reading a transcript that is still empty.
   */
  private streamingAsr = true;
  private awaitingFinal = false;
  private abort: AbortController | null = null;

  private host: VoiceHost;

  constructor(host: VoiceHost) {
    this.host = host;
    this.graph = new AudioGraph({ onFrame: (frame) => this.onFrame(frame) });
    this.profile = SpeakerProfile.load();
  }

  /* ── Subscription ──────────────────────────────────────────────────────── */

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): VoiceSnapshot {
    return {
      state: this.state,
      mode: this.mode,
      level: this.level,
      transcript: this.transcript,
      pending: this.pending,
      verdict: this.verdict,
      autoSendIn: this.autoSendDeadline ? Math.max(0, this.autoSendDeadline - Date.now()) : null,
      lastRejected: this.lastRejected,
      error: this.error,
      providers: this.providers,
      listening: this.state !== "idle",
      speaking: this.state === "speaking",
      interrupted: this.interrupted,
      hasProfile: this.profile !== null,
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private setState(state: VoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit();
  }

  /* ── Configuration ─────────────────────────────────────────────────────── */

  configure(patch: Partial<VoiceSettings>): void {
    const tierChanged = patch.tier !== undefined && patch.tier !== this.settings.tier;
    this.settings = { ...this.settings, ...patch };
    this.endpointer.configure({
      minSilenceMs: Math.max(300, Math.round(this.settings.endpointSilenceMs * 0.6)),
      maxSilenceMs: Math.max(this.settings.endpointSilenceMs, DEFAULT_ENDPOINTER.maxSilenceMs),
    });
    if (tierChanged) void this.probe();
    this.emit();
  }

  get currentSettings(): VoiceSettings {
    return this.settings;
  }

  async probe(): Promise<ResolvedProviders> {
    const capabilities = await probeAll(this.roster);
    this.providers = resolve(this.roster, capabilities, this.settings.tier);
    this.emit();
    return this.providers;
  }

  /* ── Speaker enrolment ─────────────────────────────────────────────────── */

  get enrolledProfile(): EnrolledProfile | null {
    return this.profile;
  }

  /**
   * Capture one enrolment clip. The caller runs this three times or so, with a
   * different phrase each time, and hands the clips to `finishEnrolment`.
   */
  async captureEnrolmentClip(seconds = 3): Promise<{ samples: Float32Array; sampleRate: number }> {
    const started = !this.graph.running;
    if (started) await this.graph.start();
    await new Promise((resolve) => window.setTimeout(resolve, seconds * 1000));
    const clip = this.graph.takeHistory(seconds);
    if (started && this.state === "idle") this.graph.stop();
    if (!clip) throw new VoiceError("No audio was captured.", "MIC_UNAVAILABLE");
    return clip;
  }

  finishEnrolment(clips: Array<{ samples: Float32Array; sampleRate: number }>): EnrolledProfile | null {
    const profile = SpeakerProfile.enrol(clips);
    if (profile) {
      SpeakerProfile.save(profile);
      this.profile = profile;
      this.emit();
    }
    return profile;
  }

  clearEnrolment(): void {
    SpeakerProfile.clear();
    this.profile = null;
    this.configure({ requireSpeakerMatch: false });
  }

  /* ── Lifecycle ─────────────────────────────────────────────────────────── */

  async start(mode: VoiceMode): Promise<void> {
    if (this.state !== "idle") await this.stop();

    this.mode = mode;
    this.error = null;
    this.interrupted = false;
    this.transcript = "";
    this.finalTranscript = "";
    this.pending = null;
    this.verdict = null;
    this.endpointer.reset();
    this.abort = new AbortController();

    try {
      if (!this.providers) await this.probe();
      await this.graph.start();
      // The sidecar records from the same stream we analyse, so hand it over.
      this.roster.vibevoice.attachStream(this.graph.mediaStream);

      const asr = this.providers?.asr;
      if (!asr) {
        // Both tiers are out, and each is out for its own reason. Quoting only
        // the built-in one buried the reason that actually mattered — the local
        // sidecar is not running — under a note about Chromium, and left the
        // operator reading that a local engine had taken over when nothing had.
        const tiers = this.providers?.capabilities;
        const reasons = [tiers?.builtin.detail, tiers?.vibevoice.detail].filter(
          (line): line is string => Boolean(line),
        );
        throw new VoiceError(
          ["No speech recogniser is available.", ...new Set(reasons)].join(" "),
          "NO_PROVIDER",
          false,
        );
      }

      this.streamingAsr = asr.capabilities.streamingAsr;
      this.session = await asr.listen(
        {
          language: this.settings.language,
          continuous: mode === "conversation",
          interim: true,
          hints: this.host.hints?.(),
          signal: this.abort.signal,
        },
        {
          onResult: (result) => this.onResult(result.transcript, result.isFinal, result.language),
          onError: (error) => this.fail(error),
          onClose: () => {
            // Push-to-talk closes after one utterance.
            if (this.mode === "push-to-talk" && this.state !== "idle" && !this.awaitingFinal) {
              void this.commitTurn();
              return;
            }
            // A one-shot engine closes its session after every turn. In
            // conversation mode the microphone must reopen, or the exchange
            // silently ends after the first thing you say.
            if (this.mode === "conversation" && this.state !== "idle" && !this.awaitingFinal) {
              void this.reopen();
            }
          },
        },
      );

      this.turnStartedAt = Date.now();
      this.setState("listening");
      this.startTicker();

      // Say hello, so there is no ambiguity about whether the microphone is
      // live. Spoken through the same path as a reply, which means it can be
      // talked over: if you already know what you want to say, just say it.
      if (mode === "conversation" && this.settings.speakGreeting && this.settings.greeting.trim()) {
        void this.speakGreeting();
      }
    } catch (error) {
      this.fail(error instanceof VoiceError ? error : new VoiceError((error as Error).message, "ASR_FAILED"));
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    this.clearAutoSend();
    this.stopTicker();
    this.awaitingFinal = false;
    this.session?.abort();
    this.session = null;
    this.synthesis?.cancel();
    this.synthesis = null;
    this.abort?.abort();
    this.abort = null;
    this.graph.stop();
    this.roster.vibevoice.attachStream(null);
    this.endpointer.reset();
    this.level = 0;
    this.setState("idle");
  }

  /** Push-to-talk release: close the mic and commit whatever was heard. */
  async release(): Promise<void> {
    if (this.mode !== "push-to-talk") return;
    this.session?.stop();
    await this.commitTurn();
  }

  /* ── Audio frames ──────────────────────────────────────────────────────── */

  private onFrame(frame: AudioFrame): void {
    this.level = frame.level;

    // While the assistant is speaking we are not endpointing, we are watching
    // for an interruption.
    if (this.state === "speaking") {
      if (!this.settings.allowBargeIn) return;
      this.bargeInRun = frame.voiced ? this.bargeInRun + 1 : 0;
      if (this.bargeInRun >= BARGE_IN_FRAMES) {
        this.bargeInRun = 0;
        this.handleBargeIn();
      }
      this.emit();
      return;
    }

    if (this.state !== "listening" && this.state !== "hearing") {
      this.emit();
      return;
    }

    // Right after we asked a question, commit faster — a reply is expected.
    const eager =
      this.assistantAskedQuestion && Date.now() - this.assistantTurnEndedAt < 9000;
    const event = this.endpointer.push(frame.voiced, this.transcript, eager);

    if (event?.type === "speech-start") {
      this.turnStartedAt = Date.now();
      this.setState("hearing");
    } else if (event?.type === "speech-end") {
      if (this.streamingAsr) {
        void this.commitTurn();
      } else {
        // Close the recording so the engine can transcribe it; onResult will
        // commit once the text actually exists.
        this.awaitingFinal = true;
        this.setState("deciding");
        this.session?.stop();
      }
    } else if (event?.type === "discarded") {
      this.transcript = "";
      this.setState("listening");
    }

    this.emit();
  }

  private onResult(transcript: string, isFinal: boolean, _language: string): void {
    if (isFinal) this.finalTranscript = this.finalTranscript ? `${this.finalTranscript} ${transcript}` : transcript;
    this.transcript = isFinal ? this.finalTranscript : `${this.finalTranscript} ${transcript}`.trim();
    if (this.state === "listening" && this.transcript) this.setState("hearing");
    this.emit();

    // The one-shot path: the turn already ended, and this is the text it was
    // waiting for.
    if (isFinal && this.awaitingFinal) {
      this.awaitingFinal = false;
      void this.commitTurn();
    }
  }

  /** Reopen the microphone after a one-shot engine closed its session. */
  private async reopen(): Promise<void> {
    const asr = this.providers?.asr;
    if (!asr || this.state === "idle" || this.abort?.signal.aborted) return;
    try {
      this.session = await asr.listen(
        {
          language: this.settings.language,
          continuous: true,
          interim: true,
          hints: this.host.hints?.(),
          signal: this.abort?.signal,
        },
        {
          onResult: (result) => this.onResult(result.transcript, result.isFinal, result.language),
          onError: (error) => this.fail(error),
          onClose: () => {
            if (this.mode === "conversation" && this.state !== "idle" && !this.awaitingFinal) void this.reopen();
          },
        },
      );
    } catch (error) {
      this.fail(error instanceof VoiceError ? error : new VoiceError((error as Error).message, "ASR_FAILED"));
    }
  }

  /* ── Turn commitment ───────────────────────────────────────────────────── */

  private async commitTurn(): Promise<void> {
    this.awaitingFinal = false;
    const heard = this.transcript.trim();
    this.transcript = "";
    this.finalTranscript = "";
    this.endpointer.reset();

    if (!heard) {
      this.setState(this.mode === "conversation" ? "listening" : "idle");
      return;
    }

    this.setState("deciding");

    const durationSeconds = Math.min(12, Math.max(1, (Date.now() - this.turnStartedAt) / 1000));
    const verdict = await this.judgeAddressing(heard, durationSeconds);
    this.verdict = verdict;

    // Push-to-talk is an explicit request; the operator is holding the button,
    // so the addressing gate does not apply.
    if (this.mode === "conversation" && !verdict.directed) {
      this.lastRejected = { text: heard, verdict };
      this.setState("listening");
      this.emit();
      return;
    }

    this.setState("repairing");
    const { text: withoutWakeWord } = stripWakeWord(heard, this.settings.wakeWords);
    const repaired = await this.repair(withoutWakeWord || heard);
    this.pending = repaired;

    const needsApproval = this.settings.confirmBeforeSend || !repaired.clean;
    if (needsApproval) {
      this.setState("review");
      // In conversation mode a silent review would stall the loop, so the
      // timer sends it unless the operator intervenes. In push-to-talk the
      // text lands in the composer and waits indefinitely.
      if (this.mode === "conversation" && this.settings.autoSendAfterMs > 0) {
        this.armAutoSend(this.settings.autoSendAfterMs);
      }
      this.emit();
      return;
    }

    await this.send(repaired.repaired);
  }

  /** Blend the cheap signals, then pay for the model only if still unsure. */
  private async judgeAddressing(text: string, durationSeconds: number): Promise<AddressingVerdict> {
    const context: AddressingContext = {
      assistantAskedQuestion: this.assistantAskedQuestion,
      msSinceAssistantTurn: Date.now() - this.assistantTurnEndedAt,
      speakerMatch: this.scoreSpeaker(durationSeconds),
      hasProfile: this.profile !== null,
      requireWakeWord: this.settings.requireWakeWord,
      requireSpeakerMatch: this.settings.requireSpeakerMatch,
      wakeWords: this.settings.wakeWords,
      windowFocused: typeof document !== "undefined" ? document.hasFocus() : true,
    };

    const { verdict, needsClassifier } = scoreAddressing(text, context);
    if (!needsClassifier || !this.host.complete) return verdict;

    try {
      const reply = await this.host.complete(
        classifierPrompt(text, this.host.lastAssistantText()),
        this.abort?.signal,
      );
      const adjustment = parseClassifier(reply);
      return adjustment === null ? verdict : applyClassifier(verdict, adjustment);
    } catch {
      // A classifier failure must never silence the assistant.
      return verdict;
    }
  }

  private scoreSpeaker(durationSeconds: number): number | null {
    if (!this.profile) return null;
    const clip = this.graph.takeHistory(Math.min(8, durationSeconds + 0.4));
    if (!clip) return null;
    return SpeakerProfile.match(this.profile, clip.samples, clip.sampleRate);
  }

  private async repair(text: string): Promise<RepairedTranscript> {
    const base = repairDeterministic(text);
    if (!this.host.complete) return base;

    try {
      const polished = await this.host.complete(
        polishPrompt(base.repaired, this.settings.language === "auto" ? "" : this.settings.language, null),
        this.abort?.signal,
      );
      if (polishIsTrustworthy(base.repaired, polished)) return withPolish(base, polished);
    } catch {
      /* Rule-based repair stands on its own. */
    }
    return base;
  }

  /* ── Review and submission ─────────────────────────────────────────────── */

  private armAutoSend(ms: number): void {
    this.clearAutoSend();
    this.autoSendDeadline = Date.now() + ms;
    this.autoSendTimer = window.setTimeout(() => {
      this.autoSendDeadline = null;
      this.autoSendTimer = null;
      if (this.state === "review" && this.pending) void this.send(this.pending.repaired);
    }, ms);
  }

  private clearAutoSend(): void {
    if (this.autoSendTimer !== null) window.clearTimeout(this.autoSendTimer);
    this.autoSendTimer = null;
    this.autoSendDeadline = null;
  }

  /** Operator approved the pending utterance, possibly after editing it. */
  async approve(edited?: string): Promise<void> {
    if (this.state !== "review" || !this.pending) return;
    this.clearAutoSend();
    await this.send(edited ?? this.pending.repaired);
  }

  /** Operator rejected it. Drop it and go back to listening. */
  discard(): void {
    this.clearAutoSend();
    this.pending = null;
    this.setState(this.mode === "conversation" ? "listening" : "idle");
  }

  /** Recover an utterance the addressing gate dropped by mistake. */
  async recoverRejected(): Promise<void> {
    const rejected = this.lastRejected;
    if (!rejected) return;
    this.lastRejected = null;
    this.setState("repairing");
    this.pending = await this.repair(rejected.text);
    this.setState("review");
    this.emit();
  }

  private async send(text: string): Promise<void> {
    const value = text.trim();
    this.pending = null;
    this.clearAutoSend();
    if (!value) {
      this.setState(this.mode === "conversation" ? "listening" : "idle");
      return;
    }

    this.setState("sending");
    try {
      await this.host.submit(value);
    } catch (error) {
      this.fail(new VoiceError(`The message could not be sent: ${(error as Error).message}`, "ASR_FAILED"));
      return;
    }

    if (this.mode === "push-to-talk") {
      await this.stop();
      return;
    }
    this.setState("thinking");
  }

  /* ── Spoken replies and barge-in ───────────────────────────────────────── */

  /** The opening line. Deliberately not treated as an assistant turn: it asks
   *  nothing, so it must not open the follow-up window that makes the next
   *  utterance count as an answer. */
  private async speakGreeting(): Promise<void> {
    const tts = this.providers?.tts;
    if (!tts) return;

    this.setState("speaking");
    this.graph.setDucked(true);
    try {
      this.synthesis = await tts.speak({
        text: this.settings.greeting.trim(),
        language: this.settings.language === "auto" ? navigator.language : this.settings.language,
        voice: this.settings.ttsVoice ?? undefined,
        rate: this.settings.ttsRate,
        onEnd: () => {
          this.synthesis = null;
          this.graph.setDucked(false);
          if (this.state === "speaking") this.setState("listening");
        },
      });
    } catch {
      this.graph.setDucked(false);
      if (this.state === "speaking") this.setState("listening");
    }
  }

  /**
   * Called by the host when the assistant's reply is complete. In conversation
   * mode this reads it back and then returns to listening.
   */
  async speakReply(text: string): Promise<void> {
    this.assistantAskedQuestion = /\?\s*$/.test(text.trim());

    if (this.mode !== "conversation" || !this.settings.speakReplies || !text.trim()) {
      this.assistantTurnEndedAt = Date.now();
      if (this.state !== "idle") this.setState("listening");
      return;
    }

    const tts = this.providers?.tts;
    if (!tts) {
      this.assistantTurnEndedAt = Date.now();
      this.setState("listening");
      return;
    }

    const spoken = speakableText(text);
    this.interrupted = false;
    this.setState("speaking");
    // Raise the VAD threshold so our own audio, past the browser's echo
    // canceller, does not register as the operator speaking.
    this.graph.setDucked(true);

    try {
      this.synthesis = await tts.speak({
        text: spoken,
        language: this.settings.language === "auto" ? navigator.language : this.settings.language,
        voice: this.settings.ttsVoice ?? undefined,
        rate: this.settings.ttsRate,
        onEnd: () => {
          this.synthesis = null;
          this.graph.setDucked(false);
          this.assistantTurnEndedAt = Date.now();
          if (this.state === "speaking") this.setState("listening");
          // A one-shot engine's session ended with the previous turn.
          if (!this.streamingAsr && this.mode === "conversation" && !this.session?.active) void this.reopen();
        },
      });
    } catch {
      this.graph.setDucked(false);
      this.assistantTurnEndedAt = Date.now();
      this.setState("listening");
    }
  }

  /**
   * The operator started talking over the reply. Stop speaking immediately and
   * treat what follows as the next turn. The host is told how much of the reply
   * was actually heard so the conversation history can reflect that rather than
   * pretending the whole thing was delivered.
   */
  private handleBargeIn(): void {
    this.synthesis?.cancel();
    this.synthesis = null;
    this.graph.setDucked(false);
    this.interrupted = true;
    this.assistantTurnEndedAt = Date.now();
    this.endpointer.reset();
    this.setState("hearing");
    this.turnStartedAt = Date.now();
  }

  /** Host hook: stop speaking without it counting as an interruption. */
  silence(): void {
    this.synthesis?.cancel();
    this.synthesis = null;
    this.graph.setDucked(false);
    if (this.state === "speaking") this.setState("listening");
  }

  /* ── Plumbing ──────────────────────────────────────────────────────────── */

  private startTicker(): void {
    this.stopTicker();
    // Drives the auto-send countdown in the HUD.
    this.tickTimer = window.setInterval(() => {
      if (this.autoSendDeadline) this.emit();
    }, 100);
  }

  private stopTicker(): void {
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private fail(error: VoiceError): void {
    this.error = error;
    this.emit();
  }

  /** Snapshot of recent audio as a WAV, for re-transcription or enrolment. */
  captureWav(seconds: number): Blob | null {
    const clip = this.graph.takeHistory(seconds);
    return clip ? encodeWav(clip.samples, clip.sampleRate) : null;
  }
}

export { speakableText };
