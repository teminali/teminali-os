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
