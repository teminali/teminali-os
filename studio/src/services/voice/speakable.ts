/**
 * Turning a written reply into something worth hearing.
 *
 * Reading markdown aloud verbatim is unbearable — a fenced code block becomes a
 * minute of punctuation names. So code is announced rather than recited, and
 * the decoration that only exists for the eye is dropped.
 *
 * Deliberately dependency-free: it is pure text in, pure text out.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```(\w+)?\n[\s\S]*?```/g, (_match, lang: string | undefined) =>
      lang ? ` — ${lang} code block — ` : " — code block — ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Chunks at or below this many words are read at the base rate. */
export const PACE_SHORT_WORDS = 12;
/** Chunks at or above this many words are read at the full long-form boost. */
export const PACE_LONG_WORDS = 40;
/** How much faster a long chunk is read than a short one, as a multiplier. */
export const PACE_LONG_BOOST = 1.15;

/**
 * The rate to read one chunk at. A short line — an acknowledgement, a status
 * answer — keeps the operator's chosen pace. A long stretch of prose is read
 * faster, ramping to `PACE_LONG_BOOST` times the base by `PACE_LONG_WORDS`
 * words: a listener who already has the gist wants the rest sooner, and a
 * long passage at a slow pace is where a spoken reply starts to drag.
 */
export function paceFor(base: number, text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const span = PACE_LONG_WORDS - PACE_SHORT_WORDS;
  const t = Math.min(1, Math.max(0, (words - PACE_SHORT_WORDS) / span));
  const boosted = base * (1 + (PACE_LONG_BOOST - 1) * t);
  return Math.round(Math.min(2, Math.max(0.5, boosted)) * 100) / 100;
}
