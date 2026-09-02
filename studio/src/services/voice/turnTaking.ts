/**
 * Turn-taking — deciding when the operator has finished speaking.
 *
 * A fixed silence timer is what makes most voice assistants feel robotic: too
 * short and it cuts you off mid-thought, too long and every exchange drags. We
 * use an adaptive endpointer instead. Silence starts the clock, but how long
 * that clock runs depends on whether the sentence sounds finished:
 *
 *   - trailing "and", "but", "so", a preposition, a comma  → wait longer
 *   - a complete clause with a verb and an object          → fire sooner
 *   - a question that we just asked                        → fire sooner
 *   - mid-word or mid-number                               → wait longer
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
}

export const DEFAULT_ENDPOINTER: EndpointerConfig = {
  minSilenceMs: 520,
  maxSilenceMs: 1900,
  minUtteranceMs: 260,
  onsetFrames: 3,
};

export type TurnEvent =
  | { type: "speech-start" }
  /** The speaker paused but we are still holding the turn open. */
  | { type: "holding"; remainingMs: number }
  | { type: "speech-end"; durationMs: number; reason: "endpoint" | "max-length" }
  /** Speech too short to be a turn — discarded without disturbing the state. */
  | { type: "discarded"; durationMs: number };

/**
 * Scores how finished a transcript sounds, 0 (clearly mid-thought) to 1
 * (clearly complete). Purely lexical — no model call, so it costs nothing and
 * runs every frame.
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

/**
 * Frame-driven turn detector. Feed it every VAD frame; it emits at most one
 * event per frame.
 */
export class Endpointer {
  private speaking = false;
  private onsetRun = 0;
  private silenceRun = 0;
  private speechStartedAt = 0;
  private lastFrameAt = 0;
  private frameMs = 20;

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

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * @param voiced      whether this frame carried speech
   * @param transcript  best transcript so far, used to size the silence window
   * @param eager       shorten the window — set when we just asked a question
   */
  push(voiced: boolean, transcript: string, eager = false): TurnEvent | null {
    const now = Date.now();
    if (this.lastFrameAt) this.frameMs = Math.min(120, Math.max(8, now - this.lastFrameAt));
    this.lastFrameAt = now;

    if (voiced) {
      this.silenceRun = 0;
      if (!this.speaking) {
        this.onsetRun += 1;
        if (this.onsetRun >= this.config.onsetFrames) {
          this.speaking = true;
          this.speechStartedAt = now - this.onsetRun * this.frameMs;
          this.onsetRun = 0;
          return { type: "speech-start" };
        }
      }
      return null;
    }

    this.onsetRun = 0;
    if (!this.speaking) return null;

    this.silenceRun += this.frameMs;
    const window = this.silenceWindow(transcript, eager);

    if (this.silenceRun >= window) {
      const durationMs = now - this.speechStartedAt - this.silenceRun;
      this.speaking = false;
      this.silenceRun = 0;
      if (durationMs < this.config.minUtteranceMs) return { type: "discarded", durationMs };
      return { type: "speech-end", durationMs, reason: "endpoint" };
    }

    return { type: "holding", remainingMs: window - this.silenceRun };
  }

  /** Interpolate between the min and max windows by how finished it sounds. */
  private silenceWindow(transcript: string, eager: boolean): number {
    const { minSilenceMs, maxSilenceMs } = this.config;
    const complete = completenessScore(transcript);
    const span = maxSilenceMs - minSilenceMs;
    // complete === 1 -> minSilenceMs; complete === 0 -> maxSilenceMs
    let window = maxSilenceMs - span * complete;
    // Right after we asked something, the operator's reply is expected, so we
    // can commit faster without risking a cut-off.
    if (eager) window *= 0.7;
    return Math.round(Math.max(minSilenceMs * (eager ? 0.7 : 1), window));
  }
}
