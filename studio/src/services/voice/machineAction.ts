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
  /\b(file|files|folder|folders|directory|dir|project|projects|workspace|workspaces|repo|repository|video|clip|movie|track|audio|song|music|playback|player|terminal|command|shell|script|build|tests?|suite|server|app|code|function|component|readme|config|package|branch|commit|log|logs|screen|window|tab|pane|editor|timeline|path|document|note|notes|bug|bugs|error|errors|warning|warnings|issue|issues|crash|regression|feature|dependency|dependencies|import|imports|type|types|deploy|deployment|release|install|migration|pipeline|job|task|port|ports|version|versions|model|models)\b/i;

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
 * Is there an object for this verb? A named thing may sit anywhere in the
 * sentence; a bare pronoun must follow the verb it belongs to.
 */
function hasObjectFor(text: string, verbMatch: RegExpExecArray): boolean {
  if (MACHINE_NOUNS.test(text)) return true;
  return PRONOUN_OBJECT.test(text.slice(verbMatch.index + verbMatch[0].length));
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

  // Asked before the verb groups: a state question is a look, whatever verb it
  // happens to contain. Its object may be a bare pronoun with nothing to sit
  // behind — see `PRONOUN_ANYWHERE`.
  if (MACHINE_NOUNS.test(stripped) || PRONOUN_ANYWHERE.test(stripped)) {
    const state = STATE_QUESTIONS.find((pattern) => pattern.test(stripped));
    if (state) {
      return { kind: "inspect", reason: `a question about machine state — ${state.exec(stripped)?.[0]}` };
    }
  }

  for (const group of VERB_GROUPS) {
    const match = group.verbs.exec(stripped);
    if (!match) continue;

    // A workspace switch names its own object inside the pattern.
    if (group.kind === "workspace") {
      return { kind: group.kind, reason: `${group.reason} — "${match[0]}"` };
    }

    if (!hasObjectFor(stripped, match)) continue;

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
