/**
 * Spoken digest — how much of a reply gets read aloud.
 *
 * Reading a long, code-heavy answer sentence by sentence is the fastest way to
 * make a voice assistant unbearable. What a person does is say the first
 * couple of things as they come, then sum up the rest. So the streaming
 * reader speaks the opening sentences as they arrive, holds everything after
 * that, and at the end either reads the remainder verbatim (if it is short) or
 * asks the Flash lane for a two-sentence spoken summary and reads *that* as it
 * streams — sentence by sentence, the way the reply itself was read — with a
 * rule-based fallback if the first sentence is late.
 *
 * Why the input is bounded and the budget proportional (measured 2026-09-05,
 * Ollama, `frontier-qwen2.5-coder-14b-8k`, model already loaded, prompt not
 * in Ollama's prefix cache): prompt evaluation is the cost, not generation.
 * A 3531-char prompt (~930 tokens) took 6.9–8.7 s to evaluate before the
 * first token — the old flat 7 s cap expired before any output existed — and
 * a 1531-char prompt (~410 tokens) took 2.6 s, with the first sentence
 * complete at 4.0 s. Generation itself ran 24–38 tokens in 1.8–3.2 s. The time
 * is linear in prompt length, so the model is shown the head and the tail of
 * the remainder, code fences dropped, and the only wait the operator hears —
 * the first sentence — is budgeted by how much it was shown.
 */

/** Opening sentences read aloud as they stream, before holding the rest. */
export const STREAMED_SENTENCE_LIMIT = 3;
/** A held remainder up to this long is just read out; longer is summarised. */
export const VERBATIM_LIMIT_CHARS = 320;

/** The model sees this much of the start of the remainder … */
export const DIGEST_HEAD_CHARS = 900;
/** … and this much of its end, where "next I will" usually lives. */
export const DIGEST_TAIL_CHARS = 300;
/** Upper bound on what the model is shown, code fences already dropped. */
export const DIGEST_INPUT_CHARS = DIGEST_HEAD_CHARS + DIGEST_TAIL_CHARS;

/**
 * Wait for the first spoken sentence: a fixed part for model latency and
 * sentence generation (measured 1.3–2.2 s once the first token is out) plus a
 * per-character part for prompt evaluation (measured ≈2.2 ms per prompt
 * character), each with headroom. At `DIGEST_INPUT_CHARS` this is 7.3 s for a
 * first sentence measured at 4.0 s; a cold model load (17 s measured) still
 * misses it, and is meant to: the fallback speaks instead of a long silence.
 */
export const DIGEST_BUDGET_BASE_MS = 2500;
export const DIGEST_BUDGET_PER_CHAR_MS = 4;
/**
 * Once a sentence is being spoken the model has the floor; a gap this long
 * between tokens (they arrive every ~80 ms when it is generating) means it has
 * stalled, and what was said stands.
 */
export const DIGEST_TAIL_IDLE_MS = 4000;
/** The digest is at most this many sentences and characters, whatever the model does. */
export const DIGEST_MAX_SENTENCES = 2;
export const DIGEST_MAX_CHARS = 400;
/** `num_predict` for the digest request: two short sentences measured at 24–38 tokens. */
export const DIGEST_MAX_TOKENS = 80;

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

/**
 * What the model is shown: the remainder with code fences replaced by a
 * marker (a summary never needs the code, and code is where the tokens are),
 * cut to its head and tail when it is longer than `DIGEST_INPUT_CHARS`.
 */
export function digestSource(text: string): string {
  const prose = text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/\s+/g, " ")
    .trim();
  if (prose.length <= DIGEST_INPUT_CHARS) return prose;
  const head = prose.slice(0, DIGEST_HEAD_CHARS).trimEnd();
  const tail = prose.slice(-DIGEST_TAIL_CHARS).trimStart();
  return `${head} […] ${tail}`;
}

/** How long to wait for the first spoken sentence, given what the model was shown. */
export function digestBudgetMs(inputChars: number): number {
  const chars = Math.max(0, Math.min(DIGEST_INPUT_CHARS, Math.floor(inputChars)));
  return DIGEST_BUDGET_BASE_MS + DIGEST_BUDGET_PER_CHAR_MS * chars;
}

/** Prompt for the local model. One job, tight shape, no room for slop. */
export function digestPrompt(text: string): string {
  return [
    "You are the spoken voice of a coding assistant. Summarise the assistant's written reply below for speech.",
    "Rules: at most two short sentences. Plain words. Say what was done or found and what happens next.",
    "No code, no file paths longer than a name, no markdown, no lists, no preamble. Speak as the assistant, first person.",
    "",
    "Reply:",
    digestSource(text),
  ].join("\n");
}

const PREAMBLE = /^\s*(?:spoken summary|summary|here(?:'s| is) (?:a|the|my) (?:spoken )?summary)\s*[:.]\s*/i;
const SENTENCE_END = /^[\s\S]*?[.!?]["')\]]*(?=\s)/;

/** Strip what a synthesiser should not be given: fences, backticks, markdown marks. */
function cleanDigestText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Turns the model's token stream into sentences ready for the speech queue,
 * tidied one at a time so the first can be spoken while the second is still
 * being generated. Enforces the digest's shape as it goes: a leading
 * "Summary:" is dropped, a code fence ends the digest (the model is reciting,
 * not summarising), and after `DIGEST_MAX_SENTENCES` sentences or
 * `DIGEST_MAX_CHARS` characters `done` is set so the caller can stop the
 * request. No constructor parameter properties: node imports this stripped.
 */
export class DigestStream {
  private buffer = "";
  private sentences = 0;
  private chars = 0;
  private atStart = true;
  /** The digest is complete or was cut; further tokens are ignored. */
  done = false;

  /** Sentences spoken so far — zero at the end means the fallback is needed. */
  get spokenSentences(): number {
    return this.sentences;
  }

  /** Feed a token; returns the sentences that are now ready to be spoken. */
  push(token: string): string[] {
    if (this.done) return [];
    this.buffer += token;
    const fence = this.buffer.indexOf("```");
    if (fence >= 0) this.buffer = this.buffer.slice(0, fence);
    const ready = this.drain();
    if (fence >= 0 && !this.done) ready.push(...this.finish());
    return ready;
  }

  /** Lift every complete sentence off the front of the buffer. */
  private drain(): string[] {
    const ready: string[] = [];
    for (;;) {
      const match = this.buffer.match(SENTENCE_END);
      if (!match) break;
      this.buffer = this.buffer.slice(match[0].length);
      const sentence = this.accept(match[0]);
      if (sentence) ready.push(sentence);
      if (this.done) break;
    }
    return ready;
  }

  /**
   * The model has finished on its own: whatever is left is the last sentence.
   * After a cut (`done` already set) there is nothing to say — a half sentence
   * the model was stopped in is worse than silence.
   */
  finish(): string[] {
    if (this.done) {
      this.buffer = "";
      return [];
    }
    this.done = true;
    const rest = this.buffer;
    this.buffer = "";
    const sentence = rest.trim() ? this.accept(rest) : "";
    return sentence ? [sentence] : [];
  }

  private accept(raw: string): string {
    const clean = cleanDigestText(this.atStart ? raw.replace(PREAMBLE, "") : raw);
    if (!clean) return "";
    this.atStart = false;
    if (this.chars + clean.length > DIGEST_MAX_CHARS) {
      this.done = true;
      return "";
    }
    this.chars += clean.length;
    this.sentences += 1;
    if (this.sentences >= DIGEST_MAX_SENTENCES) this.done = true;
    return clean;
  }
}

/**
 * Clean a whole model summary for the synthesiser — the non-streaming form
 * of `DigestStream`, same rules; empty when it is unusable.
 */
export function tidyDigest(reply: string): string {
  const stream = new DigestStream();
  const clean = [...stream.push(reply), ...stream.finish()].join(" ");
  return clean.length < 8 ? "" : clean;
}
