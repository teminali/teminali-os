/**
 * Self-echo guard — the assistant must not hear itself.
 *
 * The built-in recogniser listens to the raw microphone, and the laptop's
 * speakers are a few centimetres from it. Whatever the assistant says comes
 * straight back as a "user" transcript. Left alone that did three bad things:
 * the transcript of the next real turn arrived prefixed with the assistant's
 * own words, the barge-in detector fired on the assistant's own voice, and a
 * reply that sounded like an instruction ("run the tests now?") was committed
 * as one — so the assistant interrupted its own run to obey itself.
 *
 * The fix is textual, not acoustic: remember what was just spoken, and treat
 * a transcript that is mostly those words as echo. Content words only —
 * "the", "to" and "is" match everything — and the bar rises the longer it has
 * been since the assistant stopped talking, because a person repeating the
 * assistant's question back as an answer ("run the tests" after "should I run
 * the tests?") is a real turn and must get through.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "at", "for", "and", "or", "but", "is", "are", "was",
  "were", "be", "been", "it", "its", "it's", "this", "that", "these", "those", "i", "you", "we",
  "they", "he", "she", "me", "my", "your", "our", "so", "do", "does", "did", "have", "has", "had",
  "with", "as", "by", "from", "not", "no", "yes", "ok", "okay", "just", "now", "then", "there",
  "here", "will", "would", "can", "could", "should", "what", "which", "who", "how", "when", "up",
  "if", "into", "about", "let", "let's", "am", "im", "i'm", "um", "uh",
  "na", "ni", "ya", "wa", "kwa", "za", "la", "hii", "hiyo", "ile",
]);

/** How long after speech ends a transcript is still treated as probable echo. */
export const ECHO_TAIL_MS = 1600;
/** How long a spoken line stays in the comparison window. */
export const ECHO_WINDOW_MS = 25_000;

export interface EchoVerdict {
  /** What is left after the echoed part is removed; empty when it was all echo. */
  text: string;
  /** True when any part of the transcript was recognised as the assistant's own words. */
  echoed: boolean;
  /** Share of content words that matched, 0–1. */
  overlap: number;
}

export type EchoPhase = "speaking" | "tail" | "quiet";

function normaliseWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

function contentTokens(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normaliseWord)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/**
 * Compare a transcript against recently spoken lines.
 *
 * - While the assistant is speaking, 60% content-word overlap is echo.
 * - In the tail after it stops, 75%.
 * - Once quiet, only a verbatim run of six content words counts, which a
 *   person answering a question almost never produces.
 *
 * A leading run of at least three matching content words is stripped as a
 * prefix even when the rest is new speech — the common case where the
 * operator starts talking as the assistant's last sentence is still in the air.
 */
export function stripSelfEcho(heard: string, spoken: readonly string[], phase: EchoPhase = "speaking"): EchoVerdict {
  const original = heard.trim();
  if (!original) return { text: "", echoed: false, overlap: 0 };
  if (spoken.length === 0) return { text: original, echoed: false, overlap: 0 };

  const bag = new Set<string>();
  const sequences: string[][] = [];
  for (const line of spoken) {
    const tokens = contentTokens(line);
    sequences.push(tokens);
    for (const token of tokens) bag.add(token);
  }
  if (bag.size === 0) return { text: original, echoed: false, overlap: 0 };

  const words = original.split(/\s+/);
  const content: Array<{ index: number; token: string; hit: boolean }> = [];
  for (let index = 0; index < words.length; index += 1) {
    const token = normaliseWord(words[index]);
    if (token.length <= 1 || STOPWORDS.has(token)) continue;
    content.push({ index, token, hit: bag.has(token) });
  }
  if (content.length === 0) return { text: original, echoed: false, overlap: 0 };

  const hits = content.filter((entry) => entry.hit).length;
  const overlap = hits / content.length;

  // Longest verbatim run of content words that also appears, in order, in any spoken line.
  const heardTokens = content.map((entry) => entry.token);
  let longestRun = 0;
  for (const sequence of sequences) {
    for (let start = 0; start < heardTokens.length; start += 1) {
      for (let offset = 0; offset < sequence.length; offset += 1) {
        let length = 0;
        while (
          start + length < heardTokens.length &&
          offset + length < sequence.length &&
          heardTokens[start + length] === sequence[offset + length]
        ) {
          length += 1;
        }
        if (length > longestRun) longestRun = length;
      }
    }
  }

  const threshold = phase === "speaking" ? 0.6 : phase === "tail" ? 0.75 : 2;

  // A leading run of echoed words followed by genuinely new ones: the operator
  // started talking while the last sentence was still in the air. Keep the
  // new part. This is checked first because the echoed prefix alone can push
  // the overall overlap past the whole-echo bar.
  if (phase !== "quiet") {
    let prefix = 0;
    while (prefix < content.length && content[prefix].hit) prefix += 1;
    const rest = content.slice(prefix);
    const restOverlap = rest.length === 0 ? 1 : rest.filter((entry) => entry.hit).length / rest.length;
    if (prefix >= 3 && rest.length >= 2 && restOverlap < threshold) {
      const cutAt = rest[0].index;
      return { text: words.slice(cutAt).join(" "), echoed: true, overlap };
    }
  }

  const wholeEcho =
    (content.length >= 2 && overlap >= threshold) ||
    (phase !== "quiet" && content.length === 1 && overlap === 1 && words.length <= 3) ||
    longestRun >= 6;
  if (wholeEcho) return { text: "", echoed: true, overlap };

  return { text: original, echoed: false, overlap };
}

/** Rolling memory of what the assistant said, with when it stopped saying it. */
export class EchoGuard {
  private lines: Array<{ text: string; at: number }> = [];
  private speakingSince: number | null = null;
  private endedAt = 0;

  /** Call as a line starts playing. */
  remember(text: string, now = Date.now()): void {
    const clean = text.trim();
    if (!clean) return;
    this.lines.push({ text: clean, at: now });
    this.speakingSince = now;
    this.prune(now);
  }

  /** Call when playback stops, for any reason. */
  markEnded(now = Date.now()): void {
    if (this.speakingSince !== null) this.endedAt = now;
    this.speakingSince = null;
  }

  phase(now = Date.now()): EchoPhase {
    if (this.speakingSince !== null) return "speaking";
    if (now - this.endedAt < ECHO_TAIL_MS) return "tail";
    return "quiet";
  }

  recent(now = Date.now()): string[] {
    this.prune(now);
    return this.lines.map((line) => line.text);
  }

  /** Convenience: strip against the current window at the current phase. */
  filter(heard: string, now = Date.now()): EchoVerdict {
    return stripSelfEcho(heard, this.recent(now), this.phase(now));
  }

  clear(): void {
    this.lines = [];
    this.speakingSince = null;
    this.endedAt = 0;
  }

  private prune(now: number): void {
    this.lines = this.lines.filter((line) => now - line.at < ECHO_WINDOW_MS);
  }
}
