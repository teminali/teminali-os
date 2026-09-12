/**
 * Does this utterance ask the machine to *do* something — and what kind?
 *
 * This replaces `isEngineeringTask`, which asked a narrower question badly. Its
 * two blanket rejections were the whole problem:
 *
 *   - **four words or fewer → never work.** "Play that video." "Open my
 *     downloads." "Stop the build." Every short imperative a person actually
 *     speaks is four words or fewer, and speech is shorter than typing.
 *   - **ends in a question mark → never work.** Spoken instructions are
 *     habitually polite: "can you open the config?" is an instruction wearing
 *     a question's punctuation.
 *
 * Both misroutes land in the same place: the utterance goes to Temi's persona
 * LLM, which has no hands and a prompt that never admits it, so it answers *in
 * character* — it says the thing was done. That is the fantasising the operator
 * hears. A gate that under-detects work does not produce silence; it produces
 * confident fiction.
 *
 * So the question here is asked positively — is there an imperative aimed at a
 * thing this machine owns — rather than by keyword soup. Pure rules, no
 * imports, for the same reason `engineeringTask.ts` was: `voiceTurnRouter` must
 * be able to ask without dragging stores and `AIService` into a node test.
 *
 * See `studio/DESIGN.md` §6.0.4.
 */

/**
 * What family of work this is. The router hands every one of these to the
 * assistant; the kind decides what Temi says *while* it happens, and it is
 * what the eval scores. Keeping them apart is what proves the gate covers the
 * capabilities the operator actually named, rather than "engineering" in the
 * abstract.
 */
export type MachineActionKind =
  /** Play, pause, seek, mute — the media the operator is looking at. */
  | "media"
  /** Switch project or workspace root. */
  | "workspace"
  /** Reveal or open a file or folder that already exists. */
  | "open"
  /** Create, write, edit, rename, delete a file or folder. */
  | "edit"
  /** Run something: build, test, install, a command. */
  | "shell"
  /** Look at what exists: read, search, summarise, review. */
  | "inspect";

export interface MachineAction {
  kind: MachineActionKind;
  /** Why it matched, for the decision trail and for test failure messages. */
  reason: string;
}

/**
 * Conversational frames that contain action verbs but ask for an opinion.
 * Checked before anything else, because "what do you make of this error" is
 * the exact false positive the old gate produced — it matched on *make*.
 */
const OPINION_FRAMES = [
  /\bwhat (do|did) you (make of|think|reckon|feel)\b/i,
  /\bhow do you feel\b/i,
  /\bwhat'?s your (take|opinion|view|sense)\b/i,
  /\bdo you (think|believe|reckon|like|prefer|remember|know)\b/i,
  /\bwhat would you (do|say|choose)\b/i,
  /\btell me (about|what you)\b/i,
  /\bwhy (do|did|is|was|are|were)\b/i,
  /\bhow (are|is) (you|it going)\b/i,
];

/**
 * The object half of the test. An imperative verb with nothing of this
 * machine's in range is conversation: "run along", "open up to me", "make me
 * laugh". Deliberately generous — a false negative here is a fantasised
 * answer, which is worse than delegating a sentence that turns out to be chat.
 *
 * `port`, `version` and `model` were added by §6.30's first finding. They were
 * already nouns `STATE_QUESTIONS` asks about, but they were not objects, and
 * both halves have to agree before a question reaches the state branch — so a
 * bare "what's the port" could never get there however the state patterns were
 * written, and "8080" came back instead. A noun the voice is willing to invent
 * a value for belongs on both lists or on neither.
 */
const MACHINE_NOUNS =
  /\b(file|files|folder|folders|directory|dir|project|projects|workspace|workspaces|repo|repository|video|clip|movie|track|audio|song|music|playback|player|terminal|command|shell|script|build|tests?|suite|server|app|code|function|component|readme|config|package|branch|commit|log|logs|screen|window|tab|pane|editor|timeline|path|document|note|notes|bug|bugs|error|errors|warning|warnings|issue|issues|crash|regression|feature|dependency|dependencies|import|imports|type|types|deploy|deployment|release|install|migration|pipeline|job|task|port|ports|version|versions|model|models|router|routers|route|routes|endpoint|endpoints|module|modules|gate|gates|handler|handlers|hook|hooks|schema|query|queries|panel|panels|sidebar|storage|memory|disk|drive|desktop)\b/i;

/**
 * `it`, `this` and `that` are objects only when they are the thing the verb is
 * being done to -- "play it", "open that", "close this", "rename that file".
 * They are the commonest spoken forms and there is no other object to find.
 *
 * They are also by far the loosest match in the file, which is why the rule has
 * always been that they "only count behind a verb". That was written down and
 * not implemented: `hasObject` tested the whole sentence, so a pronoun anywhere
 * satisfied a verb anywhere, in either order. `make` and `change` are ordinary
 * English, so every sentence built from "that" and "make" became a coding task.
 *
 * Measured 2026-09-11, spoken to the voice: "Interesting. Say something that
 * will make me surely see that you have improved especially in your
 * personality." classified `edit`, was delegated to a background agent, and the
 * operator got "On it." followed by "Done." instead of an answer.
 *
 * So the pronoun must now actually sit behind the verb, with at most one word
 * between them -- "show me that" is a command, "make me see it" is not.
 */
const PRONOUN_OBJECT = /^\W*(?:\w+\W+)?(it|this|that|these|those)\b/i;

/**
 * The same pronouns, anywhere in the sentence.
 *
 * A state question may point with one and have no verb for it to sit behind:
 * "is it still running", "did that change land". Those are looks, and a look is
 * cheap and changes nothing, so the loose test is the right one there. The
 * strict rule above exists because the verb groups end in a delegated agent
 * run, which is neither cheap nor free of consequences.
 */
const PRONOUN_ANYWHERE = /\b(it|this|that|these|those)\b/i;

/**
 * A definite noun phrase sitting directly behind the verb: "open **the voice
 * router**", "check **the endpointer**", "read **that migration**".
 *
 * `MACHINE_NOUNS` is a list, and a list cannot name the things in one codebase.
 * Measured 2026-09-12 by `evals/voice-conversation.mjs`: "Open the voice router
 * and tell me what it does" stayed in chat across every run, because `router` is
 * not on the list — and the voice then described a file it has never read. The
 * eval's route-to-hands bucket sat at 8/12 with this and one other turn failing
 * in both repetitions, which is the operator's report that his instructions do
 * not reach the hands.
 *
 * Only for verbs that LOOK (`open`, `inspect`), never for the ones that change
 * or run something, and that asymmetry is the whole safety argument: this file
 * already holds that "a wasted call costs a moment, an invented answer costs
 * trust", and a look is the cheapest thing the hands can do.
 *
 * The determiner must be `the`/`this`/`that`, and must sit immediately after the
 * verb. Both halves matter. `your` and `my` are excluded because "open your mind
 * for a second and hear me out" is the eval's standing case for a sentence that
 * must never be delegated; and requiring adjacency keeps "show me the way" and
 * "open up to me" in chat, where the determiner is further down the sentence.
 */
/**
 * A filename as it is SPOKEN. "What's in package dot json?" is the ordinary way
 * to say `package.json` aloud, and no noun list will ever hold it: the dot is a
 * word, and the stem is whatever the file happens to be called. Measured
 * 2026-09-12, it stayed in chat, which is the fabrication case again -- she
 * cannot read a file she was not sent to.
 */
const SPOKEN_FILENAME =
  /\b[\w-]+\s+dot\s+(?:json|js|jsx|ts|tsx|md|mjs|cjs|yml|yaml|toml|txt|py|sh|lock|env|css|html)\b/i;

const DEFINITE_OBJECT = /^\W*(?:the|this|that|these|those)\s+[\w.\-]+(?:\s+[\w.\-]+){0,2}/i;

/**
 * The verb's own clause: what follows it, up to the first boundary that ends
 * the thing being asked for.
 *
 * The file already fixed this once, for pronouns -- see `PRONOUN_OBJECT` above,
 * where the rule "only counts behind a verb" was written down and not
 * implemented. `MACHINE_NOUNS` had the identical hole and kept it: it was tested
 * against the whole sentence, so one machine-ish noun anywhere licensed any verb
 * anywhere. Measured 2026-09-12, spoken to the voice, both of these launched an
 * agent run against the operator's workspace while he was only talking to her:
 *
 *   "I want to test how good you can sing. Can you sing?"
 *      -> shell. `test` is a verb in the run group AND a noun in MACHINE_NOUNS,
 *         so the verb satisfied its own object requirement. Any sentence with
 *         the word "test" in it delegated.
 *   "...I didn't tell you to work on the handover uh or anything to do with a
 *    terminal code. Uh, just want to make a conversation with you..."
 *      -> edit. "terminal" licensed "make" three clauses away, in a sentence
 *         whose actual meaning was the opposite.
 *
 * Stopping at the boundary is what separates "make a conversation with you" from
 * "make a branch": the noun that matters is the one the verb governs, not the
 * next machine word to appear. `and`/`but`/`or`/`so`/`with`/`because` end a
 * clause for this purpose, as does any sentence punctuation.
 */
function objectWindow(after: string): string {
  const boundary = after.search(/[.,;:?!]|\b(?:and|but|or|so|because|while|then|if|when|with)\b/i);
  return boundary === -1 ? after : after.slice(0, boundary);
}

/**
 * Is there an object for this verb? Every form of object must sit behind the
 * verb, inside its own clause: a named thing, a bare pronoun, or -- for a verb
 * that merely looks -- a definite noun phrase.
 *
 * A verb cannot be its own object. That falls out of slicing from the end of
 * the match rather than being spelled as a rule, and it is the whole of the
 * "test" bug above.
 */
/**
 * Is this verb inside a clause that says NOT to do it?
 *
 * "Don't open anything", "I didn't tell you to work on the handover", "you
 * don't need to run the tests". The verb is real, the object is real, and the
 * sentence is an instruction to leave it alone. Nothing upstream catches this:
 * every pattern in this file matches on the verb and its object, which a
 * negated clause has in full.
 *
 * Bounded two ways, because a negation does not reach across a sentence and
 * should not reach across a long one. It must sit within 40 characters before
 * the verb, and it must not be separated from it by sentence punctuation -- so
 * "I didn't tell you to work on the handover. Open the config file." still
 * opens the config file.
 *
 * Erring toward NOT acting is correct here and is the file's existing
 * doctrine reversed for good reason: elsewhere "a wasted call costs a moment,
 * an invented answer costs trust", but a wrongly-run EDIT costs the operator's
 * working tree, which is dearer than either.
 */
const NEGATOR_BEFORE =
  /\b(?:don'?t|do\s+not|didn'?t|did\s+not|doesn'?t|does\s+not|won'?t|will\s+not|can'?t|cannot|never|no\s+need\s+to|not|stop\s+\w+ing|rather\s+you\s+didn'?t)\b[^.;!?]{0,40}$/i;

/**
 * Is the verb inside a clause that is not an instruction at all?
 *
 * The object window and the negation guard both ask about DISTANCE and POLARITY.
 * Neither can see grammatical MOOD, and mood is the whole difference between
 * asking for a thing and talking about it. Measured 2026-09-12 against
 * `tests/voice-delegation-safety.test.mjs`, every one of these had a real verb
 * governing a real machine object, and every one launched an agent:
 *
 *   "If I asked you to delete the file, would you actually do it?"
 *      -- answered a question about deleting by deleting.
 *   "Suppose I told you to open the config, would that scare you?"
 *   "Imagine you had to fix this whole thing yourself."
 *   "He told me to run the build before the demo, but I forgot."
 *   "The last agent I used would just delete files without asking."
 *      -- a complaint about a previous agent, self-fulfilled.
 *   "Do you ever get lonely when I close the laptop?"
 *
 * Three frames, and each is matched only in the run-up to the verb so it cannot
 * reach across the sentence that follows:
 *
 * HYPOTHETICAL. `if`/`suppose`/`imagine` alone is not enough -- "if you can,
 * open the config" is a real request. It is the pairing with a reporting or
 * modal verb ("if I ASKED you to", "suppose I TOLD you to", "imagine you HAD
 * TO") that marks the clause as a supposition rather than a request.
 *
 * REPORTED. A third party is the one doing the asking: "he told me to", "the
 * last agent would". An instruction to Temi has `you` or an imperative as its
 * subject, never `he`, `she`, `they`, or somebody else's agent.
 *
 * SUBORDINATE. `when`/`while`/`after`/`before`/`whenever` + `I` describes the
 * operator's own habit, not a thing he wants done -- "when I close the laptop".
 * Requiring the `I` keeps "when you're done, run the tests" working.
 */
const NON_ACTION_FRAMES: RegExp[] = [
  /\b(?:if|suppose|supposing|imagine|what\s+if)\b[^.;!?]{0,40}\b(?:ask(?:ed|s)?|told|tell|said|say|wanted?|had\s+to|were\s+to|would|should)\b[^.;!?]{0,20}$/i,
  /\b(?:he|she|they|somebody|someone|everyone|nobody|the\s+(?:last|other|previous|old)\s+\w+|my\s+(?:friend|colleague|boss|teammate))\b[^.;!?]{0,40}\b(?:told|said|asked|wanted|would|used\s+to)\b[^.;!?]{0,30}$/i,
  /\b(?:when|whenever|while|after|before|since)\s+I\b[^.;!?]{0,30}$/i,
];

/**
 * Fixed phrases that carry a machine verb and a pronoun and mean neither.
 *
 * `PRONOUN_OBJECT` is by design the loosest match in the file, and these are the
 * places it is loosest of all: idioms among the commonest things anyone says
 * aloud, where the pronoun is not the object of a machine verb and no amount of
 * windowing will show that. They are listed rather than reasoned about because
 * an idiom is, definitionally, not compositional.
 */
const NON_ACTION_IDIOMS =
  /* "Stop trying to edit my code" -- `stop` is itself a verb in the run group,
     so this parsed as "stop the code" and started a shell action. It is the
     escalation case and the worst of the idioms: it is what the operator says
     when he has NOTICED the misfire, so the objection launched another run and
     there was no way out of the loop by speaking.
     Narrow on purpose. "stop running the tests" is a real request to stop a
     real thing and still is; only "trying/attempting to" marks the sentence as
     being about effort rather than about a machine. */
  /\b(?:stop|quit)\s+(?:trying|attempting)\s+to\b|\b(?:check\s+(?:this|that|it)\s+out|run\s+(?:that|this|it)\s+by\s+me|run\s+(?:that|this|it)\s+past\s+me|let\s+me\s+think|make\s+yourself\s+(?:at\s+home|comfortable)|give\s+it\s+a\s+rest|take\s+it\s+easy|hold\s+that\s+thought)\b/i;

/**
 * A fact only the machine holds, asked as a question.
 *
 * `STATE_QUESTIONS` already covered "is the build passing" and "how many
 * tests", but it sits behind a `MACHINE_NOUNS || PRONOUN_ANYWHERE` guard, and
 * neither "storage" nor "space" is a machine noun, so a question about the disk
 * never reached it. Measured 2026-09-12, spoken, both answered instantly and
 * both invented:
 *
 *   "the total size of all the files on my desktop folder"
 *      -- she said 12.4 GB. It is 38G across 14,474 files.
 *   "my remaining storage"
 *      -- she said 512 GB. There are 27Gi free on a 460Gi disk, so her answer
 *         was larger than the whole drive.
 *
 * Challenged on the second she said "I don't assume anything, the system
 * provided those numbers, instantly" -- a fabricated provenance defending a
 * fabricated number, and the reason this gate is worth more than the tidiness
 * of leaving these in `STATE_QUESTIONS`. A number she cannot possibly hold has
 * to come from the hands or not be said at all.
 *
 * Still behind the opinion frames above, so "how much space do you need
 * emotionally" is not a disk question.
 */
const MACHINE_FACT_QUESTIONS: RegExp[] = [
  /\b(?:how\s+(?:big|large|heavy|full)|how\s+much\s+(?:space|room|disk|memory|storage)|total\s+size|size\s+of|how\s+many)\b[^?.]{0,60}?\b(?:folder|folders|directory|directories|file|files|disk|drive|desktop|downloads|documents|storage|space|memory|ram|project|projects|repo|repository|workspace|branch|branches|commit|commits|dependency|dependencies|package|packages)\b/i,
  /\b(?:storage|disk|drive|memory)\b[^?.]{0,40}?\b(?:remaining|left|free|available|used|full)\b/i,
  /\b(?:remaining|free|available)\s+(?:storage|space|disk|memory|room)\b/i,
  /* The working tree's own state. "tree", "anything" and "uncommitted" are none
     of them machine nouns, so this never reached `STATE_QUESTIONS` behind its
     `MACHINE_NOUNS || PRONOUN_ANYWHERE` guard -- the same way the disk question
     did not. It is the fabrication class exactly: she cannot see a diff. */
  /\b(?:is|are)\s+there\b[^?.]{0,40}?\b(?:uncommitted|unstaged|staged|untracked|dirty|unsaved|pending)\b/i,
  /\b(?:uncommitted|unstaged|untracked|dirty)\b[^?.]{0,30}?\b(?:tree|repo|repository|branch|workspace|project|changes?)\b/i,
  /* A file named the way it is said aloud. See `SPOKEN_FILENAME`. */
  /\b(?:what|which|how|anything)\b[^?.]{0,30}?\bin\b[^?.]{0,15}?[\w-]+\s+dot\s+(?:json|js|jsx|ts|tsx|md|mjs|cjs|yml|yaml|toml|txt|py|sh|lock|env|css|html)\b/i,
];

/**
 * Moving around Teminali OS itself.
 *
 * The operator's list of what the hands are for begins with the project and
 * ends with "running the Teminali OS itself, the editor and other tools and
 * components and actions". None of the verb groups covered navigation: "take me
 * back to" has no verb any of them recognise, so it stayed in chat.
 *
 * Deliberately narrow. It needs BOTH a movement phrase and a named part of the
 * app, so "take me back to what you were saying" is still a conversation.
 */
const OS_NAVIGATION =
  /\b(?:take\s+me\s+(?:back\s+)?to|switch\s+(?:back\s+)?to|go\s+(?:back\s+)?to|bring\s+up|jump\s+to)\b[^.?!]{0,20}?\b(?:chat|editor|terminal|settings|sidebar|timeline|workspace|panel|panels|tab|window|inbox|files?)\b/i;

function isNegated(text: string, verbIndex: number): boolean {
  const before = text.slice(0, verbIndex);
  if (NEGATOR_BEFORE.test(before)) return true;
  return NON_ACTION_FRAMES.some((frame) => frame.test(before));
}

function hasObjectFor(text: string, verbMatch: RegExpExecArray, kind?: MachineActionKind): boolean {
  const after = text.slice(verbMatch.index + verbMatch[0].length);
  const window = objectWindow(after);
  if (MACHINE_NOUNS.test(window) || SPOKEN_FILENAME.test(window)) return true;
  if (PRONOUN_OBJECT.test(after)) return true;
  /* Widened beyond the look-verbs on 2026-09-12. The operator's own note above
     restricted this to `open`/`inspect` because a list cannot name every noun in
     one codebase and a look is the cheapest thing the hands can do. The reason
     it can now cover the verbs that change things is that the safety argument
     moved: an object must sit inside its verb's own clause (`objectWindow`), a
     negated clause cannot act (`isNegated`), and neither can a hypothetical,
     reported or subordinate one (`NON_ACTION_FRAMES`). Without those, "Refactor
     the voice router so the gate lives in its own module" -- the sentence a
     developer says all day -- stayed in chat, and she described a refactor she
     had never performed. */
  return DEFINITE_OBJECT.test(after);
}

const VERB_GROUPS: { kind: MachineActionKind; verbs: RegExp; reason: string }[] = [
  {
    kind: "media",
    verbs: /\b(play|pause|resume|rewind|fast[- ]?forward|skip|seek|scrub|mute|unmute|replay)\b/i,
    reason: "a playback verb",
  },
  {
    kind: "workspace",
    // The name of the thing sits between the preposition and the noun —
    // "switch to the landing project" — so up to three words are allowed through.
    verbs:
      /\b(switch|change|move|go) (to |into |over to |back to )?(the |my |our )?([\w.\-]+ ){0,3}(workspace|project|repo|repository|codebase)\b/i,
    reason: "a workspace switch",
  },
  {
    kind: "edit",
    verbs:
      /\b(create|make|new|add|write|edit|modify|change|update|rename|move|delete|remove|refactor|replace|fix|implement|generate|scaffold|append|insert)\b/i,
    reason: "a verb that changes something",
  },
  {
    kind: "shell",
    verbs: /\b(run|execute|start|launch|stop|kill|restart|build|compile|install|deploy|test|lint|typecheck|npm|git|bash)\b/i,
    reason: "a verb that runs something",
  },
  {
    kind: "open",
    verbs: /\b(open|show|reveal|display|bring up|pull up|load|go to|navigate to|find|locate|close|hide)\b/i,
    reason: "a verb that puts something on screen",
  },
  {
    kind: "inspect",
    verbs: /\b(read|check|inspect|search|grep|look at|review|analyse|analyze|audit|summarise|summarize|list|diff)\b/i,
    reason: "a verb that examines something",
  },
];

/**
 * Questions about the *state* of something this machine owns.
 *
 * These were the single largest source of fantasising left after the verb gate,
 * and they were measured, not guessed: against qwen3:8b on 2026-09-09, "is the
 * server running" was answered "The server is running" three times out of
 * three, "did the build finish" with "The build is complete" three out of
 * three, and "which port does the config use" with "8080" three out of three.
 * None of it was true, and none of it could have been — the persona has no way
 * to know. A state question is work: the hands can look, the voice cannot.
 *
 * They land on `inspect` rather than on the verb the sentence contains, because
 * "did the build finish" asks for a *look*, not for a build.
 *
 * Pronoun objects are allowed here as they are for imperatives ("is it still
 * running"), which does mean a conversational "is that working for you" is
 * delegated. That is the trade this file already made: a wasted call costs a
 * moment, an invented answer costs trust.
 */
const STATE_QUESTIONS: RegExp[] = [
  /\b(is|are|was|were)\b[^?.]{0,60}?\b(running|up|down|live|passing|failing|green|red|broken|open|finished|done|ready|installed|built|building|compiling|deploying|deployed|working)\b/i,
  /\b(did|has|have|does|do)\b[^?.]{0,60}?\b(finish|finished|start|started|pass|passed|fail|failed|build|built|deploy|deployed|complete|completed|change|changed|break|broke|broken|fix|fixed|land|landed|work|worked)\b/i,
  /\bhow many\b[^?.]{0,60}?\b(tests?|files?|errors?|warnings?|lines?|commits?|changes?|issues?)\b/i,
  /* A quantity the machine holds and she cannot. Measured 2026-09-12, spoken:
     "Can you tell me the total size of all the files on my desktop folder?"
     routed to `converse`, and she answered "Let me see... The total size is 12.4
     gigabytes." The real answer was 38G across 14,474 files. Nothing was
     delegated, nothing was read, and the "let me see" was theatre.

     `how many` was already here; size, space and count-of-things were not, and
     the noun list it keyed on could not see "folder" as a thing with a size.
     This is the costlier direction of the two failures in this file: an agent
     started by mistake is noisy and gets caught, while a fabricated number is
     delivered in her own confident voice and looks exactly like an answer. The
     file's own doctrine settles it -- "a wasted call costs a moment, an
     invented answer costs trust". */
  // "Was that a big change?" — no verb of its own, and none of the adjectives
  // above. The hands hold the diff; the voice answering it is guessing at a
  // number by construction, which is what it did in both repetitions of
  // `evals/voice-conversation.mjs` on 2026-09-12. An opinion frame still outranks
  // this, so "do you think that was a big change" stays a conversation.
  /\b(is|are|was|were)\b[^?.]{0,40}?\b(change|changes|diff|edit|edits|patch|commit|commits)\b/i,
  /\b(?:is|are)\s+there\b[^?.]{0,40}?\b(?:uncommitted|unstaged|staged|untracked|dirty|unsaved|pending)\b|\b(?:uncommitted|unstaged|untracked|dirty)\b[^?.]{0,30}?\b(?:tree|repo|repository|branch|workspace|project|changes?)\b/i,
  /\bwhat(?:'?s| is| are)?\b[^?.]{0,40}?\bin (my|the|this|that) [\w.\-]+/i,
  // The wh-noun pattern used to demand the noun sit directly against the
  // wh-word — "which port", "what branch". §6.30 caught what that misses: "what
  // *is the* port the server runs on" walks straight past it, and she answered
  // "The port is 8080", the exact invention §6.0.4 closed for the shorter
  // phrasing. A gate that only holds for one wording of a question does not
  // hold at all, because nobody is told which wording is the safe one. So the
  // copula and one determiner are allowed to sit in between.
  //
  // `a`/`an` are deliberately not determiners here: "what is a branch" is
  // someone asking what a branch *is*, which the voice may answer, and which
  // the hands would waste a look on.
  //
  // The adjective slot is a closed list for the same reason. Allowing any word
  // there would swallow "what is the best model", which is an opinion and not
  // a fact about this machine; the words below are the ones that only ever
  // point at a state — "the last commit", "the current branch".
  /\b(what|which)(?:['’]?s|\s+(?:is|are|was|were))?\s+(?:(?:the|my|our|your|this|that|these|those)\s+)?(?:(?:last|latest|current|previous|next|first|main|active|open|new|old)\s+)?(files?|folders?|directory|directories|projects?|branch|branches|workspace|versions?|ports?|models?|commands?|scripts?|configs?|servers?|commits?)\b/i,
];

/**
 * Politeness wrappers spoken instructions arrive in. Stripped before the
 * imperative test so "could you please open the config" is read as "open the
 * config" — and so the question mark such a sentence ends with stops mattering.
 */
const POLITE_PREFIX =
  /^(hey |ok |okay |so |now |please |could you |can you |would you |will you |i need you to |i want you to |i'?d like you to |let'?s |lets |go ahead and |why don'?t you |temi,? )+/i;

/**
 * Classify one finished transcript.
 *
 * Returns `null` for conversation — which is the honest answer for most of what
 * is said to a voice companion, and the only answer that should reach the
 * persona LLM.
 */
export function classifyMachineAction(text: string): MachineAction | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;

  // An opinion frame outranks every verb in it. This is the "what do you make
  // of the weather" case, which the old gate delegated to a coding assistant.
  if (OPINION_FRAMES.some((frame) => frame.test(raw))) return null;

  const stripped = raw.replace(POLITE_PREFIX, "").trim();
  if (!stripped) return null;

  // Before everything else, because a number she cannot hold must never be
  // improvised. See `MACHINE_FACT_QUESTIONS`.
  if (MACHINE_FACT_QUESTIONS.some((pattern) => pattern.test(stripped))) {
    return { kind: "inspect", reason: "a fact only the machine holds" };
  }

  if (OS_NAVIGATION.test(stripped)) {
    return { kind: "open", reason: "moving around Teminali OS itself" };
  }

  // Asked before the verb groups: a state question is a look, whatever verb it
  // happens to contain. Its object may be a bare pronoun with nothing to sit
  // behind — see `PRONOUN_ANYWHERE`.
  if (MACHINE_NOUNS.test(stripped) || PRONOUN_ANYWHERE.test(stripped) || SPOKEN_FILENAME.test(stripped)) {
    const state = STATE_QUESTIONS.find((pattern) => pattern.test(stripped));
    if (state) {
      return { kind: "inspect", reason: `a question about machine state — ${state.exec(stripped)?.[0]}` };
    }
  }

  /* An idiom is not compositional, so it is checked whole and before anything
     tries to read a verb and an object out of it. */
  if (NON_ACTION_IDIOMS.test(stripped)) return null;

  /* Whichever verb comes FIRST in the sentence is the one being asked for.
     The groups used to be tried in declaration order, so a later group could
     answer for an earlier verb: "Install the new dependency and re-run the
     build" was classified `edit`, because the edit group's `new` matched "the
     new dependency" while `install` sat at position zero. It still reached the
     hands, but it was announced as "Making the change" for what is an install,
     and `summariseOutcome` is told the wrong kind of thing happened. */
  const ordered = VERB_GROUPS.map((group) => ({ group, match: group.verbs.exec(stripped) }))
    .filter((candidate): candidate is { group: (typeof VERB_GROUPS)[number]; match: RegExpExecArray } => candidate.match !== null)
    .sort((a, b) => a.match.index - b.match.index);

  for (const { group, match } of ordered) {

    // A workspace switch names its own object inside the pattern.
    if (group.kind === "workspace") {
      if (isNegated(stripped, match.index)) continue;
      return { kind: group.kind, reason: `${group.reason} — "${match[0]}"` };
    }

    if (isNegated(stripped, match.index)) continue;
    if (!hasObjectFor(stripped, match, group.kind)) continue;

    return { kind: group.kind, reason: `${group.reason} — "${match[0]}" with an object in range` };
  }

  return null;
}

/**
 * Kept so the router can ask the old question in the old words. The gate is
 * now "is there work here at all", which is what the name always meant.
 */
export function isMachineAction(text: string): boolean {
  return classifyMachineAction(text) !== null;
}

/**
 * What Temi says while the hands work.
 *
 * These are said *instead of* the persona LLM's reply, not alongside it. That
 * reverses an earlier decision (§6.0.2 let the pipeline speak the "on it"),
 * and the reason is the whole point of this module: a persona prompt asked to
 * acknowledge an action it cannot observe will describe the action. Grounded
 * brevity beats charming fiction, and the truthful part — what actually
 * happened — arrives afterwards from the run itself.
 *
 * That second half is a promise, so here is the wire that keeps it, traced end
 * to end 2026-09-10: `voiceTurnRouter` returns `delegate`, `TemiVoiceStage`
 * speaks this line and calls `TeminaliAgentBridge.delegateTask`, whose every
 * exit — success, `catch`, and now a queue refusal — reaches `onCompleted`,
 * which sends `summariseOutcome`'s line back through `sendAssistantDirective`
 * to `server.py` and out of her mouth. **Do not soften these phrases on the
 * suspicion that nothing follows.** Something does. What went wrong was what
 * it said when it got there — see `progressNarration.ts` and §6.45.
 *
 * Several per kind so a working session does not hear one sentence on a loop.
 * The choice is seeded by a caller-supplied number rather than `Math.random`,
 * because everything in this lane has to stay testable.
 */
const ACKNOWLEDGEMENTS: Record<MachineActionKind, readonly string[]> = {
  media: ["Playing it now.", "On it — starting playback.", "Rolling."],
  workspace: ["Switching over now.", "Moving you across.", "Changing workspace."],
  open: ["Opening it now.", "Bringing it up.", "Pulling it up for you."],
  edit: ["On it.", "Working on that now.", "Making the change."],
  shell: ["Running it now.", "Starting that.", "On it — kicking it off."],
  inspect: ["Taking a look.", "Checking now.", "Having a look at that."],
};

export function acknowledgeAction(kind: MachineActionKind, seed = 0): string {
  const lines = ACKNOWLEDGEMENTS[kind];
  const index = Math.abs(Math.floor(seed)) % lines.length;
  return lines[index];
}
