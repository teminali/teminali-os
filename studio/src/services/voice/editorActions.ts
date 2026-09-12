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
  | "clear_selection";

export type EditorCommand =
  | {
      tool: "timeline_command";
      args: { command: TimelineCommandName; ms?: number; clipId?: string };
      /** What she says when it works. A failure is described from the result. */
      spoken: string;
    }
  | {
      tool: "set_track";
      args: { trackId?: string; index?: number; muted?: boolean; solo?: boolean; volume?: number };
      spoken: string;
    }
  | { tool: "insert_clip"; args: { name?: string; assetId?: string }; spoken: string }
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
const SECONDS = "(?:seconds?|secs?|s)";
const MINUTES = "(?:minutes?|mins?|m)";

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

  const secs = new RegExp(`\\b${COUNT}\\s*${SECONDS}\\b`).exec(said);
  if (secs) {
    const value = numberFrom(secs[1]);
    return value === null ? null : Math.round(value * 1000);
  }
  return null;
}

/* ── transport and edit ──────────────────────────────────────────────────── */

/** Playback, where the word names the state it wants rather than a toggle. */
const PLAY = /^(?:(?:hit|press|start)\s+)?play(?:\s+(?:it|this|that|back|the\s+(?:video|timeline|clip|preview|project)))?$|^(?:start|resume)\s+(?:playback|playing|the\s+(?:video|timeline|preview))$|^resume$/i;
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
const SPLIT_PLAIN = /^(?:make\s+a\s+cut|razor(?:\s+(?:it|this|that|the\s+clip))?|split(?:\s+(?:it|this|that|the\s+clip|the\s+clips?))?)$/i;

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

/** "go to 30 seconds", "jump to 1:20", "take me to two minutes". */
const SEEK = /\b(?:go|jump|skip|move|scrub|seek|take\s+(?:me|it|us)|put\s+(?:it|the\s+play\s*head))\s+(?:to|back\s+to)\b/i;
/** "skip forward five seconds", "back ten seconds", "rewind a bit". */
const NUDGE_FORWARD = /\b(?:forward|ahead|forwards|on)\b/i;
const NUDGE_BACK = /\b(?:back|backward|backwards|rewind|behind)\b/i;
const NUDGE_VERB = /\b(?:skip|jump|nudge|move|go|scrub|step|rewind|wind)\b/i;

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

  /* the playhead */
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

  /* the razor and the bin */
  if (SPLIT_HERE.test(said) || SPLIT_PLAIN.test(said)) return timeline("split", "Cut.");
  if (DELETE_SELECTED.test(said)) return timeline("delete_selected", "Deleted.");
  if (UNDO.test(said)) return timeline("undo", "Undone.");
  if (REDO.test(said)) return timeline("redo", "Redone.");
  if (CLEAR_SELECTION.test(said)) return timeline("clear_selection", "Selection cleared.");

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
  extra: { ms?: number; clipId?: string } = {},
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

  return command.spoken;
}
