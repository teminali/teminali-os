/**
 * Turn intent — "what does the operator want *done* with this utterance?"
 *
 * Addressing (`addressing.ts`) answers "was that for me?". This answers the
 * next question, which only matters while the assistant is busy: is the
 * operator redirecting the work, commenting on it, asking how it is going, or
 * telling it to stop? The distinction is what lets a hands-free session behave
 * like a colleague at the next desk rather than a push-button:
 *
 *   - "excellent, keep going"      → acknowledge: carry on, say nothing much
 *   - "how's it looking?"          → status: answer from the live run, keep working
 *   - "wait, stop"                 → stop: cancel the run, go quiet
 *   - "also rename the component"  → instruction: the run is replaced
 *
 * Before this gate every directed utterance was an instruction, so "great,
 * carry on" cancelled the build it was praising.
 *
 * Everything here is rules. It runs synchronously on every committed turn, so
 * a model round-trip is not affordable, and the phrases involved are the most
 * formulaic words people say.
 */

export type TurnIntent = "stop" | "acknowledge" | "status" | "instruction";

export interface TurnIntentContext {
  /** The chat engine is generating or an agent run is in flight. */
  busy: boolean;
  /** The assistant was mid-sentence when this utterance arrived. */
  speaking: boolean;
}

export interface TurnIntentVerdict {
  intent: TurnIntent;
  reason: string;
}

/** Words that carry no intent on their own and are dropped before matching. */
const FILLERS = new Set([
  "ok", "okay", "okey", "alright", "right", "so", "well", "um", "uh", "hmm", "ah", "oh",
  "please", "now", "just", "hey", "yo", "and", "then", "also", "actually",
  "thanks", "thank", "you", "temy", "teminali", "frontier", "studio",
  "sawa", "basi", "haya",
]);

/** Phrases that mean "cancel what you are doing". Matched whole, after fillers are removed. */
const STOP_PHRASES = [
  "stop", "stop stop", "stop stop stop", "stop it", "stop that", "stop there", "stop talking", "stop now",
  "cancel", "cancel that", "cancel it", "abort", "halt", "kill it",
  "wait", "wait wait", "wait wait wait", "hold on", "hang on", "hold up", "hold it",
  "never mind", "nevermind", "forget it", "forget that", "scratch that", "leave it",
  "that's enough", "thats enough", "enough", "enough enough", "pause", "pause that",
  "quiet", "be quiet", "shut up", "hush", "shh", "no no", "no no no", "no stop", "no wait",
  "acha", "achana nayo", "simama", "subiri", "ngoja", "nyamaza", "tosha", "wacha",
];

/**
 * Phrases that mean "carry on". A whole utterance made only of these (in any
 * combination — "excellent excellent great keep going") is an acknowledgement.
 */
const ACK_PHRASES = [
  "great", "excellent", "nice", "cool", "awesome", "perfect", "good", "very good", "good job",
  "nice work", "great work", "well done", "nice one", "brilliant", "fantastic", "amazing",
  "lovely", "beautiful", "sweet", "wonderful", "love it", "i like it", "i love it",
  "keep going", "keep at it", "carry on", "continue", "go on", "go ahead", "proceed",
  "keep it up", "do that", "do it", "sounds good", "looks good", "that's fine", "thats fine",
  "fine", "yes", "yeah", "yep", "yup", "sure", "got it", "i see", "cheers", "ta",
  "mm", "mhm", "uh huh", "aha", "correct", "exactly", "indeed", "true",
  "poa", "safi", "vizuri", "endelea", "ndiyo", "asante", "sawa sawa", "fresh", "nzuri",
];

/** Patterns that ask how the work is going. */
const STATUS_PATTERNS: RegExp[] = [
  /\b(status|progress)\b/,
  /\b(any|an|quick)\s+update\b/,
  /\bupdate\s+me\b/,
  /\bhow('?s| is| are)\s+(it|things|that|this|we|you)\s+(going|looking|coming|doing)\b/,
  /\bhow('?s| is)\s+(it|that|this)\b\??$/,
  /\bhow\s+(far|much\s+longer|long)\b/,
  /\bwhere\s+are\s+(we|you)(\s+at|\s+now|\s+with\s+\w+)?\b/,
  /\bwhat\s+are\s+you\s+(doing|working\s+on|up\s+to)\b/,
  /\bwhat('?s| is)\s+(happening|going\s+on|the\s+status|the\s+progress|left|remaining|next)\b/,
  /\b(are|is)\s+(you|it|that|this)\s+(done|finished|ready|complete|completed|live|deployed|working|there|still\s+going)\b/,
  /\bdid\s+(the\s+|that\s+|those\s+)?(it|that|you|tests?|build|deploy|deployment|check|checks)\s+(work|finish|pass|deploy|build|complete|succeed|go\s+through|come\s+back)\b/,
  /\b(are\s+)?you\s+still\s+(there|working|going|on\s+it)\b/,
  /\bstill\s+(working|going)\b\??$/,
  /\b(is|are)\s+(the\s+)?(tests?|build|deploy|deployment)\s+(passing|done|green|finished|through)\b/,
  /\balmost\s+(done|there)\b\??$/,
  /\bdone\s+yet\b/,
  /\bumefika\s+wapi\b/,
  /\binaendeleaje\b/,
  /\bimeisha\b/,
  /\bbado\b\??$/,
];

function normalise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function withoutFillers(words: string[]): string[] {
  return words.filter((word) => !FILLERS.has(word));
}

/**
 * True when `words` can be consumed entirely by phrases from `phrases`,
 * longest match first, in any order. Used for the stop and acknowledge sets.
 */
function consumedBy(words: string[], phrases: string[]): boolean {
  if (words.length === 0) return false;
  const byLength = [...phrases].sort((a, b) => b.split(" ").length - a.split(" ").length);
  let index = 0;
  while (index < words.length) {
    let matched = false;
    for (const phrase of byLength) {
      const parts = phrase.split(" ");
      if (parts.length > words.length - index) continue;
      let ok = true;
      for (let offset = 0; offset < parts.length; offset += 1) {
        if (words[index + offset] !== parts[offset]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        index += parts.length;
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

export function classifyTurnIntent(text: string, context: TurnIntentContext): TurnIntentVerdict {
  const words = normalise(text);
  const core = withoutFillers(words);
  const joined = words.join(" ");
  const engaged = context.busy || context.speaking;

  // A bare stop is a stop whether or not anything is running; "stop the
  // server" is not, because something follows the verb.
  if (consumedBy(core, STOP_PHRASES) || (core.length === 0 && consumedBy(words, STOP_PHRASES))) {
    return { intent: "stop", reason: "Asked to stop." };
  }
  // "no, stop" / "okay stop now" — a short utterance that contains a stop word
  // and nothing that reads as a new task.
  if (core.length <= 4 && core.includes("stop") && !/\b(the|a|my|that|this)\s+\w+/.test(core.join(" "))) {
    return { intent: "stop", reason: "Asked to stop." };
  }

  if (!engaged) {
    // Nothing to comment on and nothing to report: whatever this is, the chat
    // should see it. "yes" is the answer to a question; "how's it going" is a
    // greeting.
    return { intent: "instruction", reason: "Nothing is running, so this goes to the chat." };
  }

  if (STATUS_PATTERNS.some((pattern) => pattern.test(joined))) {
    return { intent: "status", reason: "Asked how the work is going." };
  }

  // Encouragement must be genuinely consumed by acknowledgement phrases; an
  // empty core caused by attention words like "hey" or "temy" is not praise.
  if ((core.length > 0 && consumedBy(core, ACK_PHRASES)) || (core.length === 0 && consumedBy(words, ACK_PHRASES))) {
    return { intent: "acknowledge", reason: "Encouragement — carrying on." };
  }

  return { intent: "instruction", reason: "Reads as a new instruction." };
}
