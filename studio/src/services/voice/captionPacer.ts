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
  /** The last prefix actually handed to the screen. See `visible()`. */
  private shown = "";
  /** Has this turn been closed? See `advanceTo()`. */
  private closed = false;

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
    this.shown = "";
    this.closed = false;
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
   * figure across a barge-in. That promise is kept in `visible()`, over what
   * was last returned — keeping it over `revealedChars` alone, which is what
   * this did until 2026-09-12, is not the same promise and did not hold.
   */
  advanceTo(secondsPlayed: number): string {
    /* A closed turn has no caption left to give.

       `completeTurn()` sets `shown` to the whole reply, and the promise in
       `visible()` is never to hand back less than that again. Both are right
       DURING a turn. After one, they combine into a bug: playback progress
       outlives the reply -- the worklet keeps reporting for audio still in its
       buffer after `turnComplete` committed the text -- so the next tick had
       `TemiVoiceStage`'s `onTTSProgress` paint the finished sentence back into
       the live caption row, underneath the copy just committed to the
       transcript. One reply, on screen twice, the second copy sitting below
       whatever the operator said next. Measured 2026-09-12.

       The hold was always a promise about mid-turn redraws, not a promise to
       keep reciting a turn that is over. */
    if (this.closed) return "";
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
    /* The same guard `advanceTo` carries, and for the same defect. A turn that
       has been committed is over, and revealing it again is how one reply got
       on screen twice: `advanceTo` refused, this did not, so the duplicate
       simply came through the other door. */
    if (this.closed) return "";
    this.revealedChars = this.target.length;
    this.shown = this.target;
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
    this.shown = this.target;
    this.closed = true;
  }

  /**
   * The revealed prefix, ending on a word boundary so a word never appears
   * half-written — except at the very end of what we have, where the boundary
   * would hold back the final word for no reason.
   *
   * The word boundary is why the caption is safe on multi-byte text: the cut
   * always lands on a space, never inside a surrogate pair or a ZWJ emoji
   * sequence, so no prefix can render as a replacement glyph. Swept 2026-09-12
   * over an emoji sentence at 50ms steps — every prefix was well-formed.
   *
   * What the boundary cannot do alone is stay monotonic, and `revealedChars`
   * growing is not the same thing as the caption growing. Measured 2026-09-12
   * against the default 14.5 chars/sec, with the fragment sizes Gemini's
   * `outputTranscription` actually sends:
   *
   *     setText("Sure");                 advanceTo(0.30) -> "Sure"
   *     setText("Sure, I can do that."); advanceTo(0.35) -> ""      ← blank
   *                                      advanceTo(0.45) -> "Sure,"
   *
   * A target the budget has entirely covered returns whole through the early
   * exit above, boundary and all. The next fragment makes the target longer,
   * the early exit no longer applies, and those same four characters are now a
   * slice with no space in it — so the caption blanks until the budget reaches
   * the next space. The trigger is playback catching up with generation, which
   * on this lane is not an edge case: Gemini's audio arrives in chunks with
   * real pauses while it generates, and the speaker plays out its buffer
   * through every one of them. The class already promised this could not
   * happen; it promised it of `revealedChars`, which was the wrong quantity.
   *
   * So what was last put on screen is held until the reveal passes it. The
   * hold is dropped the moment `shown` stops being a prefix of the target,
   * because a revised transcription must win over a stale caption: holding
   * there would leave words on screen that she is no longer going to say.
   */
  private visible(): string {
    const candidate = this.candidate();
    if (candidate.length < this.shown.length && this.target.startsWith(this.shown)) {
      return this.shown;
    }
    this.shown = candidate;
    return candidate;
  }

  /** The prefix the playback budget alone justifies, cut to a word. */
  private candidate(): string {
    if (this.revealedChars >= this.target.length) return this.target;
    const slice = this.target.slice(0, this.revealedChars);
    const lastSpace = slice.lastIndexOf(" ");
    return lastSpace <= 0 ? "" : slice.slice(0, lastSpace);
  }
}
