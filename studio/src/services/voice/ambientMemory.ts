/**
 * What the assistant heard but did not answer.
 *
 * An always-open microphone hears the whole room: the other side of a phone
 * call, someone at the door, a car outside. The addressing gate exists so none
 * of that becomes a turn, and until now `conversation.ts` kept exactly one of
 * them — `lastRejected`, a single slot for undoing a gate mistake. Everything
 * else was discarded the moment the next sentence arrived.
 *
 * This is that slot generalised into a bounded log, so "what did she just say?"
 * and "did you hear that?" have an answer. It costs no extra recognition: the
 * text has already been transcribed by the time the gate rejects it. The only
 * thing that changes is that it is kept for a while instead of dropped.
 *
 * Three properties this must hold, because it is a recording of a room that
 * contains people who did not ask to be recorded:
 *
 *   1. **Bounded.** Entries expire on a wall clock, not on a session. There is
 *      no mode in which this grows all day.
 *   2. **Local.** Nothing here is sent anywhere. The recall answers below are
 *      composed by rules, not by a model, so asking a question about the room
 *      does not ship the room to one.
 *   3. **Forgettable.** `forget()` is one call and the UI must be able to reach
 *      it, because "delete that" has to work immediately and completely.
 */

/** How long an entry stays recallable. */
export const AMBIENT_WINDOW_MS = 10 * 60 * 1000;

/** A hard ceiling, so a loud room cannot grow the log without bound. */
export const AMBIENT_MAX_ENTRIES = 200;

export type AmbientSpeaker = "operator" | "other" | "unknown";

/**
 * `kind` distinguishes words from noises. Speech comes from the recogniser;
 * `sound` comes from the sidecar's AudioSet classifier, which names a car, a
 * knock or a phone in clips that carry no words at all. A build without that
 * classifier produces only `speech`, and the recall answers say so rather than
 * guessing at what a noise was.
 */
export type AmbientKind = "speech" | "sound";

export interface AmbientEntry {
  at: number;
  kind: AmbientKind;
  /** The transcript, or for a sound how it is said out loud ("a car"). */
  text: string;
  speaker: AmbientSpeaker;
  /** 0 to 1, or -1 when the engine gave none. */
  confidence: number;
  /** Why the addressing gate let this pass by, when it was speech. */
  reason?: string;
  /** The raw AudioSet class behind a sound, kept for anything that reasons. */
  label?: string;
}

/** What a recall question is asking for. */
export type AmbientQuery =
  | { kind: "last-speech" }
  | { kind: "last-sound" }
  | { kind: "recent"; withinMs: number }
  | { kind: "forget" };

const RECENT_WINDOW_MS = 60_000;

/**
 * Recall phrasings, in the order they are tested. These are rules rather than
 * a model on purpose: the doctrine on the hot path is rules first, and a
 * question about the room must not be answered by sending the room away.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, AmbientQuery]> = [
  [/\b(forget|delete|wipe|clear)\b.*\b(what you heard|that|everything|the room)\b/i, { kind: "forget" }],
  [/\b(what|who)\b.*\b(did|was)\b.*\b(they|she|he|someone|somebody|that person|the other)\b.*\bsay\b/i, { kind: "last-speech" }],
  [/\bwhat did (?:i|you) (?:just )?(?:miss|not hear)\b/i, { kind: "last-speech" }],
  [/\bwhat (?:was|made) (?:that|the) (?:noise|sound|bang|beep|thud|banging)\b/i, { kind: "last-sound" }],
  [/\bwhat (?:noise|sound) (?:was|did you hear)\b/i, { kind: "last-sound" }],
  // "a", "an" and "the" are here for "did you hear a car?" - the question the
  // classifier exists to answer. Still anchored on "did you hear", so an
  // instruction has to be phrased as one to be mistaken for a recall.
  [/\bdid you (?:just )?hear (?:that|it|something|anything|a|an|the)\b/i, { kind: "recent", withinMs: RECENT_WINDOW_MS }],
  [/\bwhat (?:else )?(?:have you|did you) hear(?:d)?\b/i, { kind: "recent", withinMs: RECENT_WINDOW_MS }],
];

/**
 * Is this turn asking about the room rather than about the work? Returns null
 * for everything else, which is nearly everything: a false positive here would
 * swallow a real instruction, so every pattern names the room explicitly.
 */
export function classifyAmbientQuery(text: string): AmbientQuery | null {
  const line = text.trim();
  if (!line) return null;
  for (const [pattern, query] of PATTERNS) {
    if (pattern.test(line)) return query;
  }
  return null;
}

/** Seconds ago, spoken the way a person would say it. */
function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
}

/** A sound is heard, words are said. Reading both the same way sounds wrong. */
function said(entry: AmbientEntry): string {
  return entry.kind === "sound" ? `I heard ${entry.text}` : `I heard: ${entry.text}`;
}

/**
 * Compose the spoken answer to a recall question, or null when there is
 * nothing to say. Null matters: an assistant that invents an answer about what
 * it overheard is worse than one that says it did not catch anything.
 */
export interface AmbientRecallOptions {
  /**
   * Whether the engine can name sounds at all. It changes what "no" means: a
   * build with no classifier has never listened for a car, and saying "I did
   * not hear one" would be a claim it has no basis for.
   */
  soundLabels?: boolean;
}

export function answerFromAmbient(
  query: AmbientQuery,
  entries: readonly AmbientEntry[],
  now = Date.now(),
  { soundLabels = false }: AmbientRecallOptions = {},
): string | null {
  if (query.kind === "forget") return "Forgotten.";

  const newestFirst = [...entries].sort((a, b) => b.at - a.at);

  if (query.kind === "last-speech") {
    const spoken = newestFirst.find((entry) => entry.kind === "speech" && entry.speaker !== "operator");
    if (!spoken) return null;
    return `${ago(spoken.at, now)} I heard: ${spoken.text}`;
  }

  if (query.kind === "last-sound") {
    const sound = newestFirst.find((entry) => entry.kind === "sound");
    if (sound) return `${ago(sound.at, now)} I heard ${sound.text}.`;
    // Two different noes, and the difference matters. Without a classifier the
    // engine never listened for a sound, so it says what it can do instead of
    // claiming there was nothing; with one, "nothing" is a real observation.
    return soundLabels
      ? "I didn't pick out any sound just then."
      : "I can only make out speech at the moment, not other sounds.";
  }

  const within = newestFirst.filter((entry) => now - entry.at <= query.withinMs);
  if (!within.length) return null;
  if (within.length === 1) return `${ago(within[0].at, now)} ${said(within[0])}`;
  const lines = within.slice(0, 3).map((entry) => `${ago(entry.at, now)}, ${said(entry)}`);
  return `A few things: ${lines.join("; ")}.`;
}

/** A bounded, time-ordered log of what was heard and not answered. */
export class AmbientMemory {
  private entries: AmbientEntry[] = [];
  private readonly windowMs: number;
  private readonly maxEntries: number;

  // Written out rather than declared as constructor parameter properties:
  // these modules are imported as TypeScript directly by `node --test`, and
  // Node's strip-only mode cannot erase that form.
  constructor(windowMs: number = AMBIENT_WINDOW_MS, maxEntries: number = AMBIENT_MAX_ENTRIES) {
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
  }

  remember(entry: Omit<AmbientEntry, "at"> & { at?: number }, now = Date.now()): void {
    const text = entry.text?.trim();
    if (!text) return;
    this.entries.push({ ...entry, text, at: entry.at ?? now });
    this.prune(now);
  }

  /** Everything still inside the retention window, oldest first. */
  all(now = Date.now()): AmbientEntry[] {
    this.prune(now);
    return [...this.entries];
  }

  since(withinMs: number, now = Date.now()): AmbientEntry[] {
    return this.all(now).filter((entry) => now - entry.at <= withinMs);
  }

  /** Substring match over the transcripts, newest first. */
  search(query: string, now = Date.now()): AmbientEntry[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return this.all(now)
      .filter((entry) => entry.text.toLowerCase().includes(needle))
      .reverse();
  }

  answer(query: AmbientQuery, now = Date.now(), options: AmbientRecallOptions = {}): string | null {
    const reply = answerFromAmbient(query, this.all(now), now, options);
    if (query.kind === "forget") this.forget();
    return reply;
  }

  forget(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    if (this.entries.some((entry) => entry.at < cutoff)) {
      this.entries = this.entries.filter((entry) => entry.at >= cutoff);
    }
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }
  }
}
