/**
 * A spoken sentence, turned into one video editor tool call, locally.
 *
 * The editor already has a programmatic surface — `executeTool` in
 * `src/video/mcp/toolRegistry.ts` — and the chat has reached it since P2. The
 * voice lane never has. `voiceTurnRouter` routes an utterance to `converse`,
 * `stop`, `repeat`, `hush`, `mute` or a delegate, and none of those is a tool
 * call, so "cut here" spoken aloud has always arrived as conversation and been
 * answered with a sentence about cutting. This module is the missing half of
 * the link, and the stage is the other half.
 *
 * It is modelled on `workspaceActions.ts` and inherits its posture deliberately:
 * PURE, importless, and written to UNDER-MATCH. Null is the ordinary answer and
 * costs nothing — the turn carries on to `machineAction` and the assistant,
 * which is where every one of these sentences went before this file existed.
 * Acting on a sentence that was not a command costs a great deal more, and the
 * verbs here are worse than the workspace ones: `delete_selected` and `split`
 * destroy work, and `export_project` occupies the machine for minutes.
 *
 * So the grammar below refuses far more than it accepts, and the refusals are
 * specific rather than cautious:
 *
 *   - "cut" and "delete" are ordinary English. `cut` is only a razor when the
 *     sentence also says WHERE ("cut here", "at the playhead"); `delete` only
 *     fires with a timeline noun after it. "Cut to the chase" and "delete that
 *     branch" both fall through, which is correct: the assistant can read them.
 *   - Bare "stop" is never claimed. `voiceTurnRouter` files it as a stop and
 *     cancels the running agent, and that route must keep winning — so pausing
 *     playback has to name the thing being paused.
 *   - Nothing here fires on a question, a negation or a hypothetical. That was
 *     the documented failure of the old voice gate, and the frames are the same
 *     ones `workspaceActions` rejects.
 *   - A command that needs an identifier voice cannot pronounce is simply not
 *     emitted. "Add that clip" needs an asset id; "select that one" needs a clip
 *     id. Both fall through to the assistant, which can look at the pool.
 *
 * It parses, it does not act. The `executeTool` call belongs to the stage, and
 * so does the decision about whether the editor is even open — this file has no
 * way to ask and must not pretend to know.
 *
 * What it reaches, beyond the transport and the razor: captions (the two tools
 * the chat has had since P3 and the timeline never had a spoken route to, and
 * the reason anyone posting cares about this surface at all), the clip verbs a
 * person uses standing at a cut — trim, duplicate, speed, reverse, freeze,
 * detach, close gaps, transitions, a title — the cueing verbs between cuts, and
 * the timeline's own zoom. Every one of them defaults to the selected clip and
 * the playhead, because those are the two things voice can point at.
 */

/* ── what a parse produces ───────────────────────────────────────────────── */

/**
 * The commands `timeline_command` dispatches over.
 *
 * One coarse tool rather than eleven narrow ones, because `TOOL_BUDGET` caps the
 * exposed surface at 15 tools and the timeline store alone declares 106 actions.
 * See the comment above `EXPOSED_TOOLS` in `toolRegistry.ts`: the tool surface is
 * the part of this that costs tokens on every request, so the shape of the
 * mapping is an architectural decision, not a convenience.
 */
export type TimelineCommandName =
  | "play_pause"
  | "play"
  | "pause"
  | "set_playhead"
  | "nudge"
  | "split"
  | "delete_selected"
  | "undo"
  | "redo"
  | "select_clip"
  | "clear_selection"
  /* The clip verbs. Each defaults to the selected clip, because voice
     cannot pronounce a clip id and "this one" is what the operator
     actually says with his eyes on the thing. */
  | "trim_in"
  | "trim_out"
  | "duplicate_clip"
  | "set_speed"
  | "reverse_clip"
  | "freeze_frame"
  | "detach_audio"
  | "close_gaps"
  | "add_transition"
  | "add_text"
  /* Cueing, which is what the operator does between cuts. */
  | "add_marker"
  | "set_in_point"
  | "set_out_point"
  | "clear_in_out"
  /* The view. Harmless, undoable by saying the opposite, and the one
     thing on this list a wrong answer costs nothing at all. */
  | "zoom_in"
  | "zoom_out"
  | "zoom_fit";

/** The transitions an operator can pronounce, as the store spells them. */
export type SpokenTransition =
  | "crossfade"
  | "dip_to_black"
  | "dip_to_white"
  | "whip_pan"
  | "glitch"
  | "flash"
  | "spin"
  | "blur_dissolve";

export type EditorCommand =
  | {
      tool: "timeline_command";
      args: {
        command: TimelineCommandName;
        ms?: number;
        clipId?: string;
        rate?: number;
        text?: string;
        transition?: SpokenTransition;
        position?: "in" | "out";
      };
      /** What she says when it works. A failure is described from the result. */
      spoken: string;
    }
  | {
      tool: "set_track";
      args: { trackId?: string; index?: number; muted?: boolean; solo?: boolean; volume?: number };
      spoken: string;
    }
  | { tool: "insert_clip"; args: { name?: string; assetId?: string }; spoken: string }
  /**
   * Captions, which are the whole point of the surface for anyone posting.
   *
   * Both tools already existed and neither had a spoken route: the chat
   * could caption a cut and the operator standing at the timeline could
   * not. They take no mandatory argument — with nothing passed,
   * `runCaptionWorkflow` reads the caption clips already on the timeline
   * and re-times them, and throws an honest "no captions found" when
   * there are none. So the null-args form is a real command, not a stub.
   */
  | {
      tool: "generate_captions" | "perfect_captions";
      args: { action?: "generate" | "verify" | "perfect" | "all"; offsetMs?: number; text?: string };
      spoken: string;
    }
  | { tool: "export_project"; args: Record<string, never>; spoken: string };

/** What `executeTool` answers with. Repeated rather than imported, see the header. */
export interface EditorToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/* ── the refusals, before any pattern runs ───────────────────────────────── */

/**
 * Frames that mean the sentence is ABOUT the action rather than asking for it.
 *
 * Same list as `workspaceActions.ts`, for the same reason, with one addition:
 * "can you" and "could you" are left OUT of the question frame on purpose.
 * "Can you cut here" is a request on a voice call, not an enquiry, and refusing
 * it would refuse the politest form of every command in this file.
 */
const NON_ACTION_FRAMES: readonly RegExp[] = [
  /\b(?:do\s*n[o']?t|don't|never|instead\s+of|rather\s+than|no\s+need\s+to)\b/i,
  /\b(?:what\s+if|if\s+i|if\s+you|suppose|imagine|in\s+case)\b/i,
  /\b(?:how\s+(?:do|would|should|can)|what(?:'s|\s+is)\s+the|which|where\s+is|why|did|does|was|were)\b/i,
  /\b(?:should|shall)\s+(?:i|we|it|that|this)\b|\bdo\s+you\s+think\b/i,
  /\b(?:i\s+(?:was|were|had|would|might|used\s+to)|you\s+(?:were|had))\b/i,
];

/**
 * Trailing courtesies and lead-in noise, stripped before matching.
 *
 * Spoken commands arrive wrapped: "okay Temi, cut here please". Every pattern
 * below would otherwise need to carry that wrapping itself, and the ones that
 * anchor to end of string — which is most of them, because anchoring is what
 * stops a command matching inside a longer sentence — would simply fail.
 */
const POLITE_TAIL = /\s*(?:,?\s*(?:please|now|thanks|thank\s+you|for\s+me|will\s+you|would\s+you|ok(?:ay)?))+[.!?]*\s*$/i;
const LEAD_NOISE = /^(?:(?:ok(?:ay)?|alright|right|so|hey|yo|um+|uh+|and|temi|hey\s+temi|temi,?)\b[,\s]*)+/i;
const REQUEST_LEAD = /^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|(?:please\s+)?(?:go\s+ahead\s+and\s+)?(?:i\s+(?:want|need)\s+you\s+to\s+)?)/i;

function tidy(text: string): string {
  let said = text.trim().toLowerCase();
  said = said.replace(LEAD_NOISE, "");
  said = said.replace(REQUEST_LEAD, "");
  said = said.replace(POLITE_TAIL, "");
  return said.replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
}

/**
 * The same sentence with its case and its last word intact.
 *
 * `tidy` is right for matching and wrong for QUOTING, and one command
 * here quotes: `add_text` puts the operator's own words on the screen.
 * Tidied, "add a title saying Subscribe now" becomes a title reading
 * "subscribe" — lowercased, and a word short, because "now" is on the
 * courtesy list and half the titles anyone puts on a social cut end with
 * it. Matching still happens against `tidy`; only the argument is taken
 * from here.
 */
function untidied(text: string): string {
  return text
    .trim()
    .replace(LEAD_NOISE, "")
    .replace(REQUEST_LEAD, "")
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ── time, as it is actually pronounced ──────────────────────────────────── */

/**
 * The spoken numbers a transcript still delivers as words.
 *
 * Gemini returns digits for most counts, so this is a short table rather than a
 * number parser: it covers the ones that survive as words ("half a second",
 * "a couple of seconds") and stops. A word this does not know makes the whole
 * command unparseable, which is the right outcome — a duration nobody can read
 * must not become a jump to zero.
 */
const WORD_NUMBERS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, half: 0.5, couple: 2,
};

function numberFrom(raw: string | undefined): number | null {
  if (!raw) return null;
  const word = raw.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(word)) return Number(word);
  const known = WORD_NUMBERS[word];
  return known === undefined ? null : known;
}

const COUNT = "(\\d+(?:\\.\\d+)?|[a-z]+)";
/**
 * The units, where a one-letter abbreviation only ever follows a digit.
 *
 * `s` and `m` used to stand alone, and an English sentence is mostly
 * words that end in one or the other. "Captions" parsed as `caption` + s.
 * "From" parsed as `fro` + m. "Them" as `the` + m. Each match handed
 * `numberFrom` a word that is not a number, which returns null, and null
 * from here means the WHOLE sentence is unreadable — so "nudge the
 * captions forward half a second" carried a perfectly clear duration that
 * no caller could ever see, and so did every seek with the word "from" in
 * it. Nobody says "thirty s"; everybody writes "30s", and that form is
 * kept below where the digit makes it unambiguous.
 */
const SECONDS = "(?:seconds?|secs?)";
const MINUTES = "(?:minutes?|mins?)";

/**
 * A duration or a timecode, in milliseconds.
 *
 * Returns null rather than a default, always. Every caller treats null as "this
 * was not a time command", because the alternative — a missing number read as
 * zero — sends the playhead to the head of the program on a sentence that was
 * never about the playhead.
 */
export function parseSpokenMs(said: string): number | null {
  // "1:20", "01:20:30". The only form where the units are positional.
  const clock = /\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/.exec(said);
  if (clock) {
    const [, first, second, third] = clock;
    return third
      ? (Number(first) * 3600 + Number(second) * 60 + Number(third)) * 1000
      : (Number(first) * 60 + Number(second)) * 1000;
  }

  // "two minutes thirty", "1 minute 5 seconds".
  const both = new RegExp(`\\b${COUNT}\\s*${MINUTES}(?:\\s+(?:and\\s+)?${COUNT}\\s*${SECONDS}?)?\\b`).exec(said);
  if (both) {
    const minutes = numberFrom(both[1]);
    if (minutes === null) return null;
    const seconds = both[2] ? numberFrom(both[2]) : 0;
    if (seconds === null) return null;
    return Math.round((minutes * 60 + seconds) * 1000);
  }

  /*
    "Half a second", "a couple of seconds".

    The table above says it covers these and it did not: the strict form
    below has no room for the filler word, so it skipped "half" and read
    "a second" as one. Tried FIRST, and only kept when the word in front
    of the filler is a number the table knows — otherwise "go back a
    second" would read its `back` instead of its `a`.
  */
  const filled = new RegExp(`\\b${COUNT}\\s+(?:a|of)\\s+${SECONDS}\\b`).exec(said);
  if (filled) {
    const value = numberFrom(filled[1]);
    if (value !== null) return Math.round(value * 1000);
  }

  const secs = new RegExp(`\\b${COUNT}\\s*${SECONDS}\\b`).exec(said);
  if (secs) {
    const value = numberFrom(secs[1]);
    return value === null ? null : Math.round(value * 1000);
  }

  // "30s", "2m" — the written abbreviations, which only a digit may carry.
  const short = /\b(\d+(?:\.\d+)?)\s*([sm])\b/.exec(said);
  if (short) {
    return Math.round(Number(short[1]) * (short[2].toLowerCase() === "m" ? 60000 : 1000));
  }
  return null;
}

/* ── transport and edit ──────────────────────────────────────────────────── */

/**
 * Playback, where the word names the state it wants rather than a toggle.
 *
 * `FROM_HERE` is a tail rather than a separate pattern because "play the
 * timeline from here" is one sentence and the anchors are what keep these
 * from matching inside a longer one. Without it the whole phrase fell
 * through: `play` matched, `the timeline` matched, and `from here` — the
 * part that says the operator is standing at the playhead — hit `$` and
 * failed. It adds nothing to the command; the transport already starts
 * from the playhead. It only has to stop being a refusal.
 */
const FROM_HERE = "(?:\\s+from\\s+(?:here|this\\s+point|the\\s+play\\s*head|where\\s+(?:i|we)\\s+(?:am|are)))?";
const PLAY = new RegExp(
  `^(?:(?:hit|press|start)\\s+)?play(?:\\s+(?:it|this|that|back|the\\s+(?:video|timeline|clip|preview|project)))?${FROM_HERE}$` +
  `|^(?:start|resume)\\s+(?:playback|playing|the\\s+(?:video|timeline|preview))${FROM_HERE}$` +
  `|^resume$`,
  "i",
);
/**
 * Pausing must always name its object.
 *
 * "Stop" on its own belongs to `voiceTurnRouter`, which reads it as a request to
 * cancel the running agent. That reading is the one the operator needs under
 * pressure and it must keep winning, so nothing here may claim the bare word.
 */
const PAUSE = /^pause(?:\s+(?:it|this|that|the\s+(?:video|timeline|clip|preview|playback|project)))?$|^stop\s+(?:the\s+)?(?:playback|playing|the\s+video|video|timeline|preview|it\s+there)$|^hold\s+(?:it|on)\s+there$/i;
const PLAY_PAUSE = /^(?:toggle\s+)?(?:play\s*\/?\s*pause|playback)$/i;

/**
 * The razor, and the reason it needs a place.
 *
 * "Cut" is the most overloaded word an operator says on this lane — cut the
 * scene, cut to black, cut it out, cut the chatter — so `cut` alone is never a
 * razor here. It becomes one when the sentence says where, and "here" is what
 * the operator actually says because the playhead is where he is looking.
 * `split` and `razor` are editing words in almost every context, so they carry
 * themselves with a mere object.
 */
const SPLIT_HERE = /\b(?:cut|split|slice|chop|razor)\b[^.]*\b(?:here|at\s+(?:the\s+)?play\s*head|on\s+(?:the\s+)?play\s*head|at\s+this\s+point)\b/i;
/**
 * The object is `this clip`, not just `this`.
 *
 * "Split this" was accepted and "split this clip" was not — the noun the
 * operator adds when he is looking straight at the thing was the one form
 * the alternation had no branch for. The end anchor is what keeps this
 * safe: "split the work between us" and "split the difference" still find
 * no `$` after the noun and fall through.
 */
const A_CLIP = "(?:it|this|that|(?:the|this|that|these|those)\\s+clips?)";
const SPLIT_PLAIN = new RegExp(`^(?:make\\s+a\\s+cut|(?:razor|split)(?:\\s+${A_CLIP})?)$`, "i");

/**
 * Deletion, which always names what is being deleted.
 *
 * There is no shortage of things the operator asks to be deleted that are not
 * clips — a file, a branch, a line, a take he described a moment ago. The noun
 * is the whole of the guard, and `deleteSelected` acting on the wrong request
 * destroys timeline work that the editor's own undo is the only way back from.
 */
const DELETE_SELECTED = /^(?:delete|remove|get\s+rid\s+of|kill|drop)\s+(?:the\s+|that\s+|this\s+|these\s+|those\s+|it\s+)?(?:selected\s+)?(?:clips?|selection|selected(?:\s+clips?)?)$/i;

const UNDO = /^(?:undo(?:\s+(?:that|it|the\s+last\s+(?:thing|change|edit|one)))?|take\s+that\s+back|revert\s+that)$/i;
const REDO = /^(?:redo(?:\s+(?:that|it))?|put\s+that\s+back|do\s+that\s+again)$/i;
const CLEAR_SELECTION = /^(?:deselect(?:\s+(?:everything|all|it|that))?|clear\s+the\s+selection|select\s+nothing|unselect(?:\s+(?:everything|all))?)$/i;

/**
 * "go to 30 seconds", "jump to 1:20", "move the playhead to ten seconds".
 *
 * The optional group in the middle is the object the operator names, and
 * it is a closed list rather than `[^.]*` on purpose. "Move the playhead
 * to ten seconds" is the sentence a person says out loud and the verb is
 * three words from its `to`; "move the clip to track two" is the sentence
 * that must NOT become a seek, and a wildcard between the two would have
 * taken both.
 */
const SEEK = /\b(?:go|jump|skip|move|scrub|seek|take\s+(?:me|it|us)|put\s+(?:it|the\s+play\s*head))(?:\s+(?:it|us|me|the\s+(?:play\s*head|cursor|position|time)))?\s+(?:to|back\s+to)\b/i;
/** "skip forward five seconds", "back ten seconds", "rewind a bit". */
const NUDGE_FORWARD = /\b(?:forward|ahead|forwards|on)\b/i;
const NUDGE_BACK = /\b(?:back|backward|backwards|rewind|behind)\b/i;
const NUDGE_VERB = /\b(?:skip|jump|nudge|move|go|scrub|step|rewind|wind)\b/i;

/* ── captions ────────────────────────────────────────────────────────────── */

/**
 * A sentence that names the captions is not about the playhead.
 *
 * "Nudge the captions forward half a second" carries `nudge`, `forward`
 * and a readable duration — every part the nudge above needs — and the
 * nudge sits earlier in the parse, so it would take all three and move
 * the program instead of the subtitles. This guard is cheaper and more
 * honest than teaching the nudge what it is not about.
 */
const NAMES_CAPTIONS = /\b(?:captions?|subtitles?|subs)\b/i;
const CAPTIONS = "(?:captions?|subtitles?|subs)";

/**
 * "Caption this."
 *
 * The one editor verb this file exists for more than any other: he is
 * posting, and a cut without captions does not get watched. It takes no
 * argument — with nothing passed, the tool reads whatever caption clips
 * are already on the timeline, re-times and balances them, and says so
 * honestly when there are none. Refusing the bare sentence for want of a
 * transcript would refuse the only form anyone speaks.
 */
const GENERATE_CAPTIONS = new RegExp(
  `^(?:(?:add|generate|create|make|put|build|do)\\s+(?:the\\s+|some\\s+|a\\s+|my\\s+)?${CAPTIONS}` +
  `(?:\\s+(?:on|onto|to|for|over)\\s+(?:this|that|the)(?:\\s+(?:video|timeline|clip|cut|edit))?)?` +
  `|caption\\s+(?:this|it|the\\s+(?:video|timeline|clip|cut)))$`,
  "i",
);

/** "Fix the captions" — the pass that balances lines and closes overlaps. */
const PERFECT_CAPTIONS = new RegExp(
  `^(?:fix|perfect|clean\\s+up|tidy\\s+up|polish|balance|sort\\s+out)\\s+(?:the\\s+|these\\s+|those\\s+|my\\s+)?${CAPTIONS}$`,
  "i",
);

/** "Check the captions" — reads and reports, and writes nothing. */
const VERIFY_CAPTIONS = new RegExp(
  `^(?:check|verify|review|proof(?:read)?)\\s+(?:the\\s+|these\\s+|my\\s+)?${CAPTIONS}$`,
  "i",
);

/**
 * "Shift the captions forward half a second."
 *
 * Direction is spelled out rather than inferred, and it follows the same
 * convention as the nudge one section above: forward is later, back is
 * earlier. A caption sync said the other way round is the failure the
 * operator does not notice until the whole cut is out of step, so a
 * sentence this cannot read a direction and a duration out of is left
 * alone rather than guessed at.
 */
const SHIFT_CAPTIONS = new RegExp(
  `^(?:shift|nudge|move|slide|offset)\\s+(?:the\\s+|my\\s+)?${CAPTIONS}\\s+(forward|forwards|later|back|backwards|earlier)\\b`,
  "i",
);

/* ── the clip under the playhead ─────────────────────────────────────────── */

/** "Here" said the four ways, for the verbs that need a place. */
const HERE = "(?:here|at\\s+(?:the\\s+)?play\\s*head|to\\s+(?:the\\s+)?play\\s*head|at\\s+this\\s+point|on\\s+(?:the\\s+)?play\\s*head)";
const THIS_CLIP = "(?:\\s+(?:of\\s+|from\\s+|on\\s+)?(?:this|that|the)(?:\\s+clip)?)?";

/**
 * Trimming, which must say where it trims to.
 *
 * "Trim the budget", "trim the scope", "trim the intro down" — the word
 * belongs to project talk at least as often as to an edit, and the store
 * CLAMPS a trim point outside the clip rather than refusing it, so a
 * loose match here would not fail loudly, it would quietly resize a clip
 * to the head of the program. The place is the whole of the guard.
 */
const TRIM_HEAD = new RegExp(`^trim\\s+(?:the\\s+)?(?:start|head|front|beginning|top)${THIS_CLIP}\\s+${HERE}$`, "i");
const TRIM_TAIL = new RegExp(`^trim\\s+(?:the\\s+)?(?:end|tail|back|bottom)${THIS_CLIP}\\s+${HERE}$`, "i");

/**
 * Duplicating, where `copy` needs the noun and `duplicate` does not.
 *
 * "Copy that" is radio for "understood" and arrives on this lane about as
 * often as any edit does. `duplicate` and `clone` mean one thing, so they
 * carry a bare object; `copy` has to name the clip.
 */
const DUPLICATE_CLIP = new RegExp(
  `^(?:duplicate(?:\\s+${A_CLIP})?|clone\\s+${A_CLIP}|(?:copy|duplicate)\\s+(?:this|that|the|these|those)\\s+clips?)$`,
  "i",
);

/**
 * A playback rate, and never the other meaning of the word.
 *
 * "Speed this up" is a sentence about hurrying at least as often as about
 * a clip, and it carries no rate — so a rate is mandatory, and the two
 * halves are checked separately: the sentence has to name a number AND be
 * about a clip's speed. "We need to speed up the launch" satisfies
 * neither and falls through to the assistant, which can answer it.
 */
const SPEED_RATE = new RegExp(
  `(?:${COUNT}\\s*(?:x|times)(?:\\s+speed)?|(half|double|twice|quarter|normal)\\s+speed|speed\\s+(?:to\\s+|of\\s+)?(\\d+(?:\\.\\d+)?))$`,
  "i",
);
const SPEED_SUBJECT = /\b(?:speed|(?:make|set|play|run|put)\s+(?:this|that|it)|(?:this|that|the)\s+(?:clip|shot|footage))\b/i;
const NAMED_RATES: Readonly<Record<string, number>> = {
  half: 0.5, double: 2, twice: 2, quarter: 0.25, normal: 1,
};

const REVERSE_CLIP = new RegExp(`^(?:reverse\\s+${A_CLIP}|reverse|play\\s+(?:this|that|it|the\\s+clip)\\s+backwards?)$`, "i");
const FREEZE_FRAME = new RegExp(
  `^(?:freeze(?:\\s+(?:this|that|the))?\\s+frame|hold(?:\\s+(?:this|that|the))?\\s+frame|add\\s+a\\s+freeze\\s+frame|freeze\\s+(?:it|this|that))(?:\\s+${HERE})?$`,
  "i",
);

/**
 * Detaching the audio, which is the first thing done to an interview.
 *
 * `split off the audio` is here rather than with the razor because it is
 * the same word doing an entirely different job, and the razor above only
 * claims `split` when the sentence says a PLACE — which this never does.
 */
const DETACH_AUDIO = new RegExp(
  `^(?:detach|separate|unlink|extract|split\\s+off|pull\\s+off)\\s+(?:the\\s+)?audio${THIS_CLIP}$`,
  "i",
);

/** "Close the gaps." Repacks a whole lane, so it names one. */
const CLOSE_GAPS = /^(?:close|remove|delete|get\s+rid\s+of)\s+(?:the\s+|all\s+(?:the\s+)?|these\s+|those\s+)?gaps(?:\s+(?:on|in)\s+(?:this|that|the)\s+track)?$/i;

/**
 * The transitions, named rather than open.
 *
 * A type the renderer does not know draws nothing and reports success —
 * a transition the operator finds missing at the export — so only the
 * words that map to a real one are accepted, and `fade` is read as a
 * crossfade because that is the thing an editor means by it.
 */
const TRANSITION_WORDS: Readonly<Record<string, SpokenTransition>> = {
  crossfade: "crossfade", "cross fade": "crossfade", dissolve: "crossfade", fade: "crossfade",
  "dip to black": "dip_to_black", "fade to black": "dip_to_black",
  "dip to white": "dip_to_white", "fade to white": "dip_to_white",
  "whip pan": "whip_pan", glitch: "glitch", flash: "flash", spin: "spin",
  "blur dissolve": "blur_dissolve",
};
const TRANSITION_NAME = "(cross\\s?fade|dissolve|dip\\s+to\\s+black|fade\\s+to\\s+black|dip\\s+to\\s+white|fade\\s+to\\s+white|whip\\s+pan|blur\\s+dissolve|glitch|flash|spin|fade)";
/**
 * The name never stands on its own.
 *
 * "Flash", "spin" and "glitch" are things an operator says ABOUT a shot
 * far more often than he asks for one, so the sentence has to carry a
 * verb ("add a flash") or name the clip ("crossfade this clip"). The
 * whole bare-word form is left to the assistant.
 */
const ADD_TRANSITION = new RegExp(
  `^(?:(?:add|put|apply|drop|throw)\\s+(?:an?\\s+|the\\s+)?${TRANSITION_NAME}|${TRANSITION_NAME}\\s+${A_CLIP})` +
  `(?:\\s+(?:on|onto|to|at)\\s+(?:the\\s+)?(in|out|start|end|head|tail|front|back)(?:\\s+of\\s+(?:this|that|the)(?:\\s+clip)?)?)?` +
  `(?:\\s+(?:on|to)\\s+${A_CLIP})?$`,
  "i",
);
/** "Fade this in" — the same tool, with the edge said as a particle. */
const FADE_EDGE = /^fade\s+(?:this|that|it|the\s+clip)?\s*(in|out)$/i;

/**
 * A title, which has to carry its own words.
 *
 * There is no "add a title" form without the text, deliberately: an empty
 * text clip on the timeline looks like a working command and is a blank
 * frame in the export. The sentence says what it says, or it falls
 * through to the assistant, which can ask.
 */
const ADD_TEXT = /^(?:add|put|drop|insert|create|make|write)\s+(?:an?\s+|some\s+)?(?:title|text|lower\s+third|caption\s+card|label|heading)\s+(?:that\s+(?:says|reads)|saying|reading|with\s+the\s+words)\s+["']?(.{1,80}?)["']?$/i;

/* ── cueing ──────────────────────────────────────────────────────────────── */

const ADD_MARKER = new RegExp(
  `^(?:(?:add|drop|put|set|place|leave)\\s+(?:an?\\s+|the\\s+)?(?:marker|flag|chapter(?:\\s+marker)?)|mark\\s+(?:this|it)(?:\\s+(?:spot|moment|point|one))?)` +
  `(?:\\s+(?:${HERE}|down|on\\s+the\\s+timeline))?$`,
  "i",
);
/**
 * In and out, which come before the marker in the parse.
 *
 * "Mark in" and "mark out" are two words away from "mark this", and an in
 * point set as a marker leaves the range the operator was about to export
 * quietly unset.
 */
const SET_IN = new RegExp(`^(?:mark\\s+in|set\\s+(?:the\\s+|an?\\s+)?in(?:\\s+point)?|in\\s+point)(?:\\s+${HERE})?$`, "i");
const SET_OUT = new RegExp(`^(?:mark\\s+out|set\\s+(?:the\\s+|an?\\s+)?out(?:\\s+point)?|out\\s+point)(?:\\s+${HERE})?$`, "i");
const CLEAR_IN_OUT = /^(?:clear|remove|drop|lose)\s+(?:the\s+)?(?:in\s+and\s+out(?:\s+points?)?|in\s*\/\s*out(?:\s+points?)?|in\s+point\s+and\s+(?:the\s+)?out\s+point|range|selection\s+range)$/i;

/* ── the view ────────────────────────────────────────────────────────────── */

/**
 * Zoom, which means the TIMELINE here and nothing else.
 *
 * "Zoom in on her face" is a framing note about the picture and belongs
 * to the assistant; "zoom in" at a timeline is the lane getting wider.
 * The object is a closed list for exactly that reason — the two sentences
 * share their first two words and mean different things.
 */
const ZOOM_FIT = /^(?:zoom\s+to\s+fit|fit\s+(?:the\s+)?(?:whole\s+)?(?:timeline|thing|everything)(?:\s+(?:on|to)\s+(?:the\s+)?screen)?|zoom\s+(?:all\s+the\s+way\s+)?out\s+to\s+fit|show\s+(?:me\s+)?the\s+whole\s+timeline)$/i;
const ZOOM_TAIL = "(?:\\s+(?:a\\s+(?:bit|little)|more|further|on\\s+(?:the\\s+)?(?:timeline|tracks?)))?";
const ZOOM_IN = new RegExp(`^zoom\\s+in${ZOOM_TAIL}$`, "i");
const ZOOM_OUT = new RegExp(`^zoom\\s+(?:back\\s+)?out${ZOOM_TAIL}$`, "i");

/* ── tracks ──────────────────────────────────────────────────────────────── */

const ORDINALS: Readonly<Record<string, number>> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
};

/**
 * Which track, as a 0-based index, or the selected one.
 *
 * "That track" resolves to `"selected"` rather than to a number, because voice
 * cannot pronounce a track id and guessing an index from context is how a mute
 * lands on the wrong stem. The tool refuses `"selected"` with nothing selected,
 * which is the honest answer and the one the operator can act on.
 */
function trackTarget(said: string): { trackId?: string; index?: number } | null {
  const numbered = /\btrack\s+(?:number\s+)?(\d+)\b/i.exec(said);
  if (numbered) {
    const one = Number(numbered[1]);
    return one >= 1 ? { index: one - 1 } : null;
  }
  const ordinal = /\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth)\s+track\b/i.exec(said);
  if (ordinal) return { index: ORDINALS[ordinal[1].toLowerCase()] - 1 };
  if (/\b(?:that|this|the\s+selected|the\s+current|the\s+active)\s+track\b/i.test(said)) return { trackId: "selected" };
  return null;
}

const TRACK_MUTE = /^(?:mute|silence)\b/i;
const TRACK_UNMUTE = /^(?:unmute|un-mute)\b/i;
const TRACK_SOLO = /^solo\b/i;
const TRACK_UNSOLO = /^(?:unsolo|un-solo)\b/i;
/** Volume only with a number in it. "Turn it up" is not a level. */
const TRACK_VOLUME = /\btrack\b[^.]*\b(?:volume|level|gain)\b[^.]*?\b(\d+(?:\.\d+)?)\s*(?:percent|%)?|\bset\s+track\s+(?:number\s+)?\d+\s+to\s+(\d+(?:\.\d+)?)\s*(?:percent|%)/i;

/* ── media and export ────────────────────────────────────────────────────── */

/**
 * "Add the drone shot to the timeline."
 *
 * The name is mandatory and there is no "that clip" form, deliberately. An
 * asset the operator gestured at has an id this lane cannot see, and an insert
 * that picks the wrong file writes it into the program silently. Those
 * sentences fall through to the assistant, which can read the pool.
 */
const INSERT_CLIP = /\b(?:add|insert|drop|put|bring)\s+(?:the|a|an|my|that|this|those|these)?\s*(?:clip\s+(?:called|named)\s+)?["']?([\w.'\- ]{2,60}?)["']?\s+(?:on(?:to)?|in(?:to)?|to)\s+(?:the\s+)?timeline\b/i;

/**
 * Words that are a gesture rather than a name.
 *
 * "Add that clip" points at something this lane cannot see. Left to itself the
 * pattern above happily reads "that clip" AS the name, searches the pool for an
 * asset called that, and either finds nothing or — worse — finds something.
 */
const NOT_A_NAME = /^(?:it|that|this|one|clip|clips|thing|file|media|the|a|an|my|those|these)(?:\s+(?:clip|clips|one|thing|file|media))?$/i;

const EXPORT = /^(?:export|render|output)(?:\s+(?:it|this|that|the\s+(?:video|project|timeline|edit|film|thing)|my\s+(?:video|project|edit)))?$|^(?:export|render)\s+(?:it|this)\s+out$|^(?:let'?s\s+)?(?:export|render)\s+(?:it|this)\s+now$/i;

/* ── the parse ───────────────────────────────────────────────────────────── */

/**
 * One spoken sentence, or none of them.
 *
 * Tried in the order a wrong answer costs least. Transport is harmless and goes
 * first; export is last because it is the one that occupies the machine.
 */
export function parseEditorCommand(text: string): EditorCommand | null {
  const said = tidy(text);
  if (!said) return null;
  if (NON_ACTION_FRAMES.some((frame) => frame.test(said))) return null;

  /* transport */
  if (PLAY_PAUSE.test(said)) return timeline("play_pause", "Toggling playback.");
  if (PLAY.test(said)) return timeline("play", "Playing.");
  if (PAUSE.test(said)) return timeline("pause", "Paused.");

  /* the view, which is the only thing here a wrong answer costs nothing */
  if (ZOOM_FIT.test(said)) return timeline("zoom_fit", "Fitting the timeline.");
  if (ZOOM_IN.test(said)) return timeline("zoom_in", "Zoomed in.");
  if (ZOOM_OUT.test(said)) return timeline("zoom_out", "Zoomed out.");

  /*
   * captions, before the playhead
   *
   * Not by importance, though they are the reason this surface is worth
   * having — by collision. "Nudge the captions forward half a second"
   * carries every word the nudge below needs, and the nudge would take
   * it. `NAMES_CAPTIONS` guards the other direction.
   */
  if (SHIFT_CAPTIONS.test(said)) {
    const shift = SHIFT_CAPTIONS.exec(said);
    const ms = parseSpokenMs(said);
    if (shift && ms !== null && ms > 0) {
      const later = /^(?:forward|forwards|later)$/i.test(shift[1]);
      const offsetMs = later ? ms : -ms;
      return {
        tool: "perfect_captions",
        args: { action: "perfect", offsetMs },
        spoken: `Captions ${later ? "later" : "earlier"} by ${spellMs(ms)}.`,
      };
    }
  }
  if (GENERATE_CAPTIONS.test(said)) {
    return { tool: "generate_captions", args: { action: "generate" }, spoken: "Captioning." };
  }
  if (PERFECT_CAPTIONS.test(said)) {
    return { tool: "perfect_captions", args: { action: "perfect" }, spoken: "Cleaning up the captions." };
  }
  if (VERIFY_CAPTIONS.test(said)) {
    return { tool: "perfect_captions", args: { action: "verify" }, spoken: "Checking the captions." };
  }

  /* the playhead */
  if (!NAMES_CAPTIONS.test(said)) {
    if (SEEK.test(said)) {
      const ms = parseSpokenMs(said);
      if (ms !== null) return timeline("set_playhead", `Moving to ${spellMs(ms)}.`, { ms });
    }
    if (NUDGE_VERB.test(said)) {
      const ms = parseSpokenMs(said);
      if (ms !== null && ms > 0) {
        // `back` is checked first: "skip back forward" is not a sentence, but
        // "go back" carries `back` and no direction word, and must not read as
        // forward merely because `forward` appears nowhere.
        if (NUDGE_BACK.test(said)) return timeline("nudge", `Back ${spellMs(ms)}.`, { ms: -ms });
        if (NUDGE_FORWARD.test(said)) return timeline("nudge", `Forward ${spellMs(ms)}.`, { ms });
      }
    }
  }

  /* the razor and the bin */
  const splitAtMatch = /^(?:cut|split|slice|chop|razor)\s+(?:at\s+)?(.+)$/i.exec(said);
  if (splitAtMatch) {
    const ms = parseSpokenMs(splitAtMatch[1]);
    if (ms !== null) return timeline("split", `Cut at ${spellMs(ms)}.`, { ms });
  }
  if (SPLIT_HERE.test(said) || SPLIT_PLAIN.test(said)) return timeline("split", "Cut.");
  if (DELETE_SELECTED.test(said)) return timeline("delete_selected", "Deleted.");
  if (UNDO.test(said)) return timeline("undo", "Undone.");
  if (REDO.test(said)) return timeline("redo", "Redone.");
  if (CLEAR_SELECTION.test(said)) return timeline("clear_selection", "Selection cleared.");

  /* cueing — in and out before the marker, because "mark in" is not "mark this" */
  if (SET_IN.test(said)) return timeline("set_in_point", "In point set.");
  if (SET_OUT.test(said)) return timeline("set_out_point", "Out point set.");
  if (CLEAR_IN_OUT.test(said)) return timeline("clear_in_out", "Range cleared.");
  if (ADD_MARKER.test(said)) return timeline("add_marker", "Marked.");

  /* the clip under the playhead */
  if (TRIM_HEAD.test(said)) return timeline("trim_in", "Trimmed the head.");
  if (TRIM_TAIL.test(said)) return timeline("trim_out", "Trimmed the tail.");
  if (DUPLICATE_CLIP.test(said)) return timeline("duplicate_clip", "Duplicated.");
  if (DETACH_AUDIO.test(said)) return timeline("detach_audio", "Audio detached.");
  if (REVERSE_CLIP.test(said)) return timeline("reverse_clip", "Reversed.");
  if (FREEZE_FRAME.test(said)) return timeline("freeze_frame", "Frozen.");
  if (CLOSE_GAPS.test(said)) return timeline("close_gaps", "Gaps closed.");

  const speed = SPEED_SUBJECT.test(said) ? SPEED_RATE.exec(said) : null;
  if (speed) {
    const rate = speed[2]
      ? NAMED_RATES[speed[2].toLowerCase()]
      : numberFrom(speed[3] ?? speed[1]);
    // A rate nobody can read must not become a clip played at zero.
    if (rate !== null && rate !== undefined && rate > 0 && rate <= 10) {
      return timeline("set_speed", `${rate}x speed.`, { rate });
    }
  }

  const fade = FADE_EDGE.exec(said);
  if (fade) {
    const position = fade[1].toLowerCase() === "in" ? "in" : "out";
    return timeline("add_transition", `Faded ${position}.`, { transition: "crossfade", position });
  }
  const transition = ADD_TRANSITION.exec(said);
  if (transition) {
    const named = (transition[1] ?? transition[2] ?? "").toLowerCase().replace(/\s+/g, " ");
    const type = TRANSITION_WORDS[named];
    const edge = (transition[3] ?? "").toLowerCase();
    if (type) {
      const position = /^(?:in|start|head|front)$/.test(edge) ? "in" : "out";
      const ms = parseSpokenMs(said);
      return timeline("add_transition", `${named} on the ${position}.`, {
        transition: type,
        position,
        ...(ms !== null && ms > 0 ? { ms } : {}),
      });
    }
  }

  const title = ADD_TEXT.exec(untidied(text));
  if (title) {
    const words = title[1].trim();
    // An empty text clip is a blank frame in the export that looks like a
    // command that worked.
    if (words) return timeline("add_text", `Title: ${words}.`, { text: words });
  }

  /* tracks */
  const track = trackTarget(said);
  if (track) {
    const volume = TRACK_VOLUME.exec(said);
    if (volume) {
      const level = Number(volume[1] ?? volume[2]);
      if (Number.isFinite(level) && level >= 0 && level <= 100) {
        return { tool: "set_track", args: { ...track, volume: level / 100 }, spoken: `Track at ${level} percent.` };
      }
    }
    if (TRACK_UNMUTE.test(said)) return { tool: "set_track", args: { ...track, muted: false }, spoken: "Track unmuted." };
    if (TRACK_MUTE.test(said)) return { tool: "set_track", args: { ...track, muted: true }, spoken: "Track muted." };
    if (TRACK_UNSOLO.test(said)) return { tool: "set_track", args: { ...track, solo: false }, spoken: "Solo off." };
    if (TRACK_SOLO.test(said)) return { tool: "set_track", args: { ...track, solo: true }, spoken: "Soloed." };
  }

  /* the pool */
  const insert = INSERT_CLIP.exec(said);
  if (insert) {
    const name = insert[1].trim();
    if (name && !NOT_A_NAME.test(name)) {
      return { tool: "insert_clip", args: { name }, spoken: `Adding ${name}.` };
    }
  }

  /* the long one */
  if (EXPORT.test(said)) return { tool: "export_project", args: {}, spoken: "Starting the export." };

  return null;
}

function timeline(
  command: TimelineCommandName,
  spoken: string,
  extra: {
    ms?: number;
    clipId?: string;
    rate?: number;
    text?: string;
    transition?: SpokenTransition;
    position?: "in" | "out";
  } = {},
): EditorCommand {
  return { tool: "timeline_command", args: { command, ...extra }, spoken };
}

/** A duration said the way a person says it, for the confirmation line. */
export function spellMs(ms: number): string {
  const total = Math.round(Math.abs(ms) / 1000);
  if (total < 60) return `${total} second${total === 1 ? "" : "s"}`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const head = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return seconds ? `${head} ${seconds}` : head;
}

/* ── what actually happened ──────────────────────────────────────────────── */

/**
 * The one line she says, derived from what the tool DID rather than from what
 * it was asked to do.
 *
 * This function exists because of one specific lie the editor is able to tell.
 * `splitAtPlayhead` returns `{ attempted, cut }`, and with the playhead over
 * nothing both are zero — a razor that cut nothing, reported as a success.
 * Announcing "Cut." there tells the operator an edit happened that did not, and
 * he finds out later, in the export. The same shape applies to
 * `deleteSelected`'s `{ deleted, refused }`.
 *
 * So a successful call is not enough to earn the confirmation line. The result
 * has to show the work.
 */
export function describeEditorResult(command: EditorCommand, result: EditorToolResult): string {
  if (!result.success) {
    const reason = (result.error ?? "").replace(/\s+/g, " ").trim();
    return reason ? `That didn't work: ${reason}` : "That didn't work.";
  }

  const data = (result.data ?? {}) as Record<string, unknown>;

  if (command.tool === "timeline_command" && command.args.command === "split") {
    const cut = Number(data.cut ?? 0);
    if (!cut) return "Nothing under the playhead to cut.";
    return cut === 1 ? "Cut." : `Cut ${cut} clips.`;
  }

  if (command.tool === "timeline_command" && command.args.command === "delete_selected") {
    const deleted = Array.isArray(data.deleted) ? data.deleted.length : Number(data.deleted ?? 0);
    const refused = Array.isArray(data.refused) ? data.refused.length : 0;
    if (!deleted) return refused ? "Nothing was deleted — those clips are locked." : "Nothing was selected.";
    const line = deleted === 1 ? "Deleted." : `Deleted ${deleted} clips.`;
    return refused ? `${line} ${refused} refused.` : line;
  }

  /*
   * Captions, where the count is the only thing worth saying.
   *
   * "Captioning." told the operator a job had started and nothing about
   * what came back. `runCaptionWorkflow` returns how many cues it wrote
   * and whether they reached the timeline, and the difference between
   * those two is the whole failure mode: a perfected set of cues that
   * never landed is a success flag over an unchanged program.
   */
  if (command.tool === "generate_captions" || command.tool === "perfect_captions") {
    const count = Number(data.captionCount ?? 0);
    if (!count) return "No captions were found to work with.";
    const plural = count === 1 ? "caption" : "captions";
    if (command.args.action === "verify") {
      const issues = ((data.verification as Record<string, unknown> | undefined)?.issues ?? []) as unknown[];
      const found = Array.isArray(issues) ? issues.length : 0;
      return found
        ? `${count} ${plural}, ${found} ${found === 1 ? "problem" : "problems"}.`
        : `${count} ${plural}, all clean.`;
    }
    if (data.appliedToTimeline === false) return `${count} ${plural} ready, but none reached the timeline.`;
    return `${count} ${plural} on the timeline.`;
  }

  /*
   * A repack that moved nothing is not a repack, and the zoom stops are
   * the same shape — the store clamps rather than refusing, so the tool
   * reports where it landed and this is where that becomes a sentence.
   */
  if (command.tool === "timeline_command") {
    const note = typeof data.note === "string" ? data.note : "";
    if (data.changed === false && note) return note;
    if (command.args.command === "close_gaps") {
      const gaps = Number(data.gapsClosed ?? 0);
      if (!gaps) return "There were no gaps on that track.";
      return gaps === 1 ? "Closed one gap." : `Closed ${gaps} gaps.`;
    }
  }

  return command.spoken;
}
