/**
 * Spoken digest — how much of a reply gets read aloud.
 *
 * Reading a long, code-heavy answer sentence by sentence is the fastest way to
 * make a voice assistant unbearable. What a person does is say the first
 * couple of things as they come, then sum up the rest. So the streaming
 * reader speaks the opening sentences as they arrive, holds everything after
 * that, and at the end either reads the remainder verbatim (if it is short) or
 * asks the local model for a two-sentence spoken summary and reads that, with
 * a rule-based fallback if the model is slow.
 */

/** Opening sentences read aloud as they stream, before holding the rest. */
export const STREAMED_SENTENCE_LIMIT = 3;
/** A held remainder up to this long is just read out; longer is summarised. */
export const VERBATIM_LIMIT_CHARS = 320;
/** The model gets this long to summarise before the fallback speaks instead. */
export const DIGEST_TIMEOUT_MS = 7000;

export interface DigestPlan {
  mode: "silent" | "verbatim" | "summarise";
  /** Text to speak for `verbatim`, or the fallback line for `summarise`. */
  fallback: string;
}

/** Decide what to do with the text that was held back during streaming. */
export function planSpokenDigest(held: string, summarise = true): DigestPlan {
  const text = held.replace(/\s+/g, " ").trim();
  if (!text) return { mode: "silent", fallback: "" };
  if (!summarise || text.length <= VERBATIM_LIMIT_CHARS) return { mode: "verbatim", fallback: text };
  return { mode: "summarise", fallback: fallbackDigest(text) };
}

/** The first sentence plus a pointer to the chat — spoken if the model is late. */
export function fallbackDigest(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const match = clean.match(/^[^.!?]{8,}?[.!?](?=\s|$)/);
  const first = (match ? match[0] : clean.slice(0, 140)).trim();
  return `${first} The rest is in the chat.`;
}

/** Prompt for the local model. One job, tight shape, no room for slop. */
export function digestPrompt(text: string): string {
  const trimmed = text.length > 3200 ? `${text.slice(0, 3200)}…` : text;
  return [
    "You are the spoken voice of a coding assistant. Summarise the assistant's written reply below for speech.",
    "Rules: at most two short sentences. Plain words. Say what was done or found and what happens next.",
    "No code, no file paths longer than a name, no markdown, no lists, no preamble. Speak as the assistant, first person.",
    "",
    "Reply:",
    trimmed,
  ].join("\n");
}

/** Clean a model summary for the synthesiser; empty when it is unusable. */
export function tidyDigest(reply: string): string {
  const clean = reply
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*(summary|spoken summary|here('s| is) (a|the) summary)\s*:\s*/i, "")
    .replace(/[*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length < 8 || clean.length > 400) return "";
  return clean;
}
