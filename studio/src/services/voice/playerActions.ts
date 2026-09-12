/**
 * "Pause" pauses the video, and almost nothing else does.
 *
 * The media player has had a complete executor since the agent lane was built:
 * `PLAYER_ACTIONS` in `services/playerControl.ts` is twenty actions wide, the
 * pane implements every one of them in `MediaPlayer.runCommand`, and the
 * gateway hands the model a live snapshot to aim them with. The voice lane has
 * never reached any of it. Spoken at a playing video, "pause" was consumed by
 * `turnIntent`'s `STOP_PHRASES` — it cancelled the agent run and left the film
 * rolling — and "skip forward thirty seconds" reached `machineAction`, found no
 * noun it recognised, and was answered in character by a persona that has no
 * hands. The missing piece was never the executor. It was the parse.
 *
 * This is that parse, and it is the FIRST fast path of a spoken turn — ahead of
 * the workspace parse, the editor parse and the router. That position is the
 * whole reason the grammar below refuses far more than it accepts: a false
 * positive here does not merely do the wrong thing, it steals the sentence from
 * every other lane before they are asked.
 *
 * Two guards carry that weight.
 *
 *   1. **The words.** Modelled on `editorActions.ts` and inheriting its
 *      posture: null is the ordinary answer and costs nothing. Bare "stop",
 *      "mute", "next" and "turn it up" are never claimed — each is the plainest
 *      way to say something else to Temi ("cancel the run", "be quiet", "the
 *      next task", "speak louder"), and no wording distinguishes them.
 *   2. **The pane.** `dispatchPlayerCommand` returns false when no player is
 *      mounted, and that false becomes `{ handled: false }` rather than an
 *      apology. So every phrase here is claimed only while a video is actually
 *      on screen, and the same sentence spoken with no player open carries on
 *      down the turn exactly as it did before this file existed.
 *
 * `parsePlayerCommand` is pure and exported separately so the grammar can be
 * tested without a pane; `handleSpokenPlayerCommand` is the half that acts.
 * See `studio/DESIGN.md` §6.
 */
import type { PlayerCommand, PlayerSnapshot } from "../playerControl.ts";
import { PLAYER_LIMITS, clampRate, clampVolume, dispatchPlayerCommand } from "../playerControl.ts";
import { usePlayerStore } from "../../store/playerStore.ts";

/** What the stage gets back. `handled: false` means "not mine — carry on". */
export type SpokenPlayerOutcome = { handled: boolean; reply?: string; action?: string };

/** One parsed sentence: the command to run, and the line she says when it runs. */
export interface SpokenPlayerCommand {
  command: PlayerCommand;
  /** Her confirmation. One short sentence, no markdown. */
  spoken: string;
}

/* ── the refusals, before any pattern runs ───────────────────────────────── */

/**
 * Frames that mean the sentence is ABOUT the action rather than asking for it.
 *
 * The same list `editorActions.ts` and `workspaceActions.ts` reject on, for the
 * same reason, and with the same deliberate omission: "can you" and "could you"
 * are NOT question frames. "Can you pause it" is a request on a voice call.
 */
const NON_ACTION_FRAMES: readonly RegExp[] = [
  /\b(?:do\s*n[o']?t|don't|never|instead\s+of|rather\s+than|no\s+need\s+to)\b/i,
  /\b(?:what\s+if|if\s+i|if\s+you|suppose|imagine|in\s+case)\b/i,
  /\b(?:how\s+(?:do|would|should|can)|what(?:'s|\s+is)\s+the|which|where\s+is|why|did|does|was|were)\b/i,
  /\b(?:should|shall)\s+(?:i|we|it|that|this)\b|\bdo\s+you\s+think\b/i,
  /\b(?:i\s+(?:was|were|had|would|might|used\s+to)|you\s+(?:were|had))\b/i,
];

/**
 * The wrapping a spoken command arrives in.
 *
 * "A bit" and "a little" are in the tail rather than the grammar on purpose:
 * "turn the volume up a bit" and "turn the volume up" are one request, and the
 * step is the player's own (`PLAYER_LIMITS.volumeStep`) either way. There is no
 * spoken quantity of "a bit" to honour, so pretending to read one would only
 * invent a number.
 */
const LEAD_NOISE = /^(?:(?:ok(?:ay)?|alright|right|so|hey|yo|um+|uh+|and|now|temi|hey\s+temi|temi,?)\b[,\s]*)+/i;
const REQUEST_LEAD = /^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|(?:please\s+)?(?:go\s+ahead\s+and\s+)?(?:i\s+(?:want|need)\s+you\s+to\s+)?)/i;
const POLITE_TAIL = /\s*(?:,?\s*(?:please|now|thanks|thank\s+you|for\s+me|will\s+you|would\s+you|ok(?:ay)?|a\s+bit|a\s+little|a\s+touch|a\s+tad))+[.!?]*\s*$/i;

function tidy(text: string): string {
  let said = (text ?? "").trim().toLowerCase();
  said = said.replace(LEAD_NOISE, "");
  said = said.replace(REQUEST_LEAD, "");
  said = said.replace(POLITE_TAIL, "");
  return said.replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
}

/* ── time, as it is actually pronounced ──────────────────────────────────── */

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, half: 0.5, couple: 2, few: 3,
};

const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };

/**
 * One spoken count, or null.
 *
 * Two words are read because a transcript delivers "forty five seconds" as
 * words and "twenty" alone is not what was said. The two-word form also
 * absorbs the word in front of the number — the capture below cannot help
 * swallowing it, so "forward thirty" has to come back as thirty rather than as
 * nothing, or "skip forward thirty seconds" parses to no duration at all.
 */
function numberFrom(raw: string | undefined): number | null {
  if (!raw) return null;
  const word = raw.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(word)) return Number(word);
  const whole = WORD_NUMBERS[word];
  if (whole !== undefined) return whole;
  const parts = word.split(/[\s-]+/);
  if (parts.length !== 2) return null;
  const [first, second] = parts;
  if (second === "of") return WORD_NUMBERS[first] ?? null;
  const tens = TENS[first];
  const unit = WORD_NUMBERS[second];
  if (unit === undefined) return null;
  return tens !== undefined && unit < 10 ? tens + unit : unit;
}

const COUNT = "(\\d+(?:\\.\\d+)?|[a-z]+(?:[\\s-][a-z]+)?)";
const SECONDS = "(?:seconds?|secs?)";
const MINUTES = "(?:minutes?|mins?)";

/**
 * A duration or a timecode, in SECONDS — the unit the player's own executor
 * speaks. (`editorActions.parseSpokenMs` is the same idea in milliseconds for
 * the timeline; the two are deliberately not shared, because a unit conversion
 * hidden inside a shared helper is how a ten second skip becomes ten minutes.)
 *
 * Null rather than a default, always. A missing number read as zero sends the
 * playhead to the head of the film on a sentence that was never about it.
 */
export function parseSpokenSeconds(said: string): number | null {
  const clock = /\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/.exec(said);
  if (clock) {
    const [, first, second, third] = clock;
    return third
      ? Number(first) * 3600 + Number(second) * 60 + Number(third)
      : Number(first) * 60 + Number(second);
  }

  const both = new RegExp(`\\b${COUNT}\\s*${MINUTES}(?:\\s+(?:and\\s+)?${COUNT}\\s*${SECONDS}?)?\\b`).exec(said);
  if (both) {
    const minutes = numberFrom(both[1]);
    if (minutes === null) return null;
    // An unreadable tail contributes nothing rather than voiding the whole
    // duration. The trailing capture is optional-seconds, which is what reads
    // "two minutes thirty" — and which also happily swallows the next word, so
    // "the 5 minute mark" arrives here as five minutes and a word called
    // "mark". Five minutes is what was said, and it is not a guess.
    const seconds = both[2] ? numberFrom(both[2]) : 0;
    return Math.round(minutes * 60 + (seconds ?? 0));
  }

  const secs = new RegExp(`\\b${COUNT}\\s*${SECONDS}\\b`).exec(said);
  if (secs) {
    const value = numberFrom(secs[1]);
    return value === null ? null : Math.round(value);
  }
  return null;
}

/* ── the grammar ─────────────────────────────────────────────────────────── */

/** The nouns that mean the thing on screen. Every loose form below needs one. */
const MEDIA = "(?:video|movie|film|episode|show|music|song|track|audio|sound|playback|player|clip)";

/**
 * Play names the state it wants.
 *
 * `toggle` exists and flips, so "play" while playing would pause. The word
 * means one state and the executor has to be told which.
 */
const PLAY = new RegExp(
  `^(?:(?:hit|press)\\s+)?play$`
  + `|^play\\s+(?:it|this|that|it\\s+back|the\\s+${MEDIA})$`
  + `|^(?:start|resume|continue|keep)\\s+(?:playback|playing)$`
  + `|^resume(?:\\s+(?:it|this|that|playback))?$`
  + `|^un\\s*-?\\s*pause(?:\\s+(?:it|this|that))?$`
  + `|^(?:start|resume)\\s+(?:playing\\s+)?the\\s+${MEDIA}$`, "i");

/**
 * Pause always names its object, except for the bare word itself.
 *
 * "Pause" alone is in `turnIntent`'s `STOP_PHRASES` and reads as cancel-the-run
 * everywhere else in the lane. It is claimed here anyway — and only here —
 * because the pane guard settles it: with a video on screen the word means the
 * video, and with no player mounted this returns `handled: false` and the stop
 * reading survives untouched. That is the one ambiguity this module resolves by
 * context rather than by wording, and it is the bug the whole file exists for.
 */
const PAUSE = new RegExp(
  `^pause$`
  + `|^pause\\s+(?:it|this|that|the\\s+${MEDIA})$`
  + `|^stop\\s+(?:playing|playback)$`
  + `|^stop\\s+the\\s+${MEDIA}$`
  + `|^stop\\s+(?:it|that)\\s+(?:there|here)$`
  + `|^hold\\s+(?:it|the\\s+${MEDIA})\\s+there$`, "i");

const TOGGLE = /^(?:toggle\s+)?play\s*\/?\s*pause$|^toggle\s+(?:playback|the\s+video)$/i;

/**
 * Back to the top.
 *
 * "Restart it" is deliberately absent: the sentence an operator says at a dev
 * server all day is "restart it", and reading that as a rewind would take the
 * film back to zero while the server stayed up. The forms below all name the
 * film or the beginning.
 */
const RESTART = new RegExp(
  `^(?:re)?start\\s+(?:it|this|that|the\\s+${MEDIA}|playback)\\s+over$`
  + `|^restart\\s+(?:the\\s+${MEDIA}|playback)$`
  + `|^(?:play|start|watch|run)\\s+(?:it|this|that|the\\s+${MEDIA})\\s+(?:again\\s+)?from\\s+the\\s+(?:top|start|beginning)$`
  + `|^(?:go\\s+)?back\\s+to\\s+the\\s+(?:start|beginning)$`
  + `|^from\\s+the\\s+(?:top|start|beginning)$`
  + `|^replay\\s+(?:it|this|that|the\\s+${MEDIA})$`
  + `|^play\\s+(?:it|that)\\s+again$`, "i");

/**
 * The next item, which must name what it is the next of.
 *
 * Bare "next" is refused. It is the commonest way to say "the next task" while
 * something is running, and a wrong answer here does not pause anything — it
 * abandons the episode the operator was watching.
 */
const NEXT_ITEM = new RegExp(
  `^(?:(?:play|put\\s+on|skip\\s+to|go\\s+to|jump\\s+to)\\s+)?(?:the\\s+)?next\\s+(?:one|${MEDIA}|item)$`, "i");
const PREVIOUS_ITEM = new RegExp(
  `^(?:(?:play|put\\s+on|skip\\s+to|go\\s+to|jump\\s+to|go\\s+)?back\\s+to\\s+)?(?:the\\s+)?(?:previous|last|prior)\\s+(?:one|${MEDIA}|item)$`
  + `|^(?:(?:play|put\\s+on|skip\\s+to|go\\s+to|jump\\s+to)\\s+)?(?:the\\s+)?(?:previous|prior)\\s+(?:one|${MEDIA}|item)$`, "i");

/** "go to 1:20", "jump to two minutes", "skip forward to the 5 minute mark". */
const SEEK_TO = /^(?:go|jump|skip|move|scrub|seek|take\s+(?:me|it|us)|start)\s+(?:(?:forward|back|backwards?|ahead)\s+)?(?:to|from)\b/i;

/** The verbs a nudge opens with, and the two directions it can carry. */
const NUDGE_LEAD = /^(?:skip|jump|move|go|scrub|step|wind|nudge|fast[-\s]?forward|rewind|forward|back)\b/i;
const BACKWARD = /\b(?:back|backward|backwards|rewind|behind|earlier)\b/i;
const FORWARD = /\b(?:forward|forwards|ahead|later)\b/i;
/**
 * A nudge with no number, which takes the player's own step.
 *
 * "Go back" is NOT on this list, though "skip back" is. Alone it is how an
 * operator asks to return to the panel, the folder or the point in the
 * conversation he came from, and it is the one directional phrase that is more
 * often about navigation than about the film.
 */
const BARE_NUDGE = /^(?:(?:skip|jump|move|step|wind|nudge|scrub)\s+(?:forward|forwards|ahead|back|backward|backwards)|fast[-\s]?forward|rewind)$/i;

/** Volume, which never moves on a pronoun alone. See the header. */
const VOLUME_TO = /\b(?:volume|sound|audio)\b[^.]{0,20}?\bto\s+(\d+(?:\.\d+)?)\s*(?:percent|%)?\s*$/i;
const VOLUME_UP = new RegExp(
  `^(?:turn|crank|bump|put|bring|push)\\s+(?:the\\s+|this\\s+|that\\s+)?(?:volume|sound|audio|music)\\s+(?:up|louder)$`
  + `|^(?:turn|crank|bump|push)\\s+up\\s+(?:the\\s+)?(?:volume|sound|audio|music)$`
  + `|^(?:volume|sound|audio)\\s+up$`
  + `|^(?:make|turn)\\s+(?:it|the\\s+${MEDIA})\\s+louder$`
  + `|^raise\\s+(?:the\\s+)?(?:volume|sound|audio)$`, "i");
const VOLUME_DOWN = new RegExp(
  `^(?:turn|bring|put|drop)\\s+(?:the\\s+|this\\s+|that\\s+)?(?:volume|sound|audio|music)\\s+(?:down|lower)$`
  + `|^(?:turn|bring|drop)\\s+down\\s+(?:the\\s+)?(?:volume|sound|audio|music)$`
  + `|^(?:volume|sound|audio)\\s+down$`
  + `|^(?:make|turn)\\s+(?:it|the\\s+${MEDIA})\\s+(?:quieter|softer)$`
  + `|^lower\\s+(?:the\\s+)?(?:volume|sound|audio)$`, "i");

/**
 * Mute, which may never be spoken bare.
 *
 * "Mute", "mute yourself" and "go mute" are `turnIntent`'s hush phrases: they
 * ask Temi to stop talking, and an operator who says one while a film is on
 * would otherwise silence the film and keep the narration. The noun is the
 * whole of the guard, exactly as it is for the editor's track mutes.
 */
const MUTE = new RegExp(
  `^(?:mute|silence)\\s+(?:it|this|that|the\\s+${MEDIA})$`
  + `|^(?:turn|cut)\\s+(?:the\\s+)?(?:sound|audio|volume)\\s+off$`
  + `|^(?:sound|audio|volume)\\s+off$`, "i");
const UNMUTE = new RegExp(
  `^(?:unmute|un\\s*-?\\s*mute)\\s+(?:it|this|that|the\\s+${MEDIA})$`
  + `|^(?:turn|put)\\s+(?:the\\s+)?(?:sound|audio|volume)\\s+back\\s+on$`
  + `|^(?:turn\\s+)?(?:the\\s+)?(?:sound|audio)\\s+on$`
  + `|^(?:sound|audio|volume)\\s+on$`, "i");

const FULLSCREEN_OFF = /^(?:exit|leave|close|end|quit|stop|get\s+out\s+of|come\s+out\s+of|drop\s+out\s+of)\s+(?:the\s+)?full\s*-?\s*screen$|^full\s*-?\s*screen\s+off$|^(?:go\s+)?back\s+to\s+(?:the\s+)?window(?:ed)?$/i;
const FULLSCREEN_ON = new RegExp(
  `^(?:go\\s+|switch\\s+to\\s+|make\\s+it\\s+|make\\s+this\\s+)?full\\s*-?\\s*screen$`
  + `|^(?:make|put|take|blow)\\s+(?:it|this|that|the\\s+${MEDIA})\\s+(?:up\\s+)?full\\s*-?\\s*screen$`
  + `|^full\\s*-?\\s*screen\\s+(?:it|this|that|the\\s+${MEDIA})$`
  + `|^full\\s*-?\\s*screen\\s+on$`, "i");

/** Playback speed. Every delta form names the film; "speed it up" does not. */
const RATE_TO = /\b(?:at|to)\s+(\d+(?:\.\d+)?)\s*(?:x|times)?\s*speed\b|\bplay\s+(?:it\s+)?at\s+(\d+(?:\.\d+)?)\s*x\b|\b(\d+(?:\.\d+)?)\s*x\s+speed\b|\bspeed\s+to\s+(\d+(?:\.\d+)?)\b/i;
const RATE_NAMED = /^(?:play\s+(?:it\s+)?(?:at|in)\s+)?(double|twice|half|normal|regular|standard|original)\s+speed$/i;
const RATE_FASTER = new RegExp(
  `^(?:play|run|watch)\\s+(?:it|this|that|the\\s+${MEDIA})\\s+faster$`
  + `|^speed\\s+(?:up\\s+the\\s+(?:${MEDIA}|playback)|the\\s+(?:${MEDIA}|playback)\\s+up)$`, "i");
const RATE_SLOWER = new RegExp(
  `^(?:play|run|watch)\\s+(?:it|this|that|the\\s+${MEDIA})\\s+slower$`
  + `|^slow\\s+(?:down\\s+the\\s+(?:${MEDIA}|playback)|the\\s+(?:${MEDIA}|playback)\\s+down)$`, "i");

const SUBTITLES_OFF = /^(?:turn\s+off|hide|disable|kill|drop|get\s+rid\s+of)\s+(?:the\s+)?(?:subtitles|captions|closed\s+captions|subs)$|^(?:subtitles|captions|subs)\s+off$/i;
const SUBTITLES_ON = /^(?:(?:turn|put)\s+on|show(?:\s+me)?|enable|give\s+me)\s+(?:the\s+)?(?:subtitles|captions|closed\s+captions|subs)$|^(?:subtitles|captions|subs)(?:\s+on)?$/i;

/* ── the parse ───────────────────────────────────────────────────────────── */

/**
 * One spoken transport command, or none of them.
 *
 * `snapshot` is what the player is doing right now, and the three commands that
 * are deltas — volume up, volume down, and a speed change — are the only ones
 * that need it. `volume` and `rate` take an ABSOLUTE value at the executor, so
 * without a level to add to there is no command to build, and the honest answer
 * is null rather than a guessed 50%. In the live path the snapshot is present
 * whenever a pane is mounted, which is the only time any of this is claimed.
 */
export function parsePlayerCommand(text: string, snapshot: PlayerSnapshot | null = null): SpokenPlayerCommand | null {
  const said = tidy(text);
  if (!said) return null;
  if (NON_ACTION_FRAMES.some((frame) => frame.test(said))) return null;

  /* transport */
  if (TOGGLE.test(said)) return run({ action: "toggle" }, "Toggling playback.");
  if (RESTART.test(said)) return run({ action: "restart" }, "From the top.");
  if (PLAY.test(said)) return run({ action: "play" }, "Playing.");
  if (PAUSE.test(said)) return run({ action: "pause" }, "Paused.");

  /* the item, before the playhead: "skip to the next one" is not a seek */
  if (NEXT_ITEM.test(said)) return run({ action: "next" }, "Next one.");
  if (PREVIOUS_ITEM.test(said)) return run({ action: "previous" }, "Previous one.");

  /* the playhead */
  if (SEEK_TO.test(said)) {
    const seconds = parseSpokenSeconds(said);
    if (seconds !== null) return run({ action: "seek", value: seconds }, `Jumping to ${spellSeconds(seconds)}.`);
  }
  if (NUDGE_LEAD.test(said)) {
    // `back` is read first: "go back" carries no `forward`, and a sentence with
    // neither direction word must not become forward by default.
    const back = BACKWARD.test(said);
    const forward = !back && FORWARD.test(said);
    if (back || forward) {
      const spoken = parseSpokenSeconds(said);
      const step = spoken ?? (BARE_NUDGE.test(said) ? PLAYER_LIMITS.seekStep : null);
      if (step !== null && step > 0) {
        return back
          ? run({ action: "seek_by", value: -step }, `Back ${spellSeconds(step)}.`)
          : run({ action: "seek_by", value: step }, `Forward ${spellSeconds(step)}.`);
      }
    }
  }

  /* sound */
  const level = VOLUME_TO.exec(said);
  if (level) {
    const raw = Number(level[1]);
    if (Number.isFinite(raw) && raw >= 0 && raw <= 100) {
      const value = clampVolume(raw > 1 ? raw / 100 : raw);
      return run({ action: "volume", value }, `Volume at ${Math.round(value * 100)} percent.`);
    }
  }
  if (VOLUME_UP.test(said) || VOLUME_DOWN.test(said)) {
    if (!snapshot) return null;
    const step = VOLUME_DOWN.test(said) ? -PLAYER_LIMITS.volumeStep : PLAYER_LIMITS.volumeStep;
    const value = clampVolume(snapshot.volume + step);
    return run({ action: "volume", value }, `Volume at ${Math.round(value * 100)} percent.`);
  }
  if (UNMUTE.test(said)) return run({ action: "unmute" }, "Sound back on.");
  if (MUTE.test(said)) return run({ action: "mute" }, "Muted.");

  /* the window */
  if (FULLSCREEN_OFF.test(said)) return run({ action: "fullscreen", value: false }, "Out of fullscreen.");
  if (FULLSCREEN_ON.test(said)) return run({ action: "fullscreen", value: true }, "Fullscreen.");

  /* speed */
  const rate = spokenRate(said);
  if (rate !== null) return run({ action: "rate", value: rate }, `Playing at ${trim(rate)} times speed.`);
  if (RATE_FASTER.test(said) || RATE_SLOWER.test(said)) {
    if (!snapshot) return null;
    const next = clampRate(snapshot.rate + (RATE_SLOWER.test(said) ? -0.25 : 0.25));
    return run({ action: "rate", value: next }, `Playing at ${trim(next)} times speed.`);
  }

  /* subtitles */
  if (SUBTITLES_OFF.test(said)) return run({ action: "subtitles", value: "off" }, "Subtitles off.");
  if (SUBTITLES_ON.test(said)) return run({ action: "subtitles", value: "on" }, "Subtitles on.");

  return null;
}

/** An explicit speed, where the sentence says the number. */
function spokenRate(said: string): number | null {
  const named = RATE_NAMED.exec(said);
  if (named) {
    const word = named[1].toLowerCase();
    if (word === "double" || word === "twice") return 2;
    if (word === "half") return 0.5;
    return 1;
  }
  const explicit = RATE_TO.exec(said);
  if (!explicit) return null;
  const raw = Number(explicit[1] ?? explicit[2] ?? explicit[3] ?? explicit[4]);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const rate = clampRate(raw);
  // A number outside the executor's own range is not silently rounded into it:
  // "play it at ten times speed" is not a request for 3×, it is a misheard
  // sentence, and `clampRate` would hide that.
  return rate === raw ? rate : null;
}

function run(command: PlayerCommand, spoken: string): SpokenPlayerCommand {
  return { command, spoken };
}

function trim(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** A duration said the way a person says it, for the confirmation line. */
export function spellSeconds(seconds: number): string {
  const total = Math.round(Math.abs(seconds));
  if (total < 60) return `${total} second${total === 1 ? "" : "s"}`;
  // Hours, unlike `editorActions.spellMs`, because this lane points at films:
  // "sixty five minutes 30" is a number nobody says about a place in a film.
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) {
    const head = `${hours} hour${hours === 1 ? "" : "s"}`;
    return minutes > 0 ? `${head} ${minutes} minute${minutes === 1 ? "" : "s"}` : head;
  }
  const head = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return rest > 0 ? `${head} ${rest}` : head;
}

/* ── the half that acts ──────────────────────────────────────────────────── */

/**
 * The first fast path of a spoken turn.
 *
 * Returns `{ handled: false }` for anything that is not a transport command AND
 * for everything when no player pane is mounted, so the turn carries on into
 * the workspace parse, the editor parse and the router untouched. Nothing here
 * is awaited: `dispatchPlayerCommand` hands the command straight to the pane's
 * `runCommand`, which is synchronous, and the confirmation is the line she says
 * while the frame changes.
 */
export function handleSpokenPlayerCommand(text: string): SpokenPlayerOutcome {
  let live: PlayerSnapshot | null = null;
  try {
    live = usePlayerStore.getState().live;
  } catch {
    /* No store in this window — treat it as no player, and carry on. */
  }
  const parsed = parsePlayerCommand(text, live);
  if (!parsed) return { handled: false };
  if (!dispatchPlayerCommand(parsed.command)) return { handled: false };
  return { handled: true, reply: parsed.spoken, action: parsed.command.action };
}

/* ── the wake-word exemption ─────────────────────────────────────────────── */

/**
 * The actions a sentence may carry past the self-audio gate without a wake word.
 *
 * While the app itself is audible, `TemiVoiceStage` normally demands the wake
 * word, because the transcript of a film is real speech that no addressing
 * score can tell from an operator's. That bar cost the one turn most needed at
 * a playing video: "pause". It was also asymmetric, since mpv plays out of
 * process, never registers as self-audio, and has always taken a bare "pause".
 *
 * These three close that gap and nothing else does. Every other action stays
 * behind the wake word, so a film can still never seek, mute, delete, open a
 * folder or start a run. The worst a film can now do is pause or resume itself,
 * which is undone by saying the same word again.
 */
const WAKELESS_TRANSPORT: ReadonlySet<PlayerCommand["action"]> = new Set(["pause", "play", "toggle"]);

/**
 * Pure half, so the exemption is testable without a pane.
 *
 * The grammar is not duplicated here: the sentence goes through the same
 * `parsePlayerCommand` that would run it, and only the resulting action is
 * consulted. A phrase list would drift from the parse on the first edit.
 */
export function isWakelessTransport(text: string, snapshot: PlayerSnapshot | null): boolean {
  if (!snapshot) return false;
  const parsed = parsePlayerCommand(text, snapshot);
  return parsed !== null && WAKELESS_TRANSPORT.has(parsed.command.action);
}

/**
 * The half the gate calls. False whenever no player is mounted, so the
 * exemption does not exist while the audible thing is the browser pane or the
 * operator's own footage on the timeline.
 */
export function survivesSelfAudioWithoutWakeWord(text: string): boolean {
  try {
    return isWakelessTransport(text, usePlayerStore.getState().live);
  } catch {
    /* No store in this window — no pane, so no exemption. */
    return false;
  }
}
