import { DEFAULT_VOICE_SETTINGS } from "./types.ts";

/*
  The words that always work. A wake word the operator adds in Settings never
  reached this file, because the list was frozen from the defaults at module
  load: the same "third copy" this comment used to claim had been fixed.

  The operator's list now arrives as the second argument and is merged on top,
  the way `stripWakeWord(text, wakeWords)` in `addressing.ts` already takes its
  list as a parameter instead of freezing one. Callers with no settings in hand
  still get the defaults.
*/
const BASE_WAKE_WORDS = [...DEFAULT_VOICE_SETTINGS.wakeWords, "assistant"];
const LEADING_FILLERS = /^(hey|yo|so|well|um|uh|please|can\s+you|could\s+you|would\s+you|just)\s+/i;

/*
  An operator can type anything into the wake-word field, so the alternation is
  escaped before it becomes a pattern. Unescaped, a word holding "(" throws a
  SyntaxError on the chat's send path.
*/
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface WakePatterns {
  leading: RegExp;
  trailing: RegExp;
}

let cachedKey: string | null = null;
let cachedPatterns: WakePatterns | null = null;

/*
  Compiled per distinct list and memoised: this runs on every send, but the list
  changes only when the operator edits Settings. Longest first, so "teminali" is
  never consumed as "temi" with a stray "nali" left behind.
*/
function wakePatterns(wakeWords?: readonly string[]): WakePatterns {
  const words = Array.from(
    new Set([...(wakeWords ?? []), ...BASE_WAKE_WORDS].map((word) => word.trim())),
  )
    .filter((word) => word.length > 0)
    .sort((a, b) => b.length - a.length);
  const key = words.join(" ");
  if (cachedPatterns && cachedKey === key) return cachedPatterns;

  const alternation = words.map(escapeForPattern).join("|");
  const patterns: WakePatterns = {
    leading: new RegExp(`^(?:hey\\s+|yo\\s+|ok(?:ay)?\\s+)?(?:${alternation})[\\s,.:!—-]+`, "i"),
    trailing: new RegExp(`[\\s,]+(?:${alternation})[\\s.!?]*$`, "i"),
  };
  cachedKey = key;
  cachedPatterns = patterns;
  return patterns;
}

const ACTION_VERBS = new Set([
  "fix", "repair", "build", "create", "make", "add", "implement", "refactor",
  "rewrite", "update", "edit", "modify", "delete", "remove", "deploy", "run",
  "install", "compile", "generate", "write", "commit", "push", "test",
]);

/**
 * Generates an immediate conversational verbal acknowledgment ("On it", "Right away", etc.)
 * ONLY for explicit action commands or affirmations, avoiding canned robotic fillers for greetings,
 * queries, and casual conversations.
 *
 * Pass `wakeWords` from `VoiceSettings` so a word the operator added is stripped
 * here too; omitting it falls back to the built-in list.
 */
export function getImmediateAcknowledgment(text: string, wakeWords?: readonly string[]): string | null {
  if (!text) return null;
  const patterns = wakePatterns(wakeWords);
  let cleaned = text.trim();
  // Strip trailing wake words: "hello teminali" -> "hello"
  cleaned = cleaned.replace(patterns.trailing, "").trim();
  // Strip leading wake words: "temy, fix this" -> "fix this"
  cleaned = cleaned.replace(patterns.leading, "").trim();
  // Strip leading conversational fillers: "can you fix this" -> "fix this", "so hello" -> "hello"
  cleaned = cleaned.replace(LEADING_FILLERS, "").trim();

  const lower = cleaned.toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, " ").trim();
  if (!lower) return null;

  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  /*
    A greeting is still a greeting behind a wake word or a filler. The tests
    below are anchored at the start of the utterance, so "Temy, hello" and
    "um, hello" used to miss this branch and fall through to a canned
    acknowledgement — the operator heard a work reply to "hello". Speech is
    what feeds this, and speech arrives with exactly that kind of preamble.
  */
  const opening = lower
    .replace(/^(?:(?:um|uh|erm|er|ah|oh|well|so|hey|ok|okay)\b[\s,]*)+/i, "")
    .replace(/^(?:(?:temy|teminali|frontier|studio)\b[\s,]*)+/i, "")
    .trim() || lower;

  // 1. Direct greetings and presence checks — always answer naturally without canned filler
  const isGreeting =
    /^(hi|hello|hey|greetings|howdy|good\s+(morning|afternoon|evening|day)|sup|yo|what'?s\s+up|habari)\b/i.test(opening) ||
    /^(are\s+you\s+(there|ready|listening|awake)|can\s+you\s+(hear|help)\s+me|who\s+are\s+you|how\s+are\s+you|how'?s\s+it\s+going|what\s+can\s+you\s+do|nice\s+to\s+meet\s+you|what'?s\s+your\s+name|who\s+am\s+i\s+talking\s+to)\b/i.test(opening);
  if (isGreeting) {
    return null;
  }

  // 2. Affirmations / direct confirmations to proceed
  if (
    (/^(yes|yeah|yep|sure|ok|okay|go\s+ahead|do\s+it|do\s+that|do\s+so|do|please\s+do|proceed|sounds\s+good|absolutely|definitely)\b/i.test(lower) ||
     /^(please\s+do|go\s+ahead|sounds\s+good|do\s+it|do\s+that)\b/i.test(cleaned.toLowerCase())) &&
    words.length <= 4
  ) {
    const acks = ["Sure thing.", "Right away.", "On it."];
    return acks[Math.floor(Math.random() * acks.length)];
  }

  // 3. Information queries, explanations, searches — let streaming reply speak directly
  const queryPattern = /^(what|why|how|where|which|who|when|explain|describe|tell\s+me|show\s+me|summarize|inspect|check|find|search|list|read)\b/i;
  if (queryPattern.test(lower)) {
    return null;
  }

  // 4. Explicit action / engineering task commands
  const startsWithAction = ACTION_VERBS.has(words[0]);
  const hasActionWithTarget = words.length >= 2 && (startsWithAction || ACTION_VERBS.has(words[1]));

  if (hasActionWithTarget) {
    const actionAcks = ["Working on it.", "Getting right on that.", "On it."];
    return actionAcks[Math.floor(Math.random() * actionAcks.length)];
  }

  // 5. Default fallback: say nothing and let the model answer naturally
  return null;
}
