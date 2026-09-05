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
import { speakableText, paceFor } from "./speakable";
import { Endpointer, DEFAULT_ENDPOINTER } from "./turnTaking";
import { ProsodyTracker } from "./prosody";
import {
  applyClassifier,
  classifierPrompt,
  parseClassifier,
  scoreAddressing,
  stripWakeWord,
  type AddressingContext,
} from "./addressing";
import { SpeakerProfile, type EnrolledProfile } from "./speakerProfile";
import { classifyTurnIntent, type TurnIntentVerdict } from "./turnIntent";
import { EchoGuard } from "./echoGuard";
import { AmbientMemory, classifyAmbientQuery } from "./ambientMemory";
import { cleanTranscript, isNonSpeechOrBlank, polishIsTrustworthy, polishPrompt, repairDeterministic, withPolish } from "./transcriptRepair";
import { createRoster, probeAll, resolve, type ProviderRoster, type ResolvedProviders } from "./providers";
import {
  DEFAULT_VOICE_SETTINGS,
  VoiceError,
  type AddressingVerdict,
  type AmbientSound,
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
  /** Cancel any active in-flight assistant generation or task. */
  interrupt?: () => void;
  /**
   * Run a short local completion. Used for the addressing tiebreak and the
   * transcript polish. Optional: without it both fall back to the rule layer.
   */
  complete?: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /** Terms the recogniser should bias toward — open filenames, symbols. */
  hints?: () => string[];
  /**
   * One short spoken answer to "how's it going?" while a run is in flight,
   * built from what the run has actually done. Null when nothing is running.
   */
  progressSummary?: () => string | null;
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
  /** The latest progress or interjection line — what the assistant last said about the run. */
  narration: string | null;
  /** How the last committed utterance was read: stop, acknowledge, status, or instruction. */
  lastIntent: (TurnIntentVerdict & { text: string; at: number }) | null;
}

type Listener = (snapshot: VoiceSnapshot) => void;

/** Sustained speech needed to count as a barge-in rather than a cough. */
const BARGE_IN_FRAMES = 10;
/** Minimum gap between spoken progress lines, so a busy run is not a running commentary. */
const PROGRESS_GAP_MS = 9000;
/** No progress line this soon after the operator spoke; the reply to them comes first. */
const PROGRESS_AFTER_TURN_MS = 2500;
/** "Still on it." is said at most this often, however much encouragement arrives. */
const ACK_REPLY_GAP_MS = 20_000;
/** The local addressing tiebreak gets this long before the rule verdict stands. */
const CLASSIFIER_TIMEOUT_MS = 1500;

/**
 * How long the same sound stays "already logged". A steady noise - a fan, a
 * road outside - is named in every clip, and one entry per minute is all that
 * "did you hear that?" needs from it.
 */
const SOUND_REPEAT_MS = 60_000;

export class VoiceEngine {
  private readonly roster: ProviderRoster = createRoster();
  private readonly graph: AudioGraph;
  private readonly endpointer = new Endpointer();
  /** The energy and pitch of the last few hundred ms of speech; see `prosody.ts`. */
  private readonly prosody = new ProsodyTracker();
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
  private speechQueue: string[] = [];
  private isProcessingSpeechQueue = false;
  private isStreamDone = false;
  private suspendedSpeech: string[] | null = null;
  private currentlySpeakingText: string | null = null;
  private readonly echo = new EchoGuard();
  /** What was heard and deliberately not answered. See `ambientMemory.ts`. */
  private readonly ambient = new AmbientMemory();
  private narration: string | null = null;
  private lastIntent: VoiceSnapshot["lastIntent"] = null;
  /** A one-off line (status answer, "still on it") is playing ahead of the queue. */
  private interjecting = false;
  /** The streamed sentences are spoken; the host is still making the digest of the rest. */
  private digesting = false;
  private lastProgressSpokenAt = 0;
  private lastAckSpokenAt = 0;
  private lastUserTurnAt = 0;
  private lastActivityAt = Date.now();
  private isGoingToSleep = false;
  public static readonly INACTIVITY_SLEEP_MS = 60000; // 1 minute sweet spot
  /** How long to wait for a streaming recogniser to deliver its final text. */
  public static readonly STREAMING_FINAL_TIMEOUT_MS = 1200;
  /**
   * The same wait for a one-shot engine, which transcribes the whole clip in a
   * single pass once the recording closes. Generous, because the alternative
   * to waiting is a lost turn; bounded, because the alternative to a bound is
   * a microphone that never reopens.
   */
  public static readonly ONE_SHOT_FINAL_TIMEOUT_MS = 12000;

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
  /**
   * Whether the recogniser also names non-speech sounds. Read once at listen
   * time and kept, because the recall answers need to distinguish "there was
   * no car" from "nothing here was ever listening for one".
   */
  private soundLabels = false;
  private awaitingFinal = false;
  /** Safety net for `awaitingFinal`; see `armFinalFallback`. */
  private finalFallbackTimer: number | null = null;
  /** A reopen `onClose` skipped because a final transcript was still expected. */
  private reopenDeferred = false;
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
      narration: this.narration,
      lastIntent: this.lastIntent,
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
    this.narration = null;
    this.lastIntent = null;
    this.interjecting = false;
    this.lastProgressSpokenAt = 0;
    this.lastAckSpokenAt = 0;
    this.lastUserTurnAt = 0;
    this.echo.clear();
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
      this.soundLabels = asr.capabilities.soundLabels;
      this.session = await asr.listen(
        {
          language: this.settings.language,
          continuous: mode === "conversation",
          interim: true,
          hints: this.host.hints?.(),
          sounds: this.settings.ambientMemory,
          signal: this.abort.signal,
        },
        {
          onResult: (result) => this.onResult(result.transcript, result.isFinal, result.language),
          onSound: (sounds) => this.rememberSounds(sounds),
          onError: (error) => this.fail(error),
          onClose: () => {
            if (this.state === "idle") return;
            if (this.awaitingFinal) {
              // onResult may still be coming. Do not reopen over the top of
              // it, but record that the microphone is now shut so the fallback
              // can reopen it if that text never arrives.
              this.reopenDeferred = true;
              return;
            }
            // Push-to-talk closes after one utterance.
            if (this.mode === "push-to-talk") {
              void this.commitTurn();
              return;
            }
            // A one-shot engine closes its session after every turn. In
            // conversation mode the microphone must reopen, or the exchange
            // silently ends after the first thing you say.
            if (this.mode === "conversation") void this.reopen();
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
    this.suspendedSpeech = null;
    this.currentlySpeakingText = null;
    this.speechQueue = [];
    this.isProcessingSpeechQueue = false;
    this.isStreamDone = false;
    this.interjecting = false;
    this.digesting = false;
    this.narration = null;
    this.lastIntent = null;
    this.echo.clear();
    // Stopping is an explicit act, and it must be the end of the recording as
    // well as the end of the session.
    this.ambient.forget();
    this.clearAutoSend();
    this.stopTicker();
    this.clearFinalFallback();
    this.awaitingFinal = false;
    this.reopenDeferred = false;
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
    if (frame.voiced || this.state === "speaking" || this.state === "thinking" || this.state === "sending") {
      this.lastActivityAt = Date.now();
    }

    // While the assistant is speaking, thinking, or the chat is busy,
    // we watch for an interruption / barge-in.
    const isAssistantBusy = this.state === "speaking" || this.state === "thinking" || (this.host.isBusy?.() && this.state !== "hearing" && this.state !== "deciding");
    if (isAssistantBusy) {
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
    // Voiced frames feed the prosody tail; silent ones read it. A one-shot
    // recogniser has no transcript until the recording closes, so on that path
    // the audio is the only evidence the endpointer has before the ceiling.
    if (frame.voiced) this.prosody.observe({ at: frame.at, rms: frame.rms, f0: frame.pitch });
    const event = this.endpointer.push(frame.voiced, this.transcript, eager, {
      at: frame.at,
      prosody: frame.voiced ? null : this.prosody.finality(),
    });

    if (event?.type === "speech-start") {
      this.turnStartedAt = Date.now();
      this.setState("hearing");
    } else if (event?.type === "speech-end") {
      this.prosody.reset();
      if (this.streamingAsr) {
        if (this.session?.flush) {
          // A chunked engine still holds the tail of the sentence in its open
          // slice. Flush it now rather than commit without it: the final that
          // comes back carries the whole utterance and triggers the commit.
          this.awaitingFinal = true;
          this.setState("deciding");
          this.session.flush();
          this.armFinalFallback(VoiceEngine.STREAMING_FINAL_TIMEOUT_MS);
        } else if (this.transcript.trim()) {
          void this.commitTurn();
        } else {
          // Speech ended, wait for final transcript from recogniser
          this.awaitingFinal = true;
          this.setState("deciding");
          this.armFinalFallback(VoiceEngine.STREAMING_FINAL_TIMEOUT_MS);
        }
      } else {
        // Close the recording so the engine can transcribe it; onResult will
        // commit once the text actually exists — or the fallback will give the
        // microphone back if it never does.
        this.awaitingFinal = true;
        this.setState("deciding");
        this.session?.stop();
        this.armFinalFallback(VoiceEngine.ONE_SHOT_FINAL_TIMEOUT_MS);
      }
    } else if (event?.type === "discarded") {
      this.prosody.reset();
      this.transcript = "";
      this.setState("listening");
    }

    this.emit();
  }

  /**
   * A non-speech sound the sidecar named in a clip: a car, a knock, a phone.
   *
   * It is written straight to the ambient log and goes no further. It is not a
   * turn, it does not touch the endpointer or the addressing gate, and it never
   * interrupts anything: the assistant is not to announce that a car went past.
   * The only thing that changes is that the answer exists when it is asked for.
   */
  private rememberSounds(sounds: AmbientSound[]): void {
    // Checked here as well as at listen time, because the setting can be
    // switched off in the middle of a session and must take effect at once.
    if (!this.settings.ambientMemory) return;
    const now = Date.now();
    for (const sound of sounds) {
      // A fan, an air conditioner or traffic outside is present in every clip,
      // and logging each one would push everything else out of a 200-entry
      // window within a minute. One entry per label per repeat window is
      // enough to answer "did you hear that"; the rest is the same fan.
      const repeated = this.ambient
        .all(now)
        .some((entry) => entry.kind === "sound" && entry.label === sound.label && now - entry.at < SOUND_REPEAT_MS);
      if (repeated) continue;
      this.ambient.remember({
        kind: "sound",
        text: sound.sound,
        label: sound.label,
        speaker: "unknown",
        confidence: sound.confidence,
      }, now);
    }
  }

  private onResult(transcript: string, isFinal: boolean, _language: string): void {
    // The recogniser hears the speakers as well as the operator. Anything that
    // is the assistant's own voice coming back is removed before it can become
    // part of a turn.
    const cleanPart = this.withoutEcho(cleanTranscript(transcript));
    if (!cleanPart && !this.transcript) {
      if (isFinal && (this.awaitingFinal || this.state === "deciding")) {
        this.awaitingFinal = false;
        this.setState(this.mode === "conversation" ? "listening" : "idle");
      }
      return;
    }

    if (isFinal) this.finalTranscript = this.finalTranscript ? `${this.finalTranscript} ${cleanPart}`.trim() : cleanPart;
    this.transcript = isFinal ? this.finalTranscript : `${this.finalTranscript} ${cleanPart}`.trim();
    if (this.state === "listening" && this.transcript) this.setState("hearing");
    this.emit();

    // The one-shot path or delayed ASR stream: the turn already ended, and this is the text it was waiting for.
    if ((isFinal || this.transcript.trim()) && (this.awaitingFinal || this.state === "deciding")) {
      this.awaitingFinal = false;
      void this.commitTurn();
    }
  }

  /** Reopen the microphone after a one-shot engine closed its session. */
  /**
   * Arm the safety net for `awaitingFinal`. That flag is what stops `onClose`
   * from reopening the microphone while a final transcript is still expected,
   * so nothing may set it without a way out: an engine that closes, errors, or
   * returns an empty result would otherwise leave it set forever and the
   * session would go deaf while the UI still showed it live. That is the
   * "it stopped responding but voice mode is still on" failure.
   *
   * The fallback deliberately does not test `state`. An interjection or a
   * narration can move the state out of "deciding" while a final is
   * outstanding, and a latch that only clears in one state is barely better
   * than no latch at all.
   */
  private armFinalFallback(afterMs: number): void {
    this.clearFinalFallback();
    this.finalFallbackTimer = window.setTimeout(() => {
      this.finalFallbackTimer = null;
      if (!this.awaitingFinal) return;
      this.awaitingFinal = false;
      if (this.transcript.trim()) {
        void this.commitTurn();
        return;
      }
      this.setState(this.mode === "conversation" ? "listening" : "idle");
      // The engine closed while we were waiting and onClose declined to
      // reopen because of the flag we have just cleared.
      if (this.reopenDeferred && this.mode === "conversation" && this.state !== "idle") {
        this.reopenDeferred = false;
        void this.reopen();
      }
      this.emit();
    }, afterMs);
  }

  private clearFinalFallback(): void {
    if (this.finalFallbackTimer !== null) window.clearTimeout(this.finalFallbackTimer);
    this.finalFallbackTimer = null;
  }

  private async reopen(): Promise<void> {
    this.reopenDeferred = false;
    const asr = this.providers?.asr;
    if (!asr || this.state === "idle" || this.abort?.signal.aborted) return;
    try {
      this.session = await asr.listen(
        {
          language: this.settings.language,
          continuous: true,
          interim: true,
          hints: this.host.hints?.(),
          sounds: this.settings.ambientMemory,
          signal: this.abort?.signal,
        },
        {
          onResult: (result) => this.onResult(result.transcript, result.isFinal, result.language),
          onSound: (sounds) => this.rememberSounds(sounds),
          onError: (error) => this.fail(error),
          onClose: () => {
            if (this.state === "idle") return;
            if (this.awaitingFinal) {
              this.reopenDeferred = true;
              return;
            }
            if (this.mode === "conversation") void this.reopen();
          },
        },
      );
    } catch (error) {
      this.fail(error instanceof VoiceError ? error : new VoiceError((error as Error).message, "ASR_FAILED"));
    }
  }

  /* ── Turn commitment ───────────────────────────────────────────────────── */

  private resumeSuspendedSpeech(): void {
    const suspended = this.suspendedSpeech;
    this.suspendedSpeech = null;
    this.endpointer.reset();

    if (suspended && suspended.length > 0) {
      this.speechQueue = [...suspended, ...this.speechQueue];
      this.setState("speaking");
      void this.processSpeechQueue();
      return;
    }

    if (this.host.isBusy?.()) {
      this.setState("thinking");
    } else {
      this.graph.setDucked(false);
      this.assistantTurnEndedAt = Date.now();
      this.setState(this.mode === "conversation" ? "listening" : "idle");
    }
    this.emit();
  }

  private async commitTurn(): Promise<void> {
    this.clearFinalFallback();
    this.awaitingFinal = false;
    const raw = cleanTranscript(this.transcript);
    this.transcript = "";
    this.finalTranscript = "";
    this.endpointer.reset();

    // Each partial result was filtered as it arrived; the assembled utterance
    // is checked once more as a whole, because echo spread across several
    // partials can pass each of them and still be nothing but echo.
    const echo = this.echo.filter(raw);
    const heard = echo.echoed ? echo.text : raw;

    if (!heard || isNonSpeechOrBlank(heard)) {
      // Non-speech, blank audio, or our own voice. Resume where we left off.
      this.resumeSuspendedSpeech();
      return;
    }

    this.setState("deciding");

    const durationSeconds = Math.min(12, Math.max(1, (Date.now() - this.turnStartedAt) / 1000));
    const verdict = await this.judgeAddressing(heard, durationSeconds);
    this.verdict = verdict;

    // Push-to-talk is an explicit request; the operator is holding the button,
    // so the addressing gate does not apply.
    if (this.mode === "conversation" && !verdict.directed) {
      // Meant for someone else. Note it, and carry on with what we were saying.
      this.lastRejected = { text: heard, verdict };
      if (this.settings.ambientMemory) {
        // Already transcribed, and about to be discarded. Keeping it is what
        // makes "what did she just say?" answerable, and costs no recognition.
        const match = verdict.signals.speakerMatch;
        this.ambient.remember({
          kind: "speech",
          text: heard,
          speaker: match === null ? "unknown" : match >= 0.6 ? "operator" : "other",
          confidence: verdict.confidence,
          reason: verdict.reason,
        });
      }
      this.resumeSuspendedSpeech();
      return;
    }

    const { text: withoutWakeWord, matched: wakeWordMatched } = stripWakeWord(heard, this.settings.wakeWords);

    // It was for us. The next question is what it asks of the work in flight:
    // a redirect replaces the run, but praise, a status check and "stop" do
    // not — before this gate "great, keep going" cancelled the build it was
    // praising, because every directed turn was an interruption.
    const hostBusy = Boolean(this.host.isBusy?.());
    const wasSpeaking = this.suspendedSpeech !== null && this.suspendedSpeech.length > 0;
    const intent: TurnIntentVerdict =
      this.mode === "conversation"
        ? classifyTurnIntent(withoutWakeWord || heard, { busy: hostBusy, speaking: wasSpeaking })
        : { intent: "instruction", reason: "Dictated." };
    this.lastIntent = { ...intent, text: heard, at: Date.now() };
    this.lastUserTurnAt = Date.now();

    if (intent.intent === "stop") {
      this.dropSpeech();
      if (hostBusy) this.callInterrupt();
      this.assistantTurnEndedAt = Date.now();
      if (hostBusy) {
        this.speakInterjection("Okay, stopped.");
      } else {
        this.narration = null;
        this.setState(this.mode === "conversation" ? "listening" : "idle");
        this.emit();
      }
      return;
    }

    if (intent.intent === "acknowledge") {
      if (wasSpeaking) {
        // "yes, go on" — agreement with what was being said. Finish saying it.
        this.resumeSuspendedSpeech();
        return;
      }
      this.suspendedSpeech = null;
      const now = Date.now();
      if (hostBusy && now - this.lastAckSpokenAt > ACK_REPLY_GAP_MS) {
        this.lastAckSpokenAt = now;
        this.speakInterjection("Still on it.");
      } else {
        this.setState(hostBusy ? "thinking" : this.mode === "conversation" ? "listening" : "idle");
        this.emit();
      }
      return;
    }

    if (intent.intent === "status") {
      // Answer, then pick up whatever was being said before the question.
      const resume = this.suspendedSpeech ?? [];
      this.suspendedSpeech = null;
      this.speechQueue = [...resume, ...this.speechQueue];
      const summary = this.host.progressSummary?.() ?? "Still working on it. I'll tell you as soon as it's done.";
      this.speakInterjection(summary);
      return;
    }

    // A question about the room rather than about the work. Answered from the
    // ambient log by rules, so asking what was overheard never sends what was
    // overheard to a model.
    const ambientQuery = this.settings.ambientMemory
      ? classifyAmbientQuery(withoutWakeWord || heard)
      : null;
    if (ambientQuery) {
      const recalled = this.ambient.answer(ambientQuery, Date.now(), {
        soundLabels: this.soundLabels,
      });
      // A null answer means nothing was overheard, and the phrasing that got
      // us here is not unambiguous: "what did he say in the docs?" reads as a
      // recall question and is not one. Falling through costs nothing, while
      // answering "I heard nothing" would swallow a real instruction.
      if (recalled) {
        const resume = this.suspendedSpeech ?? [];
        this.suspendedSpeech = null;
        this.speechQueue = [...resume, ...this.speechQueue];
        this.speakInterjection(recalled);
        return;
      }
    }

    // A real instruction: it replaces whatever was being said or done.
    this.dropSpeech();
    this.interrupted = true;
    if (hostBusy || wasSpeaking) this.callInterrupt();

    this.setState("repairing");

    // Direct wake-word greeting: e.g. "Hey Temy", "Temy", "Hey Teminali"
    if (wakeWordMatched && !withoutWakeWord) {
      const greetingReply = this.settings.greeting?.trim()
        ? this.settings.greeting.trim()
        : "Hey! What are we building today?";
      await this.speakReply(greetingReply);
      return;
    }

    const repaired = repairDeterministic(withoutWakeWord || heard);
    this.pending = repaired;

    const needsApproval = Boolean(this.settings.confirmBeforeSend);
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
      const reply = await this.completeWithin(classifierPrompt(text, this.host.lastAssistantText()), CLASSIFIER_TIMEOUT_MS);
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
    this.echo.remember(this.settings.greeting);
    try {
      this.synthesis = await tts.speak({
        text: this.settings.greeting.trim(),
        language: this.settings.language === "auto" ? navigator.language : this.settings.language,
        voice: this.settings.ttsVoice ?? undefined,
        rate: paceFor(this.settings.ttsRate, this.settings.greeting),
        onEnd: () => {
          this.synthesis = null;
          this.echo.markEnded();
          this.graph.setDucked(false);
          if (this.state === "speaking") this.setState("listening");
        },
      });
    } catch {
      this.echo.markEnded();
      this.graph.setDucked(false);
      if (this.state === "speaking") this.setState("listening");
    }
  }

  /**
   * Called by the host when the assistant's reply is complete. In conversation
   * mode this reads it back and then returns to listening.
   */
  /**
   * Enqueue a sentence chunk to be spoken on the fly as it streams from the model.
   * This lets the assistant explain on the go instead of waiting for the full generation.
   */
  async enqueueSpeechChunk(chunk: string, isFinal: boolean): Promise<void> {
    // Whatever arrives now is the digest (or the end of the reply); the wait is over.
    const wasDigesting = this.digesting;
    this.digesting = false;
    // The run is over: its last "Reading types dot ts" must not caption the
    // reply being read out, which is in the chat and needs no caption.
    if (isFinal) this.narration = null;
    if (this.mode !== "conversation" || !this.settings.speakReplies) {
      if (isFinal) {
        this.assistantTurnEndedAt = Date.now();
        if (this.state !== "idle") this.setState("listening");
      }
      return;
    }

    const clean = speakableText(chunk).trim();
    if (clean && !isNonSpeechOrBlank(clean)) {
      if (this.suspendedSpeech !== null) {
        this.suspendedSpeech.push(clean);
      } else {
        this.speechQueue.push(clean);
      }
      this.assistantAskedQuestion = /\?\s*$/.test(clean);
    }

    if (isFinal) {
      this.isStreamDone = true;
    }

    if (this.suspendedSpeech === null && !this.isProcessingSpeechQueue && this.speechQueue.length > 0) {
      void this.processSpeechQueue();
    } else if (isFinal && this.speechQueue.length === 0 && !this.isProcessingSpeechQueue && this.suspendedSpeech === null) {
      this.graph.setDucked(false);
      this.assistantTurnEndedAt = Date.now();
      if (this.state === "speaking" || (wasDigesting && this.state === "thinking")) this.setState("listening");
    }
  }

  private async processSpeechQueue(): Promise<void> {
    if (this.speechQueue.length === 0) {
      this.isProcessingSpeechQueue = false;
      this.currentlySpeakingText = null;
      this.echo.markEnded();
      if (this.interjecting && !this.isStreamDone) {
        // A one-off line has finished; the run it commented on is still going.
        this.interjecting = false;
        this.graph.setDucked(false);
        this.assistantTurnEndedAt = Date.now();
        if (this.state === "speaking") {
          this.setState(this.host.isBusy?.() ? "thinking" : this.mode === "conversation" ? "listening" : "idle");
        }
        this.emit();
        return;
      }
      this.interjecting = false;
      if (this.isStreamDone) {
        this.isStreamDone = false;
        this.graph.setDucked(false);
        this.assistantTurnEndedAt = Date.now();
        if (this.state === "speaking") this.setState("listening");
        if (!this.streamingAsr && this.mode === "conversation" && !this.session?.active) void this.reopen();
      } else if (this.digesting && this.state === "speaking") {
        // The streamed sentences are spoken and the summary of the rest is still
        // being made: a pause the orb must show as thinking, not as speech.
        this.setState("thinking");
      }
      return;
    }

    this.isProcessingSpeechQueue = true;
    const text = this.speechQueue.shift()!;
    this.currentlySpeakingText = text;
    const tts = this.providers?.tts;
    if (!tts || !text) {
      this.currentlySpeakingText = null;
      void this.processSpeechQueue();
      return;
    }

    this.interrupted = false;
    this.setState("speaking");
    this.graph.setDucked(true);
    this.echo.remember(text);

    try {
      this.synthesis = await tts.speak({
        text,
        language: this.settings.language === "auto" ? navigator.language : this.settings.language,
        voice: this.settings.ttsVoice ?? undefined,
        rate: paceFor(this.settings.ttsRate, text),
        onEnd: () => {
          this.currentlySpeakingText = null;
          this.synthesis = null;
          this.echo.markEnded();
          void this.processSpeechQueue();
        },
      });
    } catch {
      this.currentlySpeakingText = null;
      this.synthesis = null;
      this.echo.markEnded();
      void this.processSpeechQueue();
    }
  }

  async speakReply(text: string): Promise<void> {
    const spoken = speakableText(text).trim();
    if (!spoken || isNonSpeechOrBlank(spoken)) {
      this.assistantTurnEndedAt = Date.now();
      if (this.state !== "idle") this.setState("listening");
      return;
    }

    if (this.mode !== "conversation" || !this.settings.speakReplies) {
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

    // Split into sentences so that if the user coughs or makes an ambient sound,
    // speech can pause and resume cleanly right from the current sentence!
    const sentences = spoken.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) || [spoken];
    this.speechQueue = [];
    this.suspendedSpeech = null;
    this.currentlySpeakingText = null;
    for (const s of sentences) {
      const trimmed = s.trim();
      if (trimmed && !isNonSpeechOrBlank(trimmed)) {
        this.speechQueue.push(trimmed);
      }
    }
    this.isStreamDone = true;
    this.digesting = false;
    this.assistantAskedQuestion = /\?\s*$/.test(spoken);

    if (this.speechQueue.length > 0) {
      void this.processSpeechQueue();
    } else {
      this.assistantTurnEndedAt = Date.now();
      if (this.state !== "idle") this.setState("listening");
    }
  }

  /**
   * Speak a line that belongs to no voice turn.
   *
   * The screen assistant reaches this instead of `speakReply`. It has its own
   * spoken-reply toggle, and it answers a global hotkey rather than a
   * microphone session, so gating it on conversation mode — as `speakReply`
   * must be gated, or push-to-talk dictation would start reading itself back —
   * silenced it entirely: the guard returned before the synthesiser was ever
   * asked for audio.
   *
   * When a session *is* open the two paths must still not talk over each
   * other, so the synthesis handle and the ducking are shared. When none is
   * open, the turn-taking machine is left alone: there is nothing to duck and
   * no state to return to, and forcing "listening" would light up the HUD over
   * a microphone that was never started.
   */
  async speakAside(text: string): Promise<void> {
    const spoken = speakableText(text);
    if (!spoken.trim()) return;

    const tts = this.providers?.tts;
    if (!tts) return;

    // Whatever is still in the air is stale the moment a new line arrives.
    this.synthesis?.cancel();
    this.synthesis = null;

    const inSession = this.state !== "idle";
    if (inSession) {
      this.setState("speaking");
      this.graph.setDucked(true);
    }

    const restore = () => {
      this.synthesis = null;
      this.echo.markEnded();
      if (!inSession) return;
      this.graph.setDucked(false);
      this.assistantTurnEndedAt = Date.now();
      if (this.state === "speaking") this.setState("listening");
    };

    this.echo.remember(spoken);
    try {
      this.synthesis = await tts.speak({
        text: spoken,
        language: this.settings.language === "auto" ? navigator.language : this.settings.language,
        voice: this.settings.ttsVoice ?? undefined,
        rate: paceFor(this.settings.ttsRate, spoken),
        onEnd: restore,
      });
    } catch {
      restore();
    }
  }

  /**
   * The operator started talking over the reply. Stop speaking immediately and
   * treat what follows as the next turn. The host is told how much of the reply
   * was actually heard so the conversation history can reflect that rather than
   * pretending the whole thing was delivered.
   */
  /* ── Running commentary ────────────────────────────────────────────────── */

  /**
   * The host reports something notable the run just started — "Running the
   * tests." The line always reaches the HUD. It is spoken only when the
   * assistant is otherwise quiet, a run is actually in flight, not on the
   * heels of the operator's own turn, and at most every PROGRESS_GAP_MS — a
   * colleague's occasional "tests are running now", not a commentary track.
   */
  noteProgress(line: string): void {
    const clean = line.trim();
    if (!clean || this.state === "idle") return;
    this.narration = clean;

    const now = Date.now();
    const quiet = this.suspendedSpeech === null && !this.isProcessingSpeechQueue && this.speechQueue.length === 0;
    const allowed =
      this.mode === "conversation" &&
      this.settings.speakReplies &&
      this.settings.narrateProgress &&
      quiet &&
      Boolean(this.host.isBusy?.()) &&
      (this.state === "thinking" || this.state === "listening") &&
      now - this.lastProgressSpokenAt >= PROGRESS_GAP_MS &&
      now - this.lastUserTurnAt >= PROGRESS_AFTER_TURN_MS;

    if (allowed) {
      this.lastProgressSpokenAt = now;
      this.speakInterjection(clean);
      return;
    }
    this.emit();
  }

  /**
   * The host has spoken what streamed and is now making the spoken summary of
   * the rest (`spokenDigest.ts`: the model's sentences are spoken as they
   * arrive; the wait for the first one is budgeted by `digestBudgetMs`).
   * Until that first sentence arrives through `enqueueSpeechChunk` the orb
   * shows "thinking", not a silent "speaking". If sentences are still being
   * read the switch waits for the queue to drain.
   */
  noteDigesting(): void {
    if (this.mode !== "conversation" || !this.settings.speakReplies || this.isStreamDone) return;
    this.digesting = true;
    // Caption for the wait; the step commentary it replaces is finished.
    this.narration = "Summing up the reply.";
    const quiet = this.suspendedSpeech === null && !this.isProcessingSpeechQueue && this.speechQueue.length === 0;
    if (quiet && this.state === "speaking") this.setState("thinking");
  }

  /** Say one line now, ahead of anything queued, then return to whatever the run is doing. */
  private speakInterjection(text: string): void {
    const clean = speakableText(text).trim();
    if (!clean || this.mode !== "conversation" || !this.settings.speakReplies || !this.providers?.tts) {
      this.setState(this.host.isBusy?.() ? "thinking" : this.mode === "conversation" ? "listening" : "idle");
      this.emit();
      return;
    }
    this.narration = clean;
    this.interjecting = true;
    this.speechQueue.unshift(clean);
    if (!this.isProcessingSpeechQueue) void this.processSpeechQueue();
    this.emit();
  }

  /** Stop talking and forget what was queued. The run itself is untouched. */
  private dropSpeech(): void {
    this.suspendedSpeech = null;
    this.speechQueue = [];
    this.isProcessingSpeechQueue = false;
    this.interjecting = false;
    this.digesting = false;
    this.currentlySpeakingText = null;
    this.synthesis?.cancel();
    this.synthesis = null;
    this.echo.markEnded();
  }

  private callInterrupt(): void {
    try {
      this.host.interrupt?.();
    } catch {
      // The host's failure to stop is not the microphone's problem.
    }
  }

  /** Remove the assistant's own voice from a recogniser result; "" when it was all echo. */
  private withoutEcho(text: string): string {
    if (!text) return text;
    const verdict = this.echo.filter(text);
    return verdict.echoed ? verdict.text : text;
  }

  /** A local completion that gives up — and cancels — after `ms`. */
  private async completeWithin(prompt: string, ms: number): Promise<string> {
    if (!this.host.complete) return "";
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    this.abort?.signal.addEventListener("abort", onAbort, { once: true });
    const timer = window.setTimeout(() => controller.abort(), ms);
    try {
      return await this.host.complete(prompt, controller.signal);
    } finally {
      window.clearTimeout(timer);
      this.abort?.signal.removeEventListener("abort", onAbort);
    }
  }

  private handleBargeIn(): void {
    // Preserve in-flight and queued speech so that if the sound turns out to be
    // non-speech or unrelated noise (cough, keyboard clicks, breathing), the
    // assistant can cleanly resume talking right where it left off.
    if (this.interjecting) {
      // Running commentary is disposable: "Reading types dot ts" from before the
      // operator spoke is stale by the time the turn is decided. A reply that an
      // earlier barge-in already put aside is kept.
      this.suspendedSpeech = this.suspendedSpeech ?? [];
      this.speechQueue = [];
      this.currentlySpeakingText = null;
    } else if (this.currentlySpeakingText) {
      this.suspendedSpeech = [this.currentlySpeakingText, ...this.speechQueue];
      this.speechQueue = [];
      this.currentlySpeakingText = null;
    } else if (this.speechQueue.length > 0) {
      this.suspendedSpeech = [...this.speechQueue];
      this.speechQueue = [];
    } else {
      this.suspendedSpeech = [];
    }

    this.isProcessingSpeechQueue = false;
    this.interjecting = false;
    this.synthesis?.cancel();
    this.synthesis = null;
    this.echo.markEnded();
    this.graph.setDucked(false);
    // Note: Do NOT abort the chat turn yet! We listen to what was said first.
    this.endpointer.reset();
    this.setState("hearing");
    this.turnStartedAt = Date.now();
  }

  /** Reset the 1-minute inactivity timer (called on user typing, click, or speech). */
  touch(): void {
    this.lastActivityAt = Date.now();
  }

  /**
   * Called when the session has been completely inactive for 1 minute.
   * Plays a natural, casual chill/sleep template line and transitions to idle.
   */
  private async goToSleep(): Promise<void> {
    if (this.isGoingToSleep || this.state !== "listening") return;
    this.isGoingToSleep = true;
    const templates = [
      "I'm going to chill for now. Just say 'Hey Temy' when you need me.",
      "Going into chill mode. Say 'Hey Temy' whenever you're ready.",
      "I'll take a breather and let you focus. Just say 'Hey Temy' if you need a hand.",
      "Heading to sleep for a bit. Say 'Hey Temy' to wake me up.",
      "Stepping aside for now. Holler with 'Hey Temy' whenever you want to jump back in.",
      "I'll hang out in the background. Just say 'Hey Temy' when you need me.",
    ];
    const farewell = templates[Math.floor(Math.random() * templates.length)];
    try {
      await this.speakAside(farewell);
    } finally {
      this.isGoingToSleep = false;
      await this.stop();
    }
  }

  /** Host hook: stop speaking without it counting as an interruption. */
  silence(): void {
    this.suspendedSpeech = null;
    this.currentlySpeakingText = null;
    this.speechQueue = [];
    this.isProcessingSpeechQueue = false;
    this.isStreamDone = false;
    this.interjecting = false;
    this.digesting = false;
    this.synthesis?.cancel();
    this.synthesis = null;
    this.echo.markEnded();
    this.graph.setDucked(false);
    this.assistantTurnEndedAt = Date.now();
    if (this.state === "speaking") this.setState("listening");
  }

  /* ── Plumbing ──────────────────────────────────────────────────────────── */

  private startTicker(): void {
    this.stopTicker();
    this.lastActivityAt = Date.now();
    this.isGoingToSleep = false;
    // Drives the auto-send countdown in the HUD and checks 1-minute inactivity sleep.
    this.tickTimer = window.setInterval(() => {
      if (this.autoSendDeadline) this.emit();

      if (
        this.mode === "conversation" &&
        this.state === "listening" &&
        !this.isGoingToSleep &&
        Date.now() - this.lastActivityAt >= VoiceEngine.INACTIVITY_SLEEP_MS
      ) {
        void this.goToSleep();
      }
    }, 500);
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
