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
 * Three more, because "do not interrupt the work" is a larger set than praise
 * and a status check:
 *
 *   - "stop talking"               → hush: the *voice* stops, the run does not
 *   - "say that again"             → repeat: re-say the last thing spoken
 *   - "why did you edit that one?" → explain: answered from the run, locally
 *
 * `hush` is a split, not an addition. "stop talking", "be quiet" and "shut up"
 * were in the stop set, so telling the assistant to be quiet cancelled the
 * build it was narrating — the operator asked for silence and lost the work.
 * Bare "stop", "cancel" and "wait" keep their old meaning: those are about the
 * work, and §6.8's doctrine that a stop must land on the spot is unchanged.
 *
 * `explain` is deliberately narrow. It fires only on an utterance that is both
 * shaped like a question *and* pointing at the work in flight — "that", "this",
 * "it", "that step". A question about anything else is still an instruction and
 * still reaches the chat, because swallowing "what is the capital of France"
 * into a run digest would be worse than interrupting.
 *
 * Everything here is rules. It runs synchronously on every committed turn, so
 * a model round-trip is not affordable, and the phrases involved are the most
 * formulaic words people say.
 */

export type TurnIntent =
  | "stop"
  | "hush"
  | "repeat"
  | "acknowledge"
  | "status"
  | "explain"
  | "instruction";

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
  "never mind", "nevermind", "never mind that", "forget it", "forget that", "scratch that", "leave it",
  // Abandonment said the other way round. "never mind" was here and "drop
  // it" was not, so "never mind, drop it" — one of the plainest ways to call
  // a run off — was consumed halfway, failed, and fell through to
  // `instruction`: the operator asking for the work to end got more of it.
  "drop it", "drop that", "drop this", "forget about it", "forget about that",
  "skip it", "skip that", "leave that", "leave it be", "let it go",
  "don't bother", "dont bother", "do not bother", "no need", "not needed",
  "that's enough", "thats enough", "enough", "enough enough", "pause", "pause that",
  "no no", "no no no", "no stop", "no wait",
  "acha", "achana nayo", "acha hiyo", "wacha hiyo", "sahau", "simama", "subiri", "ngoja", "tosha", "wacha",
];

/**
 * Phrases that mean "stop *talking*" — the voice, not the work.
 *
 * Matched before the stop set, because "stop talking" opens with the word that
 * cancels a run and means nothing of the kind. Silence is the whole request:
 * an operator who wants the narration to end while a build finishes should get
 * exactly that, and used to lose the build instead.
 */
const HUSH_PHRASES = [
  "stop talking", "stop speaking", "stop narrating", "stop reading", "stop saying that",
  "quiet", "be quiet", "keep quiet", "shut up", "hush", "shh", "shhh", "ssh",
  "silence", "no more talking", "enough talking", "stop the talking", "less talking",
  "don't talk", "dont talk", "do not talk", "don't speak", "dont speak",
  "mute", "mute yourself", "stop the narration", "stop commentary",
  "nyamaza", "acha kuongea", "usiseme", "usiongee", "kimya",
];

/**
 * Phrases that mean "say that again". A repeat costs nothing and asks nothing
 * of the run, so it is answered from what was last spoken.
 */
const REPEAT_PHRASES = [
  "say that again", "say it again", "say again", "repeat", "repeat that", "repeat it",
  "repeat please", "come again", "one more time", "again", "once more",
  "what did you say", "what was that", "what did you just say", "sorry what",
  "pardon", "pardon me", "i missed that", "i didn't hear", "i didnt hear",
  "i didn't catch that", "i didnt catch that", "didn't catch that", "didnt catch that",
  "rudia", "sema tena", "tena", "sikusikia",
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

/**
 * Does this point at the work in flight rather than at the world?
 *
 * Deixis is the whole test. "Why that one?" only means anything if something
 * is happening, and that is exactly the case `explain` is for; "why is the sky
 * blue" names its own subject and belongs to the chat.
 */
const WORK_NOUN =
  "one|thing|step|part|bit|file|command|test|tests|error|change|edit|script|output|result|line|folder|directory|function|check|build|run";

/**
 * Either a determiner pointing at a thing the run is handling — "that file",
 * "this command" — or a bare pronoun used pronominally.
 *
 * The second half needs the lookahead. A bare `\bthis\b` also matches "who
 * wrote this language", which is a question about the world wearing a
 * demonstrative, and routing it to the run digest would answer it wrongly
 * instead of merely interrupting. So the pronoun counts only where a noun does
 * not follow it: at the end of the utterance, or before a verb.
 */
const WORK_DEIXIS = new RegExp(
  `\\b(that|this|those|these|the)\\s+(${WORK_NOUN})\\b` +
    `|\\b(that|this|it|those|these)\\b(?=\\s*$|\\s+(is|was|are|were|do|does|did|mean|means|meant|for|about|again|now|then|running|doing|going|${WORK_NOUN}))`,
);

/**
 * The other way a question points at the run: through the agent doing it.
 *
 * `WORK_DEIXIS` only recognises pointing with a demonstrative — "that file",
 * "this command". §6.30's second finding is what that misses. "Which file are
 * you in", asked mid-run, contains no demonstrative at all, so it fell through
 * to `instruction`, and `machineAction` read "which file" as work and started a
 * *second* agent to answer a question about the first one. The operator gets
 * two runs and no answer, when the digest behind the process line already
 * knew.
 *
 * The subject is the whole test: a work noun immediately after the wh-word,
 * and a copula whose subject is the assistant or the work itself. "Which file
 * should I open" keeps its subject and stays an instruction; "what file do you
 * want" is not a copula and stays one too.
 */
const SELF_WORK_QUESTION = new RegExp(
  `\\b(what|which)\\s+(${WORK_NOUN})\\s+(are|is|was|were)\\s+(you|it|that|this)\\b`,
);

/** An utterance shaped like a question, by opener or by punctuation. */
const QUESTION_OPENERS =
  /^(what|why|which|who|whose|where|when|how|is|are|was|were|do|does|did|can|could|should|would|will|nini|kwa\s?nini|vipi|lini|wapi|nani|gani|kwa\s?ajili)\b/;

/**
 * Verbs that open a new task. An imperative is an instruction however much it
 * mentions "that": "rename that file" is work, not a question about work.
 */
const IMPERATIVE_OPENERS =
  /^(add|create|make|write|build|change|rename|delete|remove|move|copy|fix|update|refactor|install|run|open|close|start|stop|deploy|commit|push|pull|revert|undo|redo|set|use|switch|show|give|send|generate|implement|replace|rewrite|test|check|try|put|take|call|find|search|look|go|let|do|apply|save|export|import|merge|split|clean|format|lint|upgrade|downgrade|enable|disable|configure|fanya|tengeneza|badilisha|ondoa|weka|andika)\b/;

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
 * Tails that qualify a request without changing what is being asked.
 *
 * §6.30's third and fourth findings read like two missing entries and are one
 * missing rule. `consumedBy` must consume the *whole* utterance, so a phrase
 * set only holds for an utterance made of nothing else — and "for a second" is
 * the most formulaic thing anyone appends to a request for quiet. "quiet" was
 * a hush and "quiet for a second" was a new task; "wait" stopped the run and
 * "wait a second" started one. Adding those two literals would have fixed two
 * wordings and left "for a sec" and "for a minute" broken, which is precisely
 * the failure §6.30 named: a gate that holds for one wording holds for none.
 *
 * Stripped from the end only, and never down to nothing. A bare "for a second"
 * qualifies a request nobody has made yet, and must not be read as silence or
 * as a stop on its own.
 */
const QUALIFIER_TAILS = [
  "for a second", "for a sec", "for a minute", "for a moment", "for a bit", "for a while",
  "for a second or two", "for the moment", "for now",
  "a second", "a sec", "a minute", "a moment", "a bit",
  "kidogo", "kwa muda",
  // Residue, not a phrase. Fillers come off first, so "cancel that for now"
  // reaches here as "cancel that for" — the tail is already half gone and
  // what is left of it must not be what fails the match.
  "for",
];

function withoutQualifierTail(words: string[]): string[] {
  let rest = words;
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const tail of QUALIFIER_TAILS) {
      const parts = tail.split(" ");
      // `>=`, not `>`: an utterance that is only a tail keeps it and matches
      // nothing, which is the point.
      if (parts.length >= rest.length) continue;
      const at = rest.length - parts.length;
      if (parts.every((part, offset) => rest[at + offset] === part)) {
        rest = rest.slice(0, at);
        stripped = true;
        break;
      }
    }
  }
  return rest;
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
  // What the phrase sets are matched against: the core with any duration
  // qualifier taken off the end, so "quiet for a second" is the same request
  // as "quiet". Only the whole-utterance sets use it; the regex gates below
  // still read the full text, where the tail may carry meaning.
  const stem = withoutQualifierTail(core);
  const joined = words.join(" ");
  const engaged = context.busy || context.speaking;

  // Before the stop set, because every one of these opens with a word that
  // would otherwise cancel the run. Silence is the whole request.
  if (consumedBy(stem, HUSH_PHRASES) || (core.length === 0 && consumedBy(words, HUSH_PHRASES))) {
    return { intent: "hush", reason: "Asked for quiet, not for the work to end." };
  }

  // "say that again" — free, and asks nothing of the run.
  // Matched against the raw words as well as the core: "you" is a filler (it
  // is half of "thank you"), and stripping it turns "what did you say" into
  // "what did say", which is nothing at all.
  if (consumedBy(words, REPEAT_PHRASES) || consumedBy(core, REPEAT_PHRASES)) {
    return { intent: "repeat", reason: "Asked to hear it again." };
  }

  // A bare stop is a stop whether or not anything is running; "stop the
  // server" is not, because something follows the verb.
  if (consumedBy(stem, STOP_PHRASES) || (core.length === 0 && consumedBy(words, STOP_PHRASES))) {
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
  if ((stem.length > 0 && consumedBy(stem, ACK_PHRASES)) || (core.length === 0 && consumedBy(words, ACK_PHRASES))) {
    return { intent: "acknowledge", reason: "Encouragement — carrying on." };
  }

  /*
    A question about the work in flight.

    Both tests have to pass. The question shape alone would swallow "what is
    the capital of France"; the deixis alone would swallow "rename that file".
    An imperative opener vetoes it outright, because a sentence that starts
    with a verb is a task however many times it says "that".

    What survives is the case the operator actually described: the run is
    narrating, one item of it is unclear, and the question is about that item.
    It is answered from the run rather than sent to the chat, because sending
    it would replace the very work the question is about.

    `SELF_WORK_QUESTION` is the same case reached by the other road — the
    question points at the run through the agent rather than through a
    demonstrative. Both are tested against `joined` rather than the core,
    because "you" is a filler here (it is half of "thank you") and stripping it
    turns "which file are you in" into something with no subject left to test.
  */
  const coreJoined = core.join(" ");
  if (
    !IMPERATIVE_OPENERS.test(coreJoined) &&
    (QUESTION_OPENERS.test(coreJoined) || /\?\s*$/.test(text.trim())) &&
    (WORK_DEIXIS.test(joined) || SELF_WORK_QUESTION.test(joined))
  ) {
    return { intent: "explain", reason: "Asked about something the run is doing." };
  }

  return { intent: "instruction", reason: "Reads as a new instruction." };
}
