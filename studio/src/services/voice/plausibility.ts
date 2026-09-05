/**
 * Is this transcript speech the operator actually said?
 *
 * The layer this file adds sits between recognition and addressing, and it
 * exists because of a reported failure: the transcript
 * `"Olof, siri e prole, olof, olof, olof, olof."` was committed as a genuine
 * turn, aborted a running command, and left the model apologising for not
 * catching it. Nothing in the pipeline was wrong. `cleanTranscript` found no
 * bracketed artefact to strip, `isNonSpeechOrBlank` found words, and
 * `scoreAddressing` was handed a plausible-looking sentence and scored it.
 * The text was never speech at all — it was Whisper's repetition loop on
 * non-speech audio, which is a failure mode with a shape of its own.
 *
 * Why this cannot be folded into the confidence score: it was measured, and
 * loops score *high*. On ggml-large-v3-turbo-q8_0, a clip of "tk tk tk"
 * decoded to ten "TK"s at a language probability of 0.813 and a mean token
 * probability of 0.893 — better than the correctly transcribed sentence
 * beside it. The recogniser is not unsure when it loops; it is confidently
 * repeating. Confidence and plausibility catch different things, and both are
 * needed. (`server/speech-local.js` carries the full measurement table.)
 *
 * Why not a model: the operator asked for the rejection to happen *before the
 * text becomes a prompt*. Everything here is synchronous, offline, and costs
 * nothing, so it can run on every utterance without adding latency to the one
 * turn in a hundred it rejects.
 *
 * The bias throughout is against false rejection. Refusing to hear the
 * operator is a worse failure than occasionally passing noise on to the
 * addressing gate, which is itself a filter. Every threshold below is set so
 * that ordinary speech — including terse, repetitive and urgent speech —
 * passes untouched.
 */

/**
 * Phrases Whisper emits when it has nothing to transcribe. These come from
 * subtitle files in its training data, which is why a silent room produces
 * the credits at the end of a video.
 *
 * They are *suspect*, never rejected on sight: "thank you" and "bye" are
 * things an operator genuinely says to an assistant. The rule is that a
 * suspect phrase must also be the whole utterance and arrive with weak
 * recognition confidence before it is dropped.
 */
const HALLUCINATION_PHRASES = [
  "thank you", "thanks for watching", "thank you for watching",
  "thanks for watching!", "please subscribe", "like and subscribe",
  "subscribe to my channel", "see you next time", "see you in the next video",
  "bye", "bye bye", "goodbye", "you", "the end", "amen",
  "subtitles by the amara.org community", "subtitles by",
  "transcription by", "translated by", "captions by",
  "www.mooji.org", "amara.org", "beadaptive.net",
];

/**
 * Words whose repetition is meaningful rather than degenerate. An operator
 * hammering "stop stop stop stop" at a runaway command is the single most
 * important utterance the system can hear, and it is also, structurally, a
 * perfect repetition loop. It must never be mistaken for one.
 */
const MEANINGFUL_REPEATS = new Set([
  "stop", "no", "nope", "yes", "yeah", "yep", "wait", "cancel", "abort",
  "quit", "halt", "enough", "hello", "hi", "hey", "please", "go", "ok", "okay",
  "hapana", "ndiyo", "subiri", "acha", "sawa", "haraka",
]);

export interface PlausibilitySignals {
  /** 0-1 share of the utterance covered by repeats of one n-gram. */
  repetition: number;
  /** 0-1 share of the utterance taken by its single most common word. */
  dominance: number;
  /** The whole utterance is a known ASR artefact phrase. */
  hallucination: boolean;
  /** 0-1 share of words that look like words. */
  coherence: number;
  /** What the recogniser reported, passed through for the log. -1 if unknown. */
  confidence: number;
}

export interface PlausibilityVerdict {
  /** False when this should not become a prompt. */
  plausible: boolean;
  /** Why, in words an operator reading a log can act on. */
  reason: string;
  signals: PlausibilitySignals;
}

export interface PlausibilityContext {
  /**
   * 0-1 from the recogniser, or -1 when it does not report one. The local
   * whisper.cpp server reports it; the CLI fallback reports only a word score
   * and the sidecar may report nothing, so every rule here degrades to
   * text-only evidence when it is absent rather than assuming the worst.
   */
  confidence?: number;
}

/** Words, lowercased, punctuation dropped. Numbers count; bare symbols do not. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The largest share of the utterance that repeats of a single n-gram account
 * for, across n = 1..4.
 *
 * A loop is not always a single word: "thanks for watching, thanks for
 * watching, thanks for watching" is a 3-gram repeated three times and covers
 * the whole line, while no single word in it exceeds a third. Scanning the
 * short n-grams catches both without needing to know which shape arrived.
 */
export function repetitionShare(words: string[]): { share: number; unit: string; count: number } {
  let best = { share: 0, unit: "", count: 0 };
  if (words.length < 2) return best;

  for (let n = 1; n <= Math.min(4, Math.floor(words.length / 2)); n += 1) {
    const counts = new Map<string, number>();
    for (let i = 0; i + n <= words.length; i += 1) {
      const gram = words.slice(i, i + n).join(" ");
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    for (const [gram, count] of counts) {
      if (count < 2) continue;
      // Overlapping matches cannot cover more of the line than it has words.
      const share = Math.min(1, (count * n) / words.length);
      if (share > best.share) best = { share, unit: gram, count };
    }
  }
  return best;
}

/**
 * How many of these look like words at all.
 *
 * Deliberately crude, and deliberately generous. There is no dictionary here —
 * shipping one would not survive Kiswahili, code identifiers or the operator's
 * own filenames, all of which are ordinary input. It only counts the things
 * that no language produces: a run of letters with no vowel in it, a letter
 * repeated four times, a token longer than any real word. "prole" passes this
 * and should; the gate does not rest on coherence alone.
 */
export function coherenceShare(words: string[]): number {
  if (words.length === 0) return 0;
  let plausible = 0;
  for (const word of words) {
    const letters = word.replace(/[^\p{L}]/gu, "");
    if (letters.length === 0) {
      plausible += 1;             // a bare number is a fine thing to say
      continue;
    }
    const hasVowel = /[aeiouyàâäéèêëîïôöùûüαεηιουаеиоуыэюя]/iu.test(letters);
    const runOn = /(.)\1{3,}/u.test(letters);
    const tooLong = letters.length > 24;
    if ((hasVowel || letters.length <= 2) && !runOn && !tooLong) plausible += 1;
  }
  return plausible / words.length;
}

/**
 * The gate. Returns a verdict rather than a boolean so the caller can log
 * *why* an utterance was dropped — an operator who was ignored is owed a
 * reason, and a silent filter is impossible to tune.
 */
export function scorePlausibility(text: string, context: PlausibilityContext = {}): PlausibilityVerdict {
  const confidence = typeof context.confidence === "number" ? context.confidence : -1;
  const words = tokenise(text);
  const repetition = repetitionShare(words);
  const coherence = coherenceShare(words);

  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const topCount = Math.max(0, ...counts.values());
  const dominance = words.length > 0 ? topCount / words.length : 0;
  const topWord = [...counts.entries()].find(([, count]) => count === topCount)?.[0] ?? "";

  const stripped = text.toLowerCase().replace(/[^\p{L}\p{N}\s.']/gu, "").replace(/[.\s]+$/u, "").trim();
  const hallucination = HALLUCINATION_PHRASES.includes(stripped);

  const signals: PlausibilitySignals = { repetition: repetition.share, dominance, hallucination, coherence, confidence };
  const reject = (reason: string): PlausibilityVerdict => ({ plausible: false, reason, signals });

  /*
    A repetition loop. Three conditions together, because each alone has an
    honest counter-example: a short utterance ("no no no") is not long enough
    to be degenerate, a twice-said phrase is emphasis rather than a loop, and
    a repeated command word is the operator insisting. Requiring all three
    leaves "olof, olof, olof, olof" caught and "stop stop stop" untouched.
  */
  const meaningful = MEANINGFUL_REPEATS.has(repetition.unit.trim());
  if (words.length >= 6 && repetition.count >= 3 && repetition.share >= 0.6 && !meaningful) {
    return reject(`Recogniser looped on "${repetition.unit}" (${repetition.count}x).`);
  }

  /*
    One word taking most of a long utterance, without being contiguous enough
    to read as a loop — the shape of the reported failure, where "olof"
    arrived five times in eight words with other fragments between them.
  */
  if (words.length >= 6 && dominance >= 0.5 && !MEANINGFUL_REPEATS.has(topWord)) {
    return reject(`"${topWord}" was ${Math.round(dominance * 100)}% of what was heard.`);
  }

  /*
    A known artefact phrase, and only when the recogniser was also unsure.
    Measured: six seconds of digital silence decodes to "Thank you." at a
    confidence of 0.37, while the operator saying thank you scores above 0.9.
    With no confidence reported there is nothing to separate the two cases, so
    the phrase is allowed through rather than guessed at.
  */
  if (hallucination && confidence >= 0 && confidence < 0.6) {
    return reject(`"${stripped}" at confidence ${confidence.toFixed(2)} is the sound of an empty room.`);
  }

  /*
    Gibberish. The threshold is low on purpose: this fires only when most of
    the utterance is unpronounceable, which real speech never is, and it needs
    enough words to be sure it is not judging a two-word answer.
  */
  if (words.length >= 4 && coherence < 0.5) {
    return reject(`Most of that was not pronounceable (${Math.round(coherence * 100)}% word-like).`);
  }

  /*
    Nothing structural is wrong, but the recogniser itself says it was barely
    speech. On the local server path this number is dominated by the language
    probability, which measured 0.37-0.81 across silence, noise, a hum and
    music, and 0.96-1.00 across real speech.

    A short utterance is not penalised for being short — that was assumed and
    then measured, and the assumption was wrong. Whole-utterance confidence
    for "go ahead" was 0.913, "no" 0.866, "yes" 0.811, and a bare one-word
    "stop" 0.741. Brevity costs nothing, so 0.45 sits far below any real
    answer. The length condition is the other way round: a *long* utterance is
    exempt, because sustained low confidence across many words is more often a
    hard accent or a bad microphone than an empty room.
  */
  if (confidence >= 0 && confidence < 0.45 && words.length < 8) {
    return reject(`The recogniser was ${Math.round(confidence * 100)}% sure that was speech.`);
  }

  return { plausible: true, reason: "", signals };
}
