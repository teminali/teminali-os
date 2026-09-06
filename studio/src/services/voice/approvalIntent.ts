/**
 * Answering a permission prompt out loud.
 *
 * Two things in this application stop and ask before they act: the built-in
 * chat's command gate (`hooks/useCommandApproval.ts`) and an agent CLI's own
 * permission prompt (`panels/AgentPane.tsx`). Both were mouse-only, which is
 * fine at a keyboard and useless the moment the operator is talking to Temy
 * from across the room — the run stalls on a button nobody is near.
 *
 * So the assistant reads the prompt aloud and listens for the answer. What it
 * must never do is *replace* the buttons: the prompt stays on screen exactly as
 * it was, and speaking is a second door into the same decision rather than a
 * different one. See `hooks/useSpokenApproval.ts` for the wiring.
 *
 * ## Why the matching is deliberately narrow
 *
 * A misheard "allow" runs a command the operator did not agree to, and the
 * microphone hears the room. So this refuses far more than it accepts:
 *
 * - Only a **short** utterance can be an answer. A sentence is a request, not
 *   a yes — "yes, and then push the branch" is the operator talking, and it
 *   goes to the model with the prompt still standing.
 * - The phrase must be the *whole* utterance, not a word inside one. "I don't
 *   know" contains "no" and means nothing of the sort.
 * - Anything unmatched is `null`, which is the safe answer: nothing is
 *   approved, nothing is denied, and the words travel on as ordinary speech.
 *
 * Pure and dependency-free, so the table below can be tested on its own —
 * `tests/approval-intent.test.mjs`.
 */

/** What an utterance was: an answer to the prompt, or not an answer at all. */
export type ApprovalAnswer = "allow" | "allow-always" | "deny" | null;

/**
 * The most words an utterance may carry and still be read as an answer.
 *
 * Six is enough for every natural way of saying it — "yeah go ahead and run
 * it" is five — and short enough that a real instruction cannot hide in it.
 */
const MAX_ANSWER_WORDS = 6;

/**
 * "and stop asking". Tested before the plain affirmatives because every one of
 * these also contains one, and the wider grant has to win the tie.
 */
const ALWAYS = [
  /^(?:yes[,.]?\s+)?always(?:\s+allow(?:\s+(?:it|that|them))?)?$/,
  /^(?:yes[,.]?\s+)?(?:don'?t|do\s+not|no\s+need\s+to|stop)\s+ask(?:ing)?(?:\s+(?:me\s+)?again)?$/,
  /^allow\s+(?:them\s+)?all$/,
  /^always\s+(?:do|run)\s+(?:it|that)$/,
];

/**
 * "yes, this one". `ok` is here and `sure` is here because that is what people
 * actually say; `fine` is not, because "fine" is as often resignation about
 * something else entirely.
 */
const ALLOW = [
  /^(?:yes|yeah|yep|yup|yah|ya|aye|sure|ok|okay|okey|alright|right|correct|approved?|granted?)$/,
  /^(?:yes|yeah|yep|yup|sure|ok|okay|alright)[,.]?\s+(?:please|thanks|go\s+ahead|do\s+it|run\s+it|allow\s+it|that'?s\s+fine)$/,
  /^(?:please\s+)?(?:go\s+ahead|carry\s+on|proceed|continue)(?:\s+(?:and\s+)?(?:do|run)\s+it)?$/,
  /^(?:you\s+can\s+|please\s+)?(?:do|run|allow|approve|accept)\s+(?:it|that|this|the\s+command)$/,
  /^(?:that'?s|thats)\s+(?:fine|ok|okay|good)$/,
  /^i\s+(?:approve|allow)(?:\s+(?:it|that))?$/,
];

/** "no". `stop` is deliberately absent — it is the interrupt word, and the
 *  engine settles that one before an utterance ever reaches here. */
const DENY = [
  /^(?:no|nope|nah|negative|never|denied?|deny|skip|cancel|reject(?:ed)?)$/,
  /^(?:no|nope|nah)[,.]?\s+(?:thanks|thank\s+you|don'?t|do\s+not|skip\s+it|cancel\s+it|not\s+now)$/,
  /^(?:please\s+)?(?:don'?t|do\s+not)(?:\s+(?:do|run|allow)(?:\s+(?:it|that|this))?)?$/,
  /^(?:not\s+(?:now|yet|this\s+(?:one|time)))$/,
  /^i\s+(?:don'?t|do\s+not)\s+(?:want|allow|approve)(?:\s+(?:it|that))?$/,
];

/**
 * The utterance as the tables want it: lower case, no punctuation at the edges,
 * one space between words. Dictation punctuates, and "Yes." must be the same
 * answer as "yes".
 */
function tidy(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:]+/g, " ")
    .replace(/[""''`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read an utterance as an answer to a pending prompt, or `null` when it is not
 * one — which is the ordinary case and must stay cheap and unsurprising.
 */
export function classifyApprovalReply(text: string): ApprovalAnswer {
  const phrase = tidy(text ?? "");
  if (!phrase) return null;
  if (phrase.split(" ").length > MAX_ANSWER_WORDS) return null;

  if (ALWAYS.some((pattern) => pattern.test(phrase))) return "allow-always";
  if (ALLOW.some((pattern) => pattern.test(phrase))) return "allow";
  if (DENY.some((pattern) => pattern.test(phrase))) return "deny";
  return null;
}

/** The prompt, as much of it as is worth saying out loud. */
export interface SpokenApprovalRequest {
  /** Who is asking — "Claude Code", or "The assistant" for the built-in chat. */
  asker: string;
  /** What it wants to do, in one phrase: a command, or a tool name. */
  action: string;
  /** What "always" would cover, or null when this prompt has no always. */
  alwaysLabel?: string | null;
}

/**
 * How long a command may be before it is announced rather than recited.
 *
 * A shell one-liner with four pipes and a path is unlistenable, and reading it
 * out is worse than useless — the operator cannot check it by ear anyway, and
 * it is on screen in front of them. Past this, they are told there is a command
 * and asked to look.
 */
const MAX_SPOKEN_ACTION = 60;

/**
 * The question, phrased for the ear.
 *
 * It always ends by naming both answers. An operator who has just been read a
 * command needs to know that "yes" is a word this thing is listening for —
 * otherwise they say it to an assistant that was never armed.
 */
export function describeApprovalRequest(request: SpokenApprovalRequest): string {
  const action = (request.action ?? "").trim().replace(/\s+/g, " ");
  const asker = (request.asker ?? "").trim() || "The agent";

  if (!action) return `${asker} is asking for permission. Say yes to allow it, or no to refuse.`;

  if (action.length > MAX_SPOKEN_ACTION) {
    return `${asker} wants to run a command — it is on screen. Say yes to allow it, or no to refuse.`;
  }
  return `${asker} wants to run ${action}. Say yes to allow it, or no to refuse.`;
}
