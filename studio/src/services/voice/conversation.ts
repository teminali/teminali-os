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
import { Endpointer, DEFAULT_ENDPOINTER, endpointStall } from "./turnTaking";
import type { StallCheck } from "./turnTaking";
import { ProsodyTracker } from "./prosody";
import {
  applyClassifier,
  CLASSIFIER_NONSENSE,
  classifierPrompt,
  parseClassifier,
  scoreAddressing,
  stripWakeWord,
  type AddressingContext,
} from "./addressing";
import { SpeakerProfile, type EnrolledProfile } from "./speakerProfile";
import { classifyTurnIntent, type TurnIntentVerdict } from "./turnIntent";
import { selfAudio } from "./selfAudio";
import { EchoGuard } from "./echoGuard";
import { AmbientMemory, classifyAmbientQuery } from "./ambientMemory";
import { cleanTranscript, isNonSpeechOrBlank, polishIsTrustworthy, polishPrompt, repairDeterministic, withPolish } from "./transcriptRepair";
import { scorePlausibility } from "./plausibility";
import { createRoster, probeAll, resolve, type ProviderRoster, type ResolvedProviders } from "./providers";
import {
  DEFAULT_LANGUAGE,
  DEFAULT_VOICE_SETTINGS,
  VoiceError,
  type AddressingVerdict,
  type AmbientSound,
  type PreparedSpeech,
  type RecognitionSession,
  type RepairedTranscript,
  type SubmitOptions,
  type SynthesisHandle,
  type VoiceMode,
  type VoiceProvider,
  type VoiceSettings,
  type VoiceState,
} from "./types";
import { readyToWarmNext } from "./speechStream";

/** What the engine needs from the application around it. */
export interface VoiceHost {
  /**
   * Hand an approved utterance to the chat.
   *
   * The second argument tells the host the words were heard, not typed, so the
   * turn can be framed as a transcript. It is optional on purpose: a host that
   * ignores it keeps working exactly as it did.
   */
  submit: (text: string, options?: SubmitOptions) => void | Promise<void>;
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
  /** The operator silenced the microphone; the conversation is still open. */
  muted: boolean;
  /** The latest progress or interjection line — what the assistant last said about the run. */
  narration: string | null;
  /** How the last committed utterance was read: stop, acknowledge, status, or instruction. */
  lastIntent: (TurnIntentVerdict & { text: string; at: number }) | null;
}

type Listener = (snapshot: VoiceSnapshot) => void;

/** Sustained speech needed to count as a barge-in rather than a cough or speaker bleed. */
const BARGE_IN_FRAMES = 18;
/**
 * How little it takes to talk over the greeting: three frames, 60 ms.
 *
 * `BARGE_IN_FRAMES` is 18 — 360 ms of *unbroken* voicing — because cutting a
 * reply short on a cough is worse than finishing the sentence. The greeting is
 * the opposite case. It plays at the one moment the operator has just reached
 * for the microphone and is therefore most likely to be talking already, and
 * nothing is lost by abandoning it: it says "hey there", not an answer.
 */
const GREETING_YIELD_FRAMES = 3;
/** Minimum gap between spoken progress lines, so a busy run speaks timely step updates without droning. */
const PROGRESS_GAP_MS = 1500;
/** No progress line this soon after the operator spoke; the reply to them comes first. */
const PROGRESS_AFTER_TURN_MS = 1200;
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
  /** The language the recogniser decoded this turn as, when it reports one. */
  private turnLanguage = "";
  /**
   * The weakest confidence any part of this turn came back with, or -1 when
   * the engine reported none. The weakest rather than the last, because an
   * utterance assembled from several results is only as trustworthy as its
   * shakiest piece, and it is the shaky piece that carries the hallucination.
   */
  private turnConfidence = -1;
  private pending: RepairedTranscript | null = null;
  private verdict: AddressingVerdict | null = null;
  private lastRejected: VoiceSnapshot["lastRejected"] = null;
  private error: VoiceError | null = null;
  private interrupted = false;
  private speechQueue: string[] = [];
  private isProcessingSpeechQueue = false;
  /** The next block's audio, started while the current one is still being heard. */
  private preparedSpeech: PreparedSpeech | null = null;
  private isStreamDone = false;
  private suspendedSpeech: string[] | null = null;
  private currentlySpeakingText: string | null = null;
  /*
    Which reply the audio in flight belongs to.

    `tts.speak()` does not resolve until the sidecar has rendered and scheduled
    the first clause, and until it does there is no `SynthesisHandle` to cancel
    — so `dropSpeech()` had nothing to stop, and a reply the operator had
    already talked over began playing the moment its render landed. The epoch
    is bumped by every drop; a `speak()` whose epoch is stale by the time it
    resolves cancels itself instead of speaking.
  */
  private speechEpoch = 0;
  /** A `speak()` is in flight and has not yet produced an audible clause. */
  private speechPending = false;
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
  private hasSpokenInSession = false;
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

  /**
   * The longest a single utterance may run before we call it over ourselves.
   *
   * `speech-end` is the only thing that commits a turn, and everything that
   * produces it — the frame pump, the VAD, the endpointer's silence window —
   * sits upstream of this class. When any of them stalls, `hearing` is a latch
   * with no way out: the recogniser keeps appending, so ten separate attempts
   * pile into one growing caption and none of them is ever sent. That is the
   * failure this bound exists for, and it is the same argument that gave
   * `awaitingFinal` its fallback — no latch without an exit.
   *
   * 15s is well past any conversational turn and still short enough that the
   * operator reads it as a delay rather than a hang.
   */
  public static readonly MAX_UTTERANCE_MS = 15000;

  /**
   * How long without an audio frame means the graph, not the speaker, went
   * quiet. The pump runs at `fps` (20ms at 50fps); two seconds of nothing is
   * not a pause.
   */
  public static readonly FRAME_STALL_MS = 2000;

  private autoSendTimer: number | null = null;
  private autoSendDeadline: number | null = null;
  private tickTimer: number | null = null;

  private assistantTurnEndedAt = 0;
  private assistantAskedQuestion = false;
  private bargeInRun = 0;
  /** True from the moment the opening line is asked for until it is spoken, abandoned or dropped. */
  private greeting = false;
  private greetingYieldRun = 0;
  private turnStartedAt = 0;
  /** When the last audio frame arrived; 0 before the graph has produced one. */
  private lastFrameAt = 0;
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
  /** Watchdog timer so speech synthesis can never hang the engine in speaking state indefinitely. */
  private speechWatchdogTimer: number | null = null;
  /** A reopen `onClose` skipped because a final transcript was still expected. */
  private reopenDeferred = false;
  /** A `reopen()` is between its guard and its `listen()`. See `reopen`. */
  private reopening = false;
  private abort: AbortController | null = null;

  private host: VoiceHost;

  constructor(host: VoiceHost) {
    this.host = host;
    this.graph = new AudioGraph({ onFrame: (frame) => this.onFrame(frame) });
    this.profile = SpeakerProfile.load();
    // The endpointer otherwise runs on its own defaults until the first
    // `configure()` — which never arrives if the operator never opens settings.
    this.applyEndpointerWindow();
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
      muted: this.graph.isMuted(),
      narration: this.narration,
      lastIntent: this.lastIntent,
    };
  }

  /**
   * Silence or restore the microphone without ending the conversation.
   *
   * A muted turn is also a discarded turn: whatever was part-heard when the
   * operator reached for mute is exactly what they did not want sent, so the
   * in-flight transcript and its auto-send countdown go with it. Leaving them
   * would send the sentence a moment after being told not to.
   */
  setMuted(muted: boolean): void {
    if (this.graph.isMuted() === muted) return;
    this.graph.setMuted(muted);
    if (muted) {
      this.transcript = "";
      this.autoSendDeadline = null;
    }
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private setState(state: VoiceState): void {
    if (this.state === state) return;
    this.state = state;

    if (this.mode === "conversation") {
      if (state === "listening") {
        this.endpointer.reset();
        if (!this.streamingAsr && (!this.session?.active || this.reopenDeferred)) {
          this.reopenDeferred = false;
          void this.reopen();
        }
      } else if ((state === "hearing" || state === "thinking") && !this.streamingAsr && (!this.session?.active || this.reopenDeferred)) {
        this.reopenDeferred = false;
        void this.reopen();
      } else if (state === "speaking" && !this.streamingAsr && this.session?.active && !this.greeting) {
        /*
          The recogniser is closed while the assistant talks so that a
          one-shot transcriber does not write down the assistant's own voice.

          Not for the greeting. The greeting is spoken the instant the session
          opens — the same instant the operator, having just tapped to talk,
          starts their sentence — and closing the microphone for it made the
          app deaf for exactly as long as it was saying "hey there". The
          operator: *"during that window it seems I can not interrupt it,
          because normally as soon as I tap to talk I start talking."* Their
          words were not being ignored, they were never recorded, and the
          sentence had to be repeated until one landed in a gap.

          Leaving it open is safe here in a way it is not for a reply, because
          the greeting is one short string this engine chose: `echoGuard` was
          handed it verbatim a few lines above and strips it from anything the
          microphone brings back.
        */
        this.reopenDeferred = true;
        this.session.abort();
      }
    }

    this.emit();
  }

  /* ── Configuration ─────────────────────────────────────────────────────── */

  configure(patch: Partial<VoiceSettings>): void {
    const tierChanged = patch.tier !== undefined && patch.tier !== this.settings.tier;
    this.settings = { ...this.settings, ...patch };
    this.applyEndpointerWindow();
    if (tierChanged) void this.probe();
    this.emit();
  }

  /**
   * Turn the one exposed setting into the endpointer's two windows.
   *
   * The setting is the window for a turn whose finish is uncertain; a clearly
   * finished one releases at 0.7× and a dangling clause holds to 2×. The
   * endpointer's learned pacing floor sits on top of this and is untouched by
   * a settings change.
   *
   * The ceiling used to be `Math.max(setting * 2, DEFAULT_ENDPOINTER.maxSilenceMs)`,
   * which floored every choice at the balanced default's 1800 ms — so "Snappy —
   * 0.6s" bought a faster release on a *confident* ending and nothing at all on
   * a hesitant one, which is the case the operator actually waits through.
   * Picking the fast setting now means it: 0.6 runs 420–1200 ms where it used
   * to run 420–1800. The absolute floor is the endpointer's own
   * `minUtteranceMs` doubled — below that a window is shorter than the
   * shortest thing it is allowed to call an utterance.
   */
  private applyEndpointerWindow(): void {
    this.endpointer.configure({
      minSilenceMs: Math.max(400, Math.round(this.settings.endpointSilenceMs * 0.7)),
      maxSilenceMs: Math.max(DEFAULT_ENDPOINTER.minUtteranceMs * 2, Math.round(this.settings.endpointSilenceMs * 2)),
    });
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
    this.turnLanguage = "";
    this.pending = null;
    this.verdict = null;
    this.narration = null;
    this.lastIntent = null;
    this.interjecting = false;
    this.lastProgressSpokenAt = 0;
    this.lastAckSpokenAt = 0;
    this.lastUserTurnAt = 0;
    this.hasSpokenInSession = false;
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
          hints: this.recognitionHints(),
          sounds: this.settings.ambientMemory,
          signal: this.abort.signal,
        },
        {
          onResult: (result) => this.onResult(result.transcript, result.isFinal, result.language, result.confidence),
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
            if (!this.streamingAsr && (this.state === "speaking" || this.state === "thinking" || this.state === "sending" || this.state === "deciding")) {
              this.reopenDeferred = true;
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
    this.greeting = false;
    this.greetingYieldRun = 0;
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
    this.clearSpeechWatchdog();
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
    // When the assistant is speaking, this.level is driven exclusively by TTS audio output (via onAudioLevel).
    // Do not allow microphone background noise to flap the assistant mouth while speaking.
    if (this.state !== "speaking") {
      this.level = frame.level;
    }
    this.lastFrameAt = frame.at;
    if (frame.voiced || this.state === "speaking" || this.state === "thinking" || this.state === "sending") {
      this.lastActivityAt = Date.now();
    }

    // While the assistant is actively speaking, we watch for an interruption / barge-in.
    if (this.state === "speaking") {
      /*
        The greeting is a courtesy, not a turn, so it does not get barge-in's
        benefit of the doubt: three voiced frames and it stands down, and this
        frame falls through to the endpointer as the operator's own. Barge-in's
        `selfAudio` suppression is skipped with it — that rule exists to stop a
        film in the Files panel cutting a reply off, and no film is playing two
        frames after the microphone opened.
      */
      if (this.greeting) {
        this.greetingYieldRun = frame.voiced ? this.greetingYieldRun + 1 : 0;
        if (this.greetingYieldRun < GREETING_YIELD_FRAMES) {
          this.emit();
          return;
        }
        this.greetingYieldRun = 0;
        this.abandonGreeting();
      } else {
        if (!this.settings.allowBargeIn) return;
        /*
          A film is not an interruption. Our own playback arrives as a long run
          of voiced frames, which is precisely the shape barge-in looks for, so
          a video playing in the Files panel cut the assistant off mid-sentence
          as reliably as the operator could. See services/voice/selfAudio.ts.
        */
        if (selfAudio.audible) {
          this.bargeInRun = 0;
          this.emit();
          return;
        }
        this.bargeInRun = frame.voiced ? this.bargeInRun + 1 : 0;
        if (this.bargeInRun >= BARGE_IN_FRAMES) {
          this.bargeInRun = 0;
          this.handleBargeIn();
        }
        this.emit();
        return;
      }
    }

    // "thinking" is a tool run or a generation in flight, and it is precisely
    // when the operator is most likely to say "stop". Dropping frames here is
    // what made the microphone deaf for the length of a long run: the
    // endpointer never saw speech start or end, so no turn was ever committed
    // and the word never reached the intent gate in `commitTurn`.
    if (this.state !== "listening" && this.state !== "hearing" && this.state !== "thinking") {
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

  private onResult(transcript: string, isFinal: boolean, language: string, confidence = -1): void {
    /*
      Words are better evidence than voiced frames, and they can arrive first.
      The microphone stays open through the greeting now, so a recogniser that
      is already returning text has settled the question the frame counter was
      still counting towards: someone is talking, and it is not us.
    */
    if (this.greeting && this.withoutEcho(cleanTranscript(transcript)).trim()) this.abandonGreeting();
    // Kept, not discarded: a turn decoded as a language the operator does not
    // speak is a hallucination, and this is the only place it is reported.
    if (isFinal && language) this.turnLanguage = language;
    if (confidence >= 0) {
      this.turnConfidence = this.turnConfidence < 0 ? confidence : Math.min(this.turnConfidence, confidence);
    }
    // The recogniser hears the speakers as well as the operator. Anything that
    // is the assistant's own voice coming back is removed before it can become
    // part of a turn.
    const cleanPart = this.withoutEcho(cleanTranscript(transcript));
    if (!cleanPart && !this.transcript) {
      if (isFinal && (this.awaitingFinal || this.state === "deciding")) {
        this.awaitingFinal = false;
        this.setState(this.restingState());
      }
      return;
    }

    if (isFinal) this.finalTranscript = this.finalTranscript ? `${this.finalTranscript} ${cleanPart}`.trim() : cleanPart;
    this.transcript = isFinal ? this.finalTranscript : `${this.finalTranscript} ${cleanPart}`.trim();
    if (this.state === "listening" && this.transcript) this.setState("hearing");
    this.emit();

    // A stop cannot wait for the endpointer to call the turn over; see `fastStop`.
    if (this.fastStop(this.transcript, isFinal)) return;

    // The one-shot path or delayed ASR stream: the turn already ended, and this is the text it was waiting for.
    if ((isFinal || this.transcript.trim()) && (this.awaitingFinal || this.state === "deciding")) {
      this.awaitingFinal = false;
      void this.commitTurn();
    }
  }

  /**
   * The words to tell the recogniser about before it hears anything.
   *
   * The wake words lead, because they are the most-spoken words in the app and
   * the ones a general recogniser is least equipped for: `whisper-base` heard
   * "Temy" as "Temi" every time, and no after-the-fact repair can fix it —
   * `lexicon.ts` matches on a consonant skeleton and "TM" is below its minimum
   * length, so the only place to say it is the decoder's prompt. The host's own
   * hints — the open project's file and folder names — follow.
   */
  private recognitionHints(): string[] {
    return [...this.settings.wakeWords, ...(this.host.hints?.() ?? [])];
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
      this.setState(this.restingState());
      // The engine closed while we were waiting and onClose declined to
      // reopen because of the flag we have just cleared.
      if (this.reopenDeferred && this.mode === "conversation" && this.state !== "idle") {
        this.reopenDeferred = false;
        void this.reopen();
      }
      this.emit();
    }, afterMs);
  }

  /**
   * End the turn without a `speech-end`, because none is coming.
   *
   * Deliberately not a copy of the endpointer path: there is no flush-and-wait
   * here, because the reason we are in this method is that something upstream
   * stopped answering and waiting on it again would only re-arm the hang. If
   * there is text, it is a turn; if there is not, the microphone goes back to
   * resting rather than staying lit over nothing.
   */
  private forceEndpoint(stall: StallCheck): void {
    console.warn(
      `[voice] utterance ceiling: ${Math.round(stall.overranMs / 1000)}s in "hearing" with no endpoint; ` +
        (stall.cause === "frame-pump"
          ? "the audio graph has produced no frame — the frame pump stalled."
          : "frames are still arriving — the VAD or the silence window did not close the turn."),
    );
    this.prosody.reset();
    this.endpointer.reset();
    if (this.transcript.trim()) {
      void this.commitTurn();
      return;
    }
    this.transcript = "";
    this.setState(this.restingState());
    this.emit();
  }

  private clearFinalFallback(): void {
    if (this.finalFallbackTimer !== null) window.clearTimeout(this.finalFallbackTimer);
    this.finalFallbackTimer = null;
  }

  /**
   * Is a listening session still wanted?
   *
   * A method, not an inline `this.state !== "idle"`: the compiler narrows a
   * `this` property from an earlier guard and does not widen it again across
   * an `await`, so written inline the post-open check reads as dead code to
   * TypeScript — which is exactly the case it exists for, the state having
   * changed while the recogniser was opening.
   */
  private stillWanted(): boolean {
    return this.state !== "idle" && !this.abort?.signal.aborted;
  }

  private async reopen(): Promise<void> {
    this.reopenDeferred = false;
    const asr = this.providers?.asr;
    if (!asr || this.state === "idle" || this.abort?.signal.aborted) return;

    /*
      **One pair of ears.** `asr.listen()` is awaited, and every caller tests
      `!this.session?.active` *before* that await — so two reopens racing the
      same gap both pass the test, both open a recogniser, and the second
      assignment orphans the first. The orphan is not stopped by anything: it
      keeps running on the same microphone with its handler still pointing at
      `onResult`, so one spoken sentence arrives as two finals and the engine,
      which builds a turn by appending finals, writes it down twice —
      *"How are you doing? How are you doing?"* from a single utterance.

      `webSpeech.ts` already guards the same symptom *within* a session
      (`finalsDelivered`); that guard cannot see a second session, which is why
      it did not catch this one. Two ways to hear double, two guards.
    */
    if (this.reopening) return;

    /*
      A live session is already the one pair of ears. Reopening over it costs
      the operator the sentence they are in the middle of saying.

      `abort` is not a polite close. On the non-streaming tier — which is what
      the local whisper sidecar reports (`server/voice.js` answers
      `streaming: false`, and `vibeVoice.ts` takes `streamingAsr` from that) —
      the whole utterance is buffered in the recorder and transcribed in
      `onstop`. `close()` sets `active = false` *before* it stops the recorder,
      so `onstop` finds `active` false, emits neither a transcript nor an empty
      final, and the audio is discarded without ever being sent. The graceful
      `stop()` leaves `active` true and is the only path that transcribes.

      The callers reach here on `!this.session?.active || this.reopenDeferred`,
      and a stale `reopenDeferred` is enough on its own: `setState("hearing")`
      fires on `speech-start`, so the reopen landed on the first syllable of a
      turn and threw it away. That is what "it took 3 attempts to capture
      'hello how are you'" was made of. The flag is cleared and the ears kept.
    */
    if (this.session?.active) return;

    this.reopening = true;
    // Nothing may outlive the assignment below.
    this.session?.abort();
    this.session = null;

    try {
      const session = await asr.listen(
        {
          language: this.settings.language,
          continuous: true,
          interim: true,
          hints: this.recognitionHints(),
          sounds: this.settings.ambientMemory,
          signal: this.abort?.signal,
        },
        {
          onResult: (result) => this.onResult(result.transcript, result.isFinal, result.language, result.confidence),
          onSound: (sounds) => this.rememberSounds(sounds),
          onError: (error) => this.fail(error),
          onClose: () => {
            if (this.state === "idle") return;
            if (this.awaitingFinal) {
              this.reopenDeferred = true;
              return;
            }
            if (!this.streamingAsr && (this.state === "speaking" || this.state === "thinking" || this.state === "sending" || this.state === "deciding")) {
              this.reopenDeferred = true;
              return;
            }
            if (this.mode === "conversation") void this.reopen();
          },
        },
      );
      /*
        The session was stopped while this one was opening. Without this the
        microphone comes back up *after* voice mode was switched off, and
        nothing holds a reference to close it.
      */
      if (!this.stillWanted()) {
        session.abort();
        return;
      }
      this.session = session;
    } catch (error) {
      this.fail(error instanceof VoiceError ? error : new VoiceError((error as Error).message, "ASR_FAILED"));
    } finally {
      this.reopening = false;
    }
  }

  /* ── Turn commitment ───────────────────────────────────────────────────── */

  private resumeSuspendedSpeech(): void {
    const suspended = this.suspendedSpeech;
    this.suspendedSpeech = null;
    this.endpointer.reset();

    if (suspended && suspended.length > 0) {
      this.speechQueue = [...suspended, ...this.speechQueue];
      // Thinking until a clause is audible, like every other speak path.
      this.setState("thinking");
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
    const confidence = this.turnConfidence;
    // Read before the reset below, exactly like `confidence`. Left as a field
    // read at the `scorePlausibility` call site it was always the empty string
    // by the time the gate saw it, and the foreign-language rule — the whole
    // point of carrying the language this far — could never fire.
    const language = this.turnLanguage;
    this.transcript = "";
    this.finalTranscript = "";
    this.turnLanguage = "";
    this.turnConfidence = -1;
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

    /*
      Our own speakers.

      The echo guard above catches the assistant's voice because we know its
      words. Nothing knows the words of a video in the Files panel or a page in
      the Browser panel, and there is nothing wrong with the transcript of one:
      it is real speech, correctly heard, addressed to nobody here. Every gate
      below this one asks who a sentence was *for*, and a film answers that
      question as convincingly as a person — which is how "OpenAI has blessed
      us" was committed as a turn and answered.

      So while the app is audible the bar is a wake word, and only that. Not a
      closed microphone: "Temy, pause the video" is exactly the turn an
      operator needs most while something is playing, and it still lands.
      See services/voice/selfAudio.ts.
    */
    if (this.mode === "conversation" && selfAudio.audibleSince(this.turnStartedAt)) {
      const addressed = stripWakeWord(heard, this.settings.wakeWords).matched;
      if (!addressed) {
        this.lastRejected = {
          text: heard,
          verdict: {
            directed: false,
            confidence: 0.9,
            reason: "The app was playing audio; only a turn that names the assistant is taken.",
            signals: { wakeWord: false, speakerMatch: null, followUpWindow: false, classifier: null, imperative: false },
          },
        };
        // Deliberately not written to ambient memory. That log is for the
        // room — "what did she just say?" — and a film we played ourselves is
        // not the room; a two-hour recording would be all that was left in it.
        this.emit();
        this.resumeSuspendedSpeech();
        return;
      }
    }

    /*
      Words, but not necessarily *spoken* words.

      `cleanTranscript` strips artefacts it can recognise as artefacts and
      `isNonSpeechOrBlank` catches an empty result, but neither can tell that a
      grammatical-looking line was a recogniser looping on room noise. That is
      what committed "Olof, siri e prole, olof, olof, olof, olof." as a turn
      and aborted the command that was running. The check happens here, ahead
      of the addressing gate, because addressing asks who a sentence was for
      and this asks whether there was a sentence at all — and because the
      operator asked for the rejection to land before the text becomes a
      prompt.
    */
    const plausibility = scorePlausibility(heard, {
      confidence,
      language,
      expected: this.expectedLanguages(),
    });
    if (!plausibility.plausible) {
      this.lastRejected = {
        text: heard,
        verdict: {
          directed: false,
          confidence: 0.95,
          reason: plausibility.reason,
          signals: { wakeWord: false, speakerMatch: null, followUpWindow: false, classifier: null, imperative: false },
        },
      };
      if (this.settings.ambientMemory) {
        // Kept for the same reason a rejected turn is: "what was that noise?"
        // is answerable, and the clip has already been paid for.
        this.ambient.remember({
          kind: "speech",
          text: heard,
          speaker: "unknown",
          confidence: confidence >= 0 ? confidence : 0,
          reason: plausibility.reason,
        });
      }
      this.emit();
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
      this.applyStop(hostBusy);
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
      const isOngoing = this.hasSpokenInSession || Boolean(this.host.lastAssistantText?.()?.trim());
      const greetingReply = isOngoing
        ? "How can I assist you now?"
        : (this.settings.greeting?.trim() || "Hey! What are we building today?");
      this.hasSpokenInSession = true;
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

  /**
   * The languages the operator speaks, as base tags, for the foreign-language
   * rule in `plausibility.ts`.
   *
   * A pinned language setting is an exact answer and narrows this to one. On
   * `auto` — the default, and the only setting under which the recogniser can
   * disagree at all — the answer comes from `navigator.languages`, which is
   * the operating system's own ordered list of what this person reads and
   * speaks. That is why the rule can afford to reject outright: the list is
   * the operator's, not a guess, and a multilingual operator's languages are
   * already in it. `DEFAULT_LANGUAGE` is added because the product's own
   * language is always understood here.
   */
  private expectedLanguages(): string[] {
    const pinned = this.settings.language;
    if (pinned && pinned !== "auto") return [pinned];
    const fromSystem = typeof navigator !== "undefined" ? [...(navigator.languages ?? [navigator.language])] : [];
    return [...new Set([...fromSystem.filter(Boolean), DEFAULT_LANGUAGE])];
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
      if (adjustment === null) return verdict;
      /*
        Not "addressed to someone else" — *not speech*. The deterministic
        layers reject what they can prove for free; this is the same round trip
        they already pay for when the cheap signals cannot place an utterance,
        and it catches what survives them and is in the right language: room
        noise decoded into real words, a fragment of a video the microphone
        picked up, half of someone else's sentence.
      */
      if (adjustment === CLASSIFIER_NONSENSE) {
        return {
          directed: false,
          confidence: 0.9,
          reason: "The local model read it as not being speech.",
          signals: { ...verdict.signals, classifier: null },
        };
      }
      return applyClassifier(verdict, adjustment);
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
    this.hasSpokenInSession = true;
    this.clearAutoSend();
    if (!value) {
      this.setState(this.mode === "conversation" ? "listening" : "idle");
      return;
    }

    this.setState("sending");
    try {
      // Every utterance that leaves here was heard through a microphone, so
      // the chat is told as much and can frame it as a transcript.
      await this.host.submit(value, { origin: "voice" });
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

    const epoch = this.speechEpoch;
    this.speechPending = true;
    this.greeting = true;
    this.greetingYieldRun = 0;
    this.echo.remember(this.settings.greeting);
    try {
      const handle = await tts.speak({
        text: this.settings.greeting.trim(),
        // Rendering the greeting takes long enough that the operator can be
        // mid-sentence by the time its audio is ready. `beginAudibleSpeech`
        // refuses the floor in that case, and a greeting that cannot have the
        // floor is not worth saying at all.
        onStart: () => {
          if (!this.beginAudibleSpeech(epoch)) this.abandonGreeting();
        },
        language: this.settings.language === "auto" ? navigator.language : this.settings.language,
        voice: this.settings.ttsVoice ?? undefined,
        rate: paceFor(this.settings.ttsRate, this.settings.greeting),
        onAudioLevel: (lvl) => {
          if (this.state === "speaking") {
            this.level = lvl;
            this.emit();
          }
        },
        onEnd: () => {
          this.greeting = false;
          this.level = 0;
          this.synthesis = null;
          this.echo.markEnded();
          this.graph.setDucked(false);
          if (this.state === "speaking") this.setState("listening");
        },
      });
      if (epoch !== this.speechEpoch) {
        this.greeting = false;
        handle.cancel();
        return;
      }
      this.synthesis = handle;
    } catch {
      this.greeting = false;
      this.speechPending = false;
      this.level = 0;
      this.echo.markEnded();
      this.graph.setDucked(false);
      // "speaking" only if a clause got out before it failed; otherwise this is
      // still the thinking state the wait was shown as.
      if (this.state === "speaking" || this.state === "thinking") this.setState("listening");
    }
  }

  /**
   * Stand down mid-greeting, because the operator is talking.
   *
   * Bumping the epoch is what makes this safe to call before `tts.speak()` has
   * resolved: the handle that arrives afterwards fails its own epoch check and
   * cancels itself, so there is no window in which the greeting comes back
   * after being abandoned. The state goes to `listening` rather than `hearing`
   * because nothing has been transcribed yet — `onFrame` falls straight through
   * to the endpointer on the same frame, and the operator's sentence is timed
   * from its real beginning rather than from wherever the greeting let go.
   */
  private abandonGreeting(): void {
    if (!this.greeting) return;
    this.greeting = false;
    this.greetingYieldRun = 0;
    this.speechEpoch += 1;
    this.speechPending = false;
    this.synthesis?.cancel();
    this.synthesis = null;
    this.echo.markEnded();
    this.graph.setDucked(false);
    this.level = 0;
    if (this.state === "speaking") this.setState(this.transcript ? "hearing" : "listening");
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
    if (!this.settings.speakReplies) {
      if (isFinal) {
        this.assistantTurnEndedAt = Date.now();
        if (this.state !== "idle") this.setState(this.mode === "conversation" ? "listening" : "idle");
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
      this.finishSpeaking();
    }
  }

  private finishSpeaking(): void {
    this.clearSpeechWatchdog();
    this.graph.setDucked(false);
    this.level = 0;
    this.assistantTurnEndedAt = Date.now();
    if (this.state === "speaking" || this.state === "thinking") {
      this.setState(this.mode === "conversation" ? "listening" : "idle");
    }
    if (!this.streamingAsr && this.mode === "conversation" && this.state === "listening" && !this.session?.active) {
      void this.reopen();
    }
    this.emit();
  }

  private armSpeechWatchdog(text: string): void {
    this.clearSpeechWatchdog();
    const timeoutMs = Math.max(14000, text.length * 150);
    this.speechWatchdogTimer = window.setTimeout(() => {
      this.speechWatchdogTimer = null;
      // `speechPending` too: the wait for a clause is shown as thinking now, and
      // a synthesiser that never answers must still be given up on.
      if (this.currentlySpeakingText === text && (this.state === "speaking" || this.speechPending)) {
        console.warn("[VoiceEngine] Speech playback watchdog fired for:", text);
        this.speechPending = false;
        this.level = 0;
        this.currentlySpeakingText = null;
        try {
          this.synthesis?.cancel();
        } catch {}
        this.synthesis = null;
        this.echo.markEnded();
        void this.processSpeechQueue();
      }
    }, timeoutMs);
  }

  /**
   * The first clause of a reply is audible.
   *
   * **The state says what the operator can hear, not what we intend.** Every
   * speak path used to call `setState("speaking")` before awaiting the
   * synthesiser, so the HUD announced speech — and the orb its speaking face —
   * for the whole of the request and the first clause's render. The operator:
   * *"the chatbot starts talking before the voice is starting to get heard."*
   * That window is thinking, and it is now shown as thinking; `speaking`
   * begins on the provider's `onStart`, which both providers fire when the
   * first clause is scheduled.
   *
   * Returns false when the reply was dropped while its audio was rendering, in
   * which case the caller must not speak it.
   */
  private beginAudibleSpeech(epoch: number): boolean {
    if (epoch !== this.speechEpoch) return false;
    /*
      The operator got there first.
      `speaking` closes the recogniser and stops feeding the endpointer, so
      taking the floor from someone who is already mid-sentence does not talk
      over them — it deletes them. Audio that was rendered while they started
      is not worth that, whoever asked for it.
    */
    if (this.state === "hearing" || this.transcript.trim()) return false;
    this.speechPending = false;
    if (this.state !== "idle") this.setState("speaking");
    this.graph.setDucked(true);
    return true;
  }

  private clearSpeechWatchdog(): void {
    if (this.speechWatchdogTimer !== null) {
      window.clearTimeout(this.speechWatchdogTimer);
      this.speechWatchdogTimer = null;
    }
  }

  private async processSpeechQueue(): Promise<void> {
    if (this.speechQueue.length === 0) {
      this.isProcessingSpeechQueue = false;
      this.currentlySpeakingText = null;
      this.discardPreparedSpeech();
      this.clearSpeechWatchdog();
      this.echo.markEnded();
      if (this.interjecting && !this.isStreamDone) {
        // A one-off line has finished; the run it commented on is still going.
        this.interjecting = false;
        this.graph.setDucked(false);
        this.level = 0;
        this.assistantTurnEndedAt = Date.now();
        if (this.state === "speaking") {
          this.setState(this.host.isBusy?.() ? "thinking" : this.mode === "conversation" ? "listening" : "idle");
        }
        if (!this.streamingAsr && this.mode === "conversation" && this.state === "listening" && !this.session?.active) {
          void this.reopen();
        }
        this.emit();
        return;
      }
      this.interjecting = false;
      if (this.isStreamDone) {
        this.isStreamDone = false;
        this.finishSpeaking();
      } else if (this.digesting || this.host.isBusy?.()) {
        // The streamed sentences are spoken and generation / tool run is still in-flight:
        // a pause the orb must show as thinking, not as speech.
        this.graph.setDucked(false);
        this.level = 0;
        this.assistantTurnEndedAt = Date.now();
        if (this.state === "speaking") {
          this.setState("thinking");
        }
        this.emit();
      } else {
        this.finishSpeaking();
      }
      return;
    }

    this.isProcessingSpeechQueue = true;
    const text = this.speechQueue.shift()!;
    this.currentlySpeakingText = text;
    let tts = this.providers?.tts;
    if (!tts && !this.providers) {
      try {
        const probed = await this.probe();
        tts = probed.tts;
      } catch {}
    }
    if (!tts && this.roster.builtin?.capabilities.tts) {
      tts = this.roster.builtin;
    }
    if (!tts || !text) {
      this.currentlySpeakingText = null;
      void this.processSpeechQueue();
      return;
    }

    this.interrupted = false;
    /*
      Not `setState("speaking")` yet — see `beginAudibleSpeech`. Ducking waits
      with it: there is nothing to duck under while the clause is still being
      rendered, and dropping the other audio early only makes the wait louder.
    */
    const epoch = this.speechEpoch;
    this.speechPending = true;
    this.echo.remember(text);

    this.armSpeechWatchdog(text);

    // Audio for this block may already be rendering, warmed while the previous
    // block was still being heard. Anything prepared for other text is stale.
    const prepared = this.preparedSpeech?.text === text ? this.preparedSpeech : null;
    if (this.preparedSpeech && !prepared) this.discardPreparedSpeech();
    this.preparedSpeech = null;

    try {
      const handle = await tts.speak({
        text,
        ...(prepared ? { prepared } : {}),
        onStart: () => this.beginAudibleSpeech(epoch),
        onBoundary: (charIndex) => this.warmNextBlock(tts, text, charIndex),
        language: this.settings.language === "auto" ? navigator.language : this.settings.language,
        voice: this.settings.ttsVoice ?? undefined,
        rate: paceFor(this.settings.ttsRate, text),
        onAudioLevel: (lvl) => {
          if (this.state === "speaking") {
            this.level = lvl;
            this.emit();
          }
        },
        onEnd: () => {
          this.clearSpeechWatchdog();
          this.level = 0;
          this.currentlySpeakingText = null;
          this.synthesis = null;
          this.echo.markEnded();
          void this.processSpeechQueue();
        },
      });
      /*
        The operator talked over this reply while it was still rendering. The
        handle only exists now, which is the first moment it could be stopped.
      */
      if (epoch !== this.speechEpoch) {
        handle.cancel();
        return;
      }
      this.synthesis = handle;
    } catch (ttsErr) {
      this.speechPending = false;
      console.warn("[VoiceEngine] Primary TTS failed, trying built-in speech fallback:", ttsErr);
      const fallback = this.roster.builtin?.capabilities.tts && this.roster.builtin !== tts
        ? this.roster.builtin
        : null;
      if (fallback) {
        try {
          const fallbackHandle = await fallback.speak({
            text,
            onStart: () => this.beginAudibleSpeech(epoch),
            language: this.settings.language === "auto" ? navigator.language : this.settings.language,
            voice: undefined,
            rate: paceFor(this.settings.ttsRate, text),
            onAudioLevel: (lvl) => {
              if (this.state === "speaking") {
                this.level = lvl;
                this.emit();
              }
            },
            onEnd: () => {
              this.clearSpeechWatchdog();
              this.level = 0;
              this.currentlySpeakingText = null;
              this.synthesis = null;
              this.echo.markEnded();
              void this.processSpeechQueue();
            },
          });
          if (epoch !== this.speechEpoch) {
            fallbackHandle.cancel();
            return;
          }
          this.synthesis = fallbackHandle;
          return;
        } catch (fbErr) {
          console.error("[VoiceEngine] Fallback speech synthesis failed:", fbErr);
        }
      }
      this.speechPending = false;
      this.clearSpeechWatchdog();
      this.level = 0;
      this.currentlySpeakingText = null;
      this.synthesis = null;
      this.echo.markEnded();
      void this.processSpeechQueue();
    }
  }

  async speakReply(text: string): Promise<void> {
    const spoken = speakableText(text).trim();
    if (!spoken || isNonSpeechOrBlank(spoken)) {
      this.finishSpeaking();
      return;
    }

    if (!this.settings.speakReplies) {
      this.finishSpeaking();
      return;
    }

    if (!this.providers) {
      try {
        await this.probe();
      } catch {}
    }

    let tts = this.providers?.tts;
    if (!tts && this.roster.builtin?.capabilities.tts) {
      tts = this.roster.builtin;
    }

    if (!tts) {
      this.finishSpeaking();
      return;
    }

    this.hasSpokenInSession = true;
    // Split by paragraphs or coherent thoughts so playback streams seamlessly
    // without introducing 1-second network/synthesis dead-air pauses between every short sentence.
    const rawBlocks = spoken.split(/\n\n+/);
    const speechBlocks: string[] = [];
    for (const block of rawBlocks) {
      const cleanBlock = block.trim();
      if (!cleanBlock) continue;
      const words = cleanBlock.split(/\s+/);
      if (words.length > 60) {
        const sentences = cleanBlock.match(/[^.!?]+(?:[.!?]+|$)/g) || [cleanBlock];
        let currentChunk = "";
        for (const s of sentences) {
          const st = s.trim();
          if (!st) continue;
          if (currentChunk && (currentChunk + " " + st).split(/\s+/).length > 40) {
            speechBlocks.push(currentChunk);
            currentChunk = st;
          } else {
            currentChunk = currentChunk ? `${currentChunk} ${st}` : st;
          }
        }
        if (currentChunk) speechBlocks.push(currentChunk);
      } else {
        speechBlocks.push(cleanBlock);
      }
    }
    this.speechQueue = [];
    this.suspendedSpeech = null;
    this.currentlySpeakingText = null;
    for (const s of speechBlocks) {
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
      this.finishSpeaking();
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
  async speakAside(text: string, options: { expectsAnswer?: boolean } = {}): Promise<void> {
    const spoken = speakableText(text);
    if (!spoken.trim()) return;

    const tts = this.providers?.tts;
    if (!tts) return;

    // Whatever is still in the air is stale the moment a new line arrives.
    this.synthesis?.cancel();
    this.synthesis = null;

    const inSession = this.state !== "idle";
    const epoch = this.speechEpoch;
    this.speechPending = true;

    const restore = () => {
      this.synthesis = null;
      this.echo.markEnded();
      if (!inSession) return;
      this.graph.setDucked(false);
      this.assistantTurnEndedAt = Date.now();
      /*
        An aside that asked something is still the assistant having asked
        something. Without this the follow-up window never opens for it, and
        the addressing gate — which has no idea a prompt is standing — scores
        the bare "yes" that answers it as ambient room speech and drops it
        before the host ever sees it. That is exactly how a spoken permission
        prompt came to read itself out and then ignore the answer.
      */
      if (options.expectsAnswer || /\?\s*$/.test(spoken)) this.assistantAskedQuestion = true;
      if (this.state === "speaking") this.setState("listening");
    };

    this.echo.remember(spoken);
    try {
      const handle = await tts.speak({
        text: spoken,
        onStart: () => {
          if (inSession) this.beginAudibleSpeech(epoch);
          else this.speechPending = false;
        },
        language: this.settings.language === "auto" ? navigator.language : this.settings.language,
        voice: this.settings.ttsVoice ?? undefined,
        rate: paceFor(this.settings.ttsRate, spoken),
        onAudioLevel: (lvl) => {
          if (this.state === "speaking") {
            this.level = lvl;
            this.emit();
          }
        },
        onEnd: () => {
          this.level = 0;
          restore();
        },
      });
      if (epoch !== this.speechEpoch) {
        handle.cancel();
        return;
      }
      this.synthesis = handle;
    } catch {
      this.speechPending = false;
      this.level = 0;
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
    /*
      Silent, or already talking about the run.

      `quiet` used to mean "saying nothing at all", which dropped every step
      that started while an earlier step was still being read — so a run that
      moved faster than the sentence describing it announced its first step and
      then went quiet for a minute. The operator: *"it is not talking through
      all the steps."* Commentary may follow commentary; `speakInterjection`
      queues it behind the line in progress, and `PROGRESS_GAP_MS` is what
      keeps that from becoming a drone.

      A reply is still not interrupted. `interjecting` is false whenever the
      speech in flight is an answer to the operator, and `suspendedSpeech`
      being non-null means a reply is waiting to resume behind a barge-in —
      neither is something a step line may talk over.
    */
    const idle = !this.isProcessingSpeechQueue && this.speechQueue.length === 0;
    const quiet = this.suspendedSpeech === null && (idle || this.interjecting);
    const allowed =
      this.mode === "conversation" &&
      this.settings.speakReplies &&
      this.settings.narrateProgress &&
      quiet &&
      Boolean(this.host.isBusy?.()) &&
      (this.state === "thinking" || this.state === "listening" || (this.state === "speaking" && this.interjecting)) &&
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

  /**
   * Where the engine comes to rest when nothing is being said. A run still in
   * flight is "thinking", not "listening": claiming to listen while the host
   * is working reads as an assistant that dropped the job.
   */
  private restingState(): VoiceState {
    if (this.mode !== "conversation") return "idle";
    return this.host.isBusy?.() ? "thinking" : "listening";
  }

  /**
   * Everything "stop" means: the queued speech is dropped, the ducking it
   * imposed on the room is lifted, the run behind it is cancelled and the
   * operator is told so. Shared by the committed-turn intent gate and the fast
   * path in `onResult`, so a stop cannot mean two different things depending
   * on which of them noticed it first.
   */
  private applyStop(hostBusy: boolean): void {
    this.dropSpeech();
    this.graph.setDucked(false);
    this.level = 0;
    this.assistantTurnEndedAt = Date.now();
    if (hostBusy) {
      this.callInterrupt();
      this.speakInterjection("Okay, stopped.");
      return;
    }
    this.narration = null;
    this.setState(this.mode === "conversation" ? "listening" : "idle");
    this.emit();
  }

  /**
   * "Stop" cannot wait for the endpointer.
   *
   * A turn is only committed once the operator has been quiet long enough for
   * `endpointer` to call it over, and that is the wrong moment for this
   * particular word: it arrives with the assistant mid-sentence or mid-tool-run
   * and has to land on the spot. So every result is read as it arrives, partial
   * included, and a stop is acted on before the silence window.
   *
   * A partial only silences the speaker. That half is free to get wrong — an
   * operator who says "stop" wants the talking to end whatever the rest of the
   * sentence turns out to be — while cancelling the run waits for the final,
   * because "stop" and "stop the dev server" open with the same word and only
   * one of them is a cancel.
   *
   * Returns true when the utterance has been fully dealt with and must not go
   * on to `commitTurn`.
   */
  private fastStop(text: string, isFinal: boolean): boolean {
    if (this.mode !== "conversation") return false;
    const hostBusy = Boolean(this.host.isBusy?.());
    const engaged =
      hostBusy || this.state === "speaking" || this.state === "thinking" || this.state === "sending";
    if (!engaged) return false;

    const { text: withoutWakeWord } = stripWakeWord(text, this.settings.wakeWords);
    const spoken = (withoutWakeWord || text).trim();
    if (!spoken) return false;
    if (classifyTurnIntent(spoken, { busy: true, speaking: true }).intent !== "stop") return false;

    if (!isFinal) {
      // Mid-utterance: go quiet, and nothing more. The run stays the
      // operator's to keep if the sentence lands as "stop the dev server".
      if (this.currentlySpeakingText || this.speechQueue.length > 0 || this.suspendedSpeech !== null) {
        this.dropSpeech();
        this.graph.setDucked(false);
        this.level = 0;
        this.assistantTurnEndedAt = Date.now();
      }
      if (this.state === "speaking") {
        this.endpointer.reset();
        this.turnStartedAt = Date.now();
        this.setState("hearing");
      }
      return false;
    }

    this.clearFinalFallback();
    this.awaitingFinal = false;
    this.transcript = "";
    this.finalTranscript = "";
    this.turnLanguage = "";
    this.endpointer.reset();
    this.lastIntent = { intent: "stop", reason: "Asked to stop.", text: spoken, at: Date.now() };
    this.lastUserTurnAt = Date.now();
    this.applyStop(hostBusy);
    return true;
  }

  /** Stop talking and forget what was queued. The run itself is untouched. */
  private dropSpeech(): void {
    // Anything still rendering belongs to a reply that no longer exists.
    this.speechEpoch += 1;
    this.speechPending = false;
    this.greeting = false;
    this.greetingYieldRun = 0;
    this.clearSpeechWatchdog();
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

    this.clearSpeechWatchdog();
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
   *
   * Every one of these used to end with "just say 'Hey Temy' when you need me",
   * and the line below is `this.stop()` — the conversation ends and the
   * microphone closes. So the last thing Temy said before going deaf was an
   * invitation to talk to her, which is the shape of a bug the operator can
   * only discover by trying it. Nothing listens while idle; the orb is what
   * starts a conversation, so the orb is what these say.
   */
  private async goToSleep(): Promise<void> {
    if (this.isGoingToSleep || this.state !== "listening") return;
    this.isGoingToSleep = true;
    const templates = [
      "I'm going to chill for now. Tap the orb when you need me.",
      "Going into chill mode. The orb is there whenever you're ready.",
      "I'll take a breather and let you focus. Tap the orb if you need a hand.",
      "Heading to sleep for a bit. Tap the orb to wake me up.",
      "Stepping aside for now. Tap the orb whenever you want to jump back in.",
      "I'll hang out in the background. Tap the orb when you need me.",
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
  /**
   * Start rendering the block after this one, while this one is still audible.
   *
   * The synthesiser renders a whole block before a note of it can be played,
   * so a render begun when the previous block ends is heard as a pause between
   * paragraphs — the longer the paragraph, the longer the wait. Begun in the
   * last fifth of the block being spoken, the same render happens under the
   * audio and the next block starts as the current one stops.
   *
   * Only ever one block ahead: two warmed blocks would be two renders queued
   * behind the one being listened to, on a sidecar that renders one at a time.
   */
  private warmNextBlock(tts: VoiceProvider, text: string, charIndex: number): void {
    if (this.preparedSpeech || !tts.prepare || this.interrupted) return;
    if (!readyToWarmNext(charIndex, text.length)) return;
    const next = this.speechQueue[0];
    if (!next) return;
    try {
      this.preparedSpeech = tts.prepare({
        text: next,
        language: this.settings.language === "auto" ? navigator.language : this.settings.language,
        voice: this.settings.ttsVoice ?? undefined,
        rate: paceFor(this.settings.ttsRate, next),
      });
    } catch {
      // A provider that cannot warm one is a provider that speaks it later.
      this.preparedSpeech = null;
    }
  }

  /** Abandon warmed audio nobody is going to play. */
  private discardPreparedSpeech(): void {
    try {
      this.preparedSpeech?.cancel();
    } catch {}
    this.preparedSpeech = null;
  }

  silence(): void {
    this.clearSpeechWatchdog();
    this.discardPreparedSpeech();
    this.suspendedSpeech = null;
    this.currentlySpeakingText = null;
    this.speechQueue = [];
    this.isProcessingSpeechQueue = false;
    this.isStreamDone = false;
    this.interjecting = false;
    this.digesting = false;
    try {
      this.synthesis?.cancel();
    } catch {}
    this.synthesis = null;
    this.echo.markEnded();
    this.finishSpeaking();
  }

  /* ── Plumbing ──────────────────────────────────────────────────────────── */

  private startTicker(): void {
    this.stopTicker();
    this.lastActivityAt = Date.now();
    this.isGoingToSleep = false;
    // Drives the auto-send countdown in the HUD and checks 1-minute inactivity sleep.
    this.tickTimer = window.setInterval(() => {
      if (this.autoSendDeadline) this.emit();

      if (this.state === "hearing") {
        const stall = endpointStall({
          turnStartedAt: this.turnStartedAt,
          lastFrameAt: this.lastFrameAt,
          now: Date.now(),
          maxUtteranceMs: VoiceEngine.MAX_UTTERANCE_MS,
          frameStallMs: VoiceEngine.FRAME_STALL_MS,
        });
        if (stall) this.forceEndpoint(stall);
      }

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
