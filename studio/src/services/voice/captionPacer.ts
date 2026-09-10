/**
 * Paces the assistant's caption to the voice that is speaking it.
 *
 * The model generates several seconds ahead of the speaker. Rendering
 * `partial_assistant_answer` straight to the screen therefore shows a whole
 * sentence before Temi has said its first word, and the reader — who is also
 * listening — sees the end of a thought while hearing the start of it. It reads
 * like a transcript of a conversation that has not happened yet.
 *
 * So the caption is driven by playback, not by generation. The playback worklet
 * is the only thing that knows how much audio has actually left the buffer, and
 * it reports that; this maps those seconds onto a prefix of the text.
 *
 * The mapping is a speaking rate in characters per second, which is measured
 * rather than assumed: every completed turn tells us exactly how many characters
 * took how many seconds, and the estimate follows. That is what keeps the
 * caption honest when the voice or the speed setting changes — nobody has to
 * remember to retune a constant.
 */

/** English TTS at speed 1.0, before the first turn has been measured. */
export const DEFAULT_CHARS_PER_SECOND = 14.5;

/** A rate outside this band is a measurement artefact — a clipped turn, a
    barge-in — not a voice, and must not be allowed to poison the estimate. */
export const MIN_CHARS_PER_SECOND = 8;
export const MAX_CHARS_PER_SECOND = 30;

/** How much of the estimate a single turn is allowed to move. */
const CALIBRATION_WEIGHT = 0.3;

export class CaptionPacer {
  private rate = DEFAULT_CHARS_PER_SECOND;
  private target = "";
  private revealedChars = 0;

  /** The current measured speaking rate, in characters per second. */
  get charsPerSecond(): number {
    return this.rate;
  }

  /** A new spoken turn. The clock and the revealed prefix start over; the
      measured rate deliberately survives, because it describes the voice and
      not the sentence. */
  beginTurn(): void {
    this.target = "";
    this.revealedChars = 0;
  }

  /** The text generated so far. Safe to call on every token. */
  setText(text: string): void {
    this.target = text ?? "";
  }

  /**
   * The prefix that should be on screen after `secondsPlayed` of audio.
   *
   * Never goes backwards: a caption that un-reveals a word it has already shown
   * reads as a glitch, and playback progress can legitimately restate a lower
   * figure across a barge-in.
   */
  advanceTo(secondsPlayed: number): string {
    /* No lead is added. A caption that runs even slightly ahead of the voice is
       the same defect as one that runs seconds ahead, only quieter: the eye
       still arrives first and the listener stops listening. Progress is
       reported every 50ms, which is finer than a syllable, so tracking playback
       honestly is already smooth. */
    const budget = Math.max(0, secondsPlayed) * this.rate;
    const wanted = Math.min(this.target.length, Math.floor(budget));
    if (wanted > this.revealedChars) {
      this.revealedChars = wanted;
    }
    return this.visible();
  }

  /** Everything generated so far, regardless of playback. Used when a turn ends
      and when audio never arrives at all, so a caption is never left truncated
      by a speaker that failed. */
  revealAll(): string {
    this.revealedChars = this.target.length;
    return this.target;
  }

  /**
   * Close the turn and learn from it.
   *
   * `spokenText` is what was actually said and `secondsPlayed` how long the
   * speaker took to say it, so their ratio is a direct observation of the
   * speaking rate. Short or clipped turns are ignored: a two-word answer, or a
   * turn cut off by a barge-in, measures the interruption rather than the voice.
   */
  completeTurn(spokenText: string, secondsPlayed: number): void {
    const chars = (spokenText ?? "").length;
    if (secondsPlayed >= 1.5 && chars >= 20) {
      const observed = chars / secondsPlayed;
      if (observed >= MIN_CHARS_PER_SECOND && observed <= MAX_CHARS_PER_SECOND) {
        this.rate = this.rate * (1 - CALIBRATION_WEIGHT) + observed * CALIBRATION_WEIGHT;
      }
    }
    this.target = spokenText ?? this.target;
    this.revealedChars = this.target.length;
  }

  /** The revealed prefix, ending on a word boundary so a word never appears
      half-written — except at the very end of what we have, where the boundary
      would hold back the final word for no reason. */
  private visible(): string {
    if (this.revealedChars >= this.target.length) return this.target;
    const slice = this.target.slice(0, this.revealedChars);
    const lastSpace = slice.lastIndexOf(" ");
    return lastSpace <= 0 ? "" : slice.slice(0, lastSpace);
  }
}
