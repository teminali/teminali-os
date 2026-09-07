/**
 * Turn-taking — deciding when the operator has finished speaking.
 *
 * A fixed silence timer is what makes most voice assistants feel robotic: too
 * short and it cuts you off mid-thought, too long and every exchange drags. We
 * use an adaptive endpointer instead. Silence starts the clock, but how long
 * that clock runs depends on whether the sentence sounds finished, judged two
 * ways and blended:
 *
 *   Syntax — the transcript so far, when the recogniser has given us one:
 *   - trailing "and", "but", "so", a preposition, a comma  → wait longer
 *   - a complete clause with a verb and an object          → fire sooner
 *   - mid-word or mid-number                               → wait longer
 *
 *   Prosody — the audio of the last few hundred milliseconds (`prosody.ts`):
 *   - energy trailing off and pitch falling                → fire sooner
 *   - level energy, or pitch rising (a question, an open   → wait longer
 *     clause)
 *
 *   And either way, a reply to a question we just asked   → fire sooner
 *
 * Prosody matters because a one-shot recogniser (the sidecar's Whisper) has no
 * transcript to offer until the recording closes. Before it was added, that
 * empty transcript scored as "clearly unfinished" and every hands-free turn
 * waited the full ceiling. An unknown syntax now counts as unknown, not as
 * incomplete, and the audio decides.
 *
 * The result is that "open the file, uhh…" holds the turn while "open the file"
 * releases it, which is the difference between an assistant that listens and
 * one that interrupts.
 */

/** Words that almost never end an utterance. */
const CONTINUATION_WORDS = new Set([
  "and", "but", "so", "or", "because", "then", "also", "plus", "with", "to",
  "for", "of", "in", "on", "at", "the", "a", "an", "my", "your", "that", "this",
  "if", "when", "while", "like", "about", "into", "from", "as", "by",
  // Kiswahili connectors — the same rule applies and the list is cheap.
  "na", "lakini", "kwa", "ya", "wa", "kwenye", "halafu", "kisha", "ili",
]);

/** Audible thinking. Their presence means the speaker is still composing. */
const HESITATIONS = new Set([
  "uh", "uhh", "um", "umm", "er", "erm", "hmm", "ah", "eh", "mm",
  "aa", "ee", "mh",
]);

export interface EndpointerConfig {
  /** Floor for the silence window, ms. */
  minSilenceMs: number;
  /** Ceiling for the silence window, ms. */
  maxSilenceMs: number;
  /** Speech shorter than this is treated as a cough, not a turn. */
  minUtteranceMs: number;
  /** Frames of speech needed before we call it a turn start. */
  onsetFrames: number;
  /**
   * The learned pacing floor may not exceed this, ms. A speaker who once
   * stopped for three seconds does not make every turn after it wait three
   * seconds.
   */
  pacingCeilingMs: number;
  /**
   * Speech that starts within this many ms of an endpoint we fired is the
   * same sentence, cut off — not a new turn.
   */
  resumeWindowMs: number;
}

/**
 * The floor and ceiling are the range a person's own pauses fall in. Under
 * ~500 ms is a breath between words; 600–1000 ms is a pause between phrases
 * while the next one is composed; past ~1.8 s even a trailing "and" has been
 * abandoned. The floor was 360 ms (250 ms after a question) until the operator
 * reported being cut off "on most occasions" — a phrase-final pause with the
 * voice falling off read as finished at the floor, every time. See §6.15.
 */
export const DEFAULT_ENDPOINTER: EndpointerConfig = {
  minSilenceMs: 600,
  maxSilenceMs: 1800,
  minUtteranceMs: 220,
  onsetFrames: 3,
  pacingCeilingMs: 2000,
  resumeWindowMs: 1200,
};

/**
 * How much a reply to our own question shortens the window and its floor.
 * 0.7 was too eager: it took a 540 ms floor to 378 ms.
 */
export const EAGER_FACTOR = 0.8;

/**
 * A pause the speaker takes and then talks through is evidence of how long
 * they pause. The floor learned from it sits this far above the pause, so the
 * same pause a little longer next time still holds.
 */
export const PACING_MARGIN = 1.25;

/** Pauses shorter than this are the gaps between words, not between phrases. */
const PAUSE_NOTICE_MS = 120;

/**
 * Each turn that ends without the speaker resuming lets the learned floor
 * relax this fraction of the way back to the configured one, so a fast talker
 * who once thought for a while is not waited on forever.
 */
const PACING_RELAX = 0.95;

export type TurnEvent =
  /**
   * `resumedAfterEndpoint` is set when this speech began within
   * `resumeWindowMs` of a `speech-end` we fired: the operator was not finished,
   * and `gapMs` is the whole silence the turn was ended in the middle of.
   */
  | { type: "speech-start"; resumedAfterEndpoint?: boolean; gapMs?: number }
  /** The speaker paused but we are still holding the turn open. */
  | { type: "holding"; remainingMs: number; windowMs: number }
  | { type: "speech-end"; durationMs: number; reason: "endpoint" | "max-length"; windowMs: number }
  /** Speech too short to be a turn — discarded without disturbing the state. */
  | { type: "discarded"; durationMs: number };

/** Per-frame evidence beyond the VAD bit and the transcript. */
export interface PushExtras {
  /** End-of-turn likelihood from the audio, 0–1, or null when there is not enough of it yet. */
  prosody?: number | null;
  /** Frame time in ms; defaults to `Date.now()`. Tests pass it to drive the clock. */
  at?: number;
}

/**
 * Scores how finished a transcript sounds, 0 (clearly mid-thought) to 1
 * (clearly complete). Purely lexical — no model call, so it costs nothing and
 * runs every frame. An empty transcript scores 0 here; `syntaxFinality` is
 * the caller that knows empty means "unknown" rather than "unfinished".
 */
export function completenessScore(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const words = trimmed.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  const last = words[words.length - 1];
  let score = 0.5;

  // Terminal punctuation is the strongest signal the recogniser gives us.
  if (/[.!?]$/.test(trimmed)) score += 0.35;
  if (/[,;:]$/.test(trimmed)) score -= 0.3;

  // A dangling connector means another clause is coming.
  if (CONTINUATION_WORDS.has(last)) score -= 0.4;
  if (HESITATIONS.has(last)) score -= 0.45;

  // Length: one word is usually a fragment, a full clause usually is not.
  if (words.length <= 2) score -= 0.2;
  else if (words.length >= 6) score += 0.15;

  // A trailing number or a bare identifier often has more coming after it
  // ("port five one seven…").
  if (/\d$/.test(last)) score -= 0.15;

  // Questions are complete by construction.
  if (/^(what|why|how|when|where|who|which|can|could|should|would|is|are|do|does|did|nini|kwa ?nini|vipi|lini|wapi|nani)\b/.test(words[0])) {
    score += 0.15;
  }

  return Math.max(0, Math.min(1, score));
}

/** The syntactic finality, or null when there is no transcript to read. */
export function syntaxFinality(text: string): number | null {
  return text.trim() ? completenessScore(text) : null;
}

/**
 * Blend the two finality estimates. Either may be unknown: a one-shot
 * recogniser has no transcript mid-utterance, and a turn shorter than the
 * prosody window has no tail to read. Both unknown is neutral — the midpoint
 * of the window — not the ceiling.
 */
export function combineFinality(syntax: number | null, prosody: number | null): number {
  if (syntax === null && prosody === null) return 0.5;
  if (syntax === null) return prosody as number;
  if (prosody === null) return syntax;
  return 0.5 * syntax + 0.5 * prosody;
}

/**
 * Interpolate between the min and max windows by how finished it sounds:
 * finality 1 → `minSilenceMs`, 0 → `maxSilenceMs`. Right after we asked
 * something the operator's reply is expected, so `eager` shortens the window
 * — and its floor — by `EAGER_FACTOR`. Neither may undercut `pacingFloorMs`,
 * the floor learned from this speaker's own pauses: a person who pauses
 * 800 ms between phrases is cut off by any window shorter than that, however
 * finished the last phrase sounded.
 */
export function silenceWindowMs(config: EndpointerConfig, finality: number, eager = false, pacingFloorMs = 0): number {
  const { minSilenceMs, maxSilenceMs } = config;
  const clamped = Math.max(0, Math.min(1, finality));
  let window = maxSilenceMs - (maxSilenceMs - minSilenceMs) * clamped;
  if (eager) window *= EAGER_FACTOR;
  const floor = Math.max(minSilenceMs * (eager ? EAGER_FACTOR : 1), pacingFloorMs);
  return Math.round(Math.max(floor, window));
}

/**
 * Frame-driven turn detector. Feed it every VAD frame; it emits at most one
 * event per frame.
 *
 * It also learns. Two things tell it how long this speaker pauses: a silence
 * that ends with more speech before the window ran out (a pause we rode out),
 * and speech that starts right after an endpoint we fired (a pause we did not
 * — a cut-off). Both raise `pacingFloorMs`, the shortest window it will use
 * for this speaker from then on. `reset()` clears the turn, not the pacing;
 * `forgetPacing()` clears the pacing.
 */
export class Endpointer {
  private speaking = false;
  private onsetRun = 0;
  private silenceRun = 0;
  private speechStartedAt = 0;
  private lastFrameAt = 0;
  private frameMs = 20;

  /** When the last `speech-end` fired, and how long a silence fired it. Survive `reset()`. */
  private lastEndAt = 0;
  private lastWindowMs = 0;
  private pacing = 0;

  private config: EndpointerConfig;

  constructor(config: EndpointerConfig = DEFAULT_ENDPOINTER) {
    this.config = config;
  }

  configure(patch: Partial<EndpointerConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  reset(): void {
    this.speaking = false;
    this.onsetRun = 0;
    this.silenceRun = 0;
    this.speechStartedAt = 0;
  }

  /** Forget what was learned about this speaker's pauses. */
  forgetPacing(): void {
    this.pacing = 0;
    this.lastEndAt = 0;
    this.lastWindowMs = 0;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** The floor learned from this speaker's pauses, ms; 0 until a pause has taught it something. */
  get pacingFloorMs(): number {
    return this.pacing;
  }

  /**
   * @param voiced      whether this frame carried speech
   * @param transcript  best transcript so far, used to size the silence window
   * @param eager       shorten the window — set when we just asked a question
   * @param extras      prosodic finality for this frame, and the frame clock
   */
  push(voiced: boolean, transcript: string, eager = false, extras: PushExtras = {}): TurnEvent | null {
    const now = extras.at ?? Date.now();
    if (this.lastFrameAt) this.frameMs = Math.min(120, Math.max(8, now - this.lastFrameAt));
    this.lastFrameAt = now;

    if (voiced) {
      if (this.speaking && this.silenceRun >= PAUSE_NOTICE_MS) {
        // A pause we held through: the speaker was not finished, and this is
        // how long they were quiet for.
        this.learnPause(this.silenceRun);
      }
      this.silenceRun = 0;
      if (!this.speaking) {
        this.onsetRun += 1;
        if (this.onsetRun >= this.config.onsetFrames) {
          this.speaking = true;
          this.speechStartedAt = now - this.onsetRun * this.frameMs;
          this.onsetRun = 0;
          const sinceEnd = this.lastEndAt ? this.speechStartedAt - this.lastEndAt : Infinity;
          if (sinceEnd <= this.config.resumeWindowMs) {
            // We called the turn over and the speaker carried on. The silence
            // we cut into was the window that fired plus the gap since.
            const gapMs = Math.round(this.lastWindowMs + Math.max(0, sinceEnd));
            this.learnPause(gapMs);
            this.lastEndAt = 0;
            return { type: "speech-start", resumedAfterEndpoint: true, gapMs };
          }
          return { type: "speech-start" };
        }
      }
      return null;
    }

    this.onsetRun = 0;
    if (!this.speaking) return null;

    this.silenceRun += this.frameMs;
    const window = this.silenceWindow(transcript, eager, extras.prosody ?? null);

    if (this.silenceRun >= window) {
      const durationMs = now - this.speechStartedAt - this.silenceRun;
      this.speaking = false;
      this.silenceRun = 0;
      if (durationMs < this.config.minUtteranceMs) return { type: "discarded", durationMs };
      this.lastEndAt = now;
      this.lastWindowMs = window;
      this.relaxPacing();
      return { type: "speech-end", durationMs, reason: "endpoint", windowMs: window };
    }

    return { type: "holding", remainingMs: window - this.silenceRun, windowMs: window };
  }

  private silenceWindow(transcript: string, eager: boolean, prosody: number | null): number {
    return silenceWindowMs(this.config, combineFinality(syntaxFinality(transcript), prosody), eager, this.pacing);
  }

  /** A pause of `ms` was this speaker's, not the end of their turn. */
  private learnPause(ms: number): void {
    const target = Math.min(this.config.pacingCeilingMs, Math.round(ms * PACING_MARGIN));
    if (target > this.config.minSilenceMs && target > this.pacing) this.pacing = target;
  }

  /** A turn ended cleanly; the learned floor eases back toward the configured one. */
  private relaxPacing(): void {
    if (this.pacing <= 0) return;
    const relaxed = Math.round(this.config.minSilenceMs + (this.pacing - this.config.minSilenceMs) * PACING_RELAX);
    this.pacing = relaxed > this.config.minSilenceMs ? relaxed : 0;
  }
}

/* ── The endpointer's own way out ──────────────────────────────────────── */

/** Why a turn had to be ended without a `speech-end`. */
export type StallCause = "frame-pump" | "endpointer";

export interface StallCheck {
  /** How long the turn has been open, ms. */
  overranMs: number;
  cause: StallCause;
}

/**
 * Has an open utterance outlived every reason to still be open?
 *
 * `speech-end` is the only event that commits a turn, and everything that
 * produces one — the frame pump, the VAD, the silence window — sits upstream
 * of the `Endpointer`. When any of them stalls there is no event at all, so
 * "hearing" becomes a latch with no exit: the recogniser keeps appending and
 * several separate attempts pile into one caption that is never sent.
 *
 * The cause is worth naming because the two failures are not the same repair.
 * No frame for `frameStallMs` means the audio graph stopped delivering and the
 * turn detector was never asked anything; frames still arriving means it was
 * asked and kept saying "holding".
 *
 * Returns null while the turn is within its bound, or was never open.
 */
export function endpointStall(opts: {
  turnStartedAt: number;
  lastFrameAt: number;
  now: number;
  maxUtteranceMs: number;
  frameStallMs: number;
}): StallCheck | null {
  const { turnStartedAt, lastFrameAt, now, maxUtteranceMs, frameStallMs } = opts;
  if (turnStartedAt <= 0) return null;
  const overranMs = now - turnStartedAt;
  if (overranMs < maxUtteranceMs) return null;
  const sinceFrame = lastFrameAt > 0 ? now - lastFrameAt : Infinity;
  return { overranMs, cause: sinceFrame >= frameStallMs ? "frame-pump" : "endpointer" };
}
