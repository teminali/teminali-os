/**
 * What Temi keeps about him, and what she lets go.
 *
 * She has had no memory across sessions. Inside one conversation the Gemini
 * Live session *is* the history, so she follows everything said; the moment it
 * ends, all of it is gone. This module is the part that survives, and it is
 * deliberately only the policy: what a memory is worth, how it decays, what
 * fades, and what gets evicted when the store is full. Storage, extraction and
 * injection are separate files, because this is the piece that has to be
 * argued about and the only one that can be proved on its own.
 *
 * The brief was specific, and the interesting half of it was a prohibition:
 * bounded, forgetful, but retention must NOT be ranked on importance alone,
 * because "importance can also be about fun things". The goal was stated as
 * "what memories humans will keep".
 *
 * That prohibition is not decoration. Rank by importance and the store
 * converges on a CRM record: his timezone, his stack, his deadlines. Every
 * entry useful, and not one of them being known. The fun things lose every
 * comparison against a deadline because they are not competing on the axis
 * being measured. So the arithmetic here is built so that importance CANNOT
 * win by being merely present; it has to actually be the strongest thing about
 * a memory, the same as any other axis.
 *
 * Five decisions, each of which is a claim about people rather than about code:
 *
 *   1. **Retention is the peak axis, not the sum.** Extremity on one dimension
 *      beats moderation on four. People keep the single funniest thing anyone
 *      ever said to them and forget a hundred mildly notable afternoons.
 *   2. **Kinds hold reserved ground.** Scoring alone is not enough: in a heavy
 *      work month forty genuine high-weight facts arrive and legitimately
 *      outscore the jokes. A reserve means they never get to compete for those
 *      slots at all.
 *   3. **Rehearsal is what makes a memory permanent**, not its score at birth.
 *      Coming back up extends the half-life super-linearly, which is why a
 *      running joke outlives the event that started it.
 *   4. **Detail dies before the memory does.** Below a threshold an atom fades
 *      to its gist rather than being deleted. Half-remembering is the honest
 *      failure mode, and it is the one humans actually have.
 *   5. **Anchors do not decay.** Who he is, who is in his life, what he does.
 *      These leave only by being contradicted, never by arithmetic.
 *
 * Every function here is pure and takes `now`, the same contract `ambientMemory.ts`
 * uses, so the whole policy can be run forward over a simulated year in a test
 * without touching a clock. `evals/temi-memory-retention.mjs` does exactly that,
 * because a claim about what survives is measurable and should not be asserted.
 */

/**
 * `kind` is not a label, it is a claim on space. Each kind holds reserved slots
 * that no other kind may take, which is the structural half of the brief: a
 * flood of useful facts cannot evict the things that were merely wonderful.
 *
 *   anchor    Who he is. Where he lives, what he builds, who is in his life.
 *             Exempt from decay, removed only by contradiction.
 *   fact      Preferences, constraints, logistics. The useful tier, and the one
 *             that would eat the store if it were allowed to.
 *   keepsake  The funny, the odd, the affectionate, the absurd. Worth keeping
 *             precisely because it is not useful.
 *   thread    An ongoing story: a project, a worry, a running joke. Short base
 *             life, because a thread nobody picks back up has ended.
 */
export type MemoryKind = "anchor" | "fact" | "keepsake" | "thread";

export const MEMORY_KINDS: readonly MemoryKind[] = ["anchor", "fact", "keepsake", "thread"];

/**
 * How long an untouched memory of each kind takes to lose half its strength.
 *
 * `keepsake` outliving `fact` three to one is the brief made mechanical, and it
 * is also just true: people remember a joke from a decade ago and forget which
 * timezone you were in last year. If these two numbers are ever reordered so
 * that facts last longer, the policy has quietly become the CRM it was written
 * to avoid.
 */
export const BASE_HALF_LIFE_DAYS: Record<MemoryKind, number> = {
  anchor: Infinity,
  fact: 60,
  keepsake: 180,
  thread: 30,
};

/** The whole store. Small on purpose: a memory you can read is a memory you can trust. */
export const MEMORY_MAX_ATOMS = 320;

/**
 * Slots each kind holds against all comers. These are floors, not caps: a kind
 * may exceed its reserve while there is free space, but it can never be pushed
 * below it by another kind's abundance. They must sum to less than
 * MEMORY_MAX_ATOMS, or there is no shared ground left to compete for.
 */
export const MEMORY_RESERVE: Record<MemoryKind, number> = {
  anchor: 40,
  fact: 80,
  keepsake: 80,
  thread: 40,
};

/** Above this an atom keeps its full text. Below it, the detail goes. */
export const FADE_THRESHOLD = 0.35;

/** Below this it is gone. Between the two it survives as a gist. */
export const FORGET_THRESHOLD = 0.12;

/**
 * How hard rehearsal extends life. At 1.4, a memory brought back up three times
 * has a half-life about 7x its original: not permanent, but long enough that
 * an ordinary running joke stops needing anyone to have judged it important.
 */
export const REHEARSAL_EXPONENT = 1.4;

/** How much the non-peak axes count. Enough to break ties, never enough to win one. */
export const SUPPORT_WEIGHT = 0.25;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The four axes, each 0..1, scored once when the memory is laid down.
 *
 * `warmth` is unsigned on purpose. A laugh and a hurt are both worth keeping and
 * both score high; what matters for retention is that he felt something, not
 * which direction. Scoring valence here would quietly make her an optimist, and
 * a memory that only keeps the good parts is not a memory, it is a brochure.
 */
export interface MemoryAxes {
  /** Utilitarian importance: a deadline, a constraint, a preference worth honouring. */
  weight: number;
  /** Emotional charge, unsigned. How much he felt, not what he felt. */
  warmth: number;
  /** How much this violated what she already knew about him. */
  surprise: number;
  /** Whether this was the first time, and so a landmark rather than a repetition. */
  firstness: number;
}

export interface MemoryAtom {
  id: string;
  kind: MemoryKind;
  /** One sentence, in her own words. The thing she would actually say. */
  text: string;
  /**
   * The same memory with the detail stripped, written at consolidation time
   * because it cannot be reconstructed later. An atom with no gist cannot fade
   * gracefully, so it stays whole until it hits the forget floor instead.
   */
  gist?: string;
  axes: MemoryAxes;
  /** When it was first laid down. */
  bornAt: number;
  /** Last time it was laid down OR brought back up. Decay counts from here. */
  lastTouchedAt: number;
  /** How many separate times it has come back up. The strongest signal there is. */
  rehearsals: number;
  /** True once the detail has been dropped and only the gist remains. */
  faded?: boolean;
}

/**
 * Strength before time is applied: the peak axis, plus a quarter of the mean of
 * the rest as a tiebreak.
 *
 * The shape is the entire argument. A memory that is 0.9 funny and nothing else
 * scores 0.72. A memory that is 0.5 on all four scores 0.50 and loses. Summing
 * the axes instead would reverse that, and reversing it is precisely the failure
 * the brief named: the broadly-notable work fact beating the once-in-years
 * absurd one. People do not keep well-rounded memories. They keep extremes.
 */
export function strength(axes: MemoryAxes): number {
  const values = [axes.weight, axes.warmth, axes.surprise, axes.firstness];
  let peakIndex = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] > values[peakIndex]) peakIndex = i;
  }
  const peak = values[peakIndex];
  // Exactly one instance of the peak is removed, so a memory that is high on two
  // axes still gets credit for the second one through `support`.
  const rest = values.filter((_, i) => i !== peakIndex);
  const support = rest.reduce((a, b) => a + b, 0) / rest.length;
  // Divided rather than clamped: clamping would pile every strong memory onto
  // 1.0 and make the top of the store unrankable, which is where ranking matters
  // most. This maps 0..1 onto 0..1 and keeps the ordering intact.
  return (peak + SUPPORT_WEIGHT * support) / (1 + SUPPORT_WEIGHT);
}

/** Half-life in days, extended super-linearly by every time it came back up. */
export function halfLifeDays(atom: MemoryAtom): number {
  const base = BASE_HALF_LIFE_DAYS[atom.kind];
  if (!Number.isFinite(base)) return Infinity;
  return base * Math.pow(1 + atom.rehearsals, REHEARSAL_EXPONENT);
}

/**
 * What the memory is worth right now: strength decayed by time since it was last
 * touched. Anchors never decay, so they return their strength forever.
 */
export function retention(atom: MemoryAtom, now = Date.now()): number {
  const s = strength(atom.axes);
  const half = halfLifeDays(atom);
  if (!Number.isFinite(half)) return s;
  const ageDays = Math.max(0, now - atom.lastTouchedAt) / DAY_MS;
  return s * Math.pow(2, -ageDays / half);
}

/** Whether an atom still holds its detail, holds only its gist, or is gone. */
export type MemoryStage = "fresh" | "faded" | "gone";

/**
 * Anchors are exempt from time. They are not exempt from capacity: if more than
 * the reserve's worth of them accumulate they still compete, because a store
 * that is all anchors has stopped being a memory and become a form.
 */
export function stageOf(atom: MemoryAtom, now = Date.now()): MemoryStage {
  if (atom.kind === "anchor") return "fresh";
  const r = retention(atom, now);
  if (r >= FADE_THRESHOLD) return "fresh";
  if (r >= FORGET_THRESHOLD) return "faded";
  return "gone";
}

/**
 * Bringing a memory back up re-encodes it, so this is not just a counter bump.
 *
 * Each axis takes the higher of the two readings, because a thing that turned
 * out to be funnier the second time genuinely is funnier. A faded atom comes
 * back whole: recalling something and saying more about it is how a blurred
 * memory gets its detail back, and refusing to restore it here would model
 * human memory as strictly lossy, which it is not.
 */
export function rehearse(atom: MemoryAtom, candidate: Partial<MemoryAtom> | undefined, now = Date.now()): MemoryAtom {
  const axes = candidate?.axes;
  return {
    ...atom,
    text: candidate?.text && candidate.text.length > 0 ? candidate.text : atom.text,
    gist: candidate?.gist ?? atom.gist,
    axes: {
      weight: Math.max(atom.axes.weight, axes?.weight ?? 0),
      warmth: Math.max(atom.axes.warmth, axes?.warmth ?? 0),
      surprise: Math.max(atom.axes.surprise, axes?.surprise ?? 0),
      firstness: Math.max(atom.axes.firstness, axes?.firstness ?? 0),
    },
    lastTouchedAt: now,
    rehearsals: atom.rehearsals + 1,
    faded: false,
  };
}

export interface ConsolidationResult {
  kept: MemoryAtom[];
  /** Atoms that lost their detail this pass, already rewritten to their gist. */
  faded: MemoryAtom[];
  /** Atoms that left the store, either by decay or by losing a slot. */
  forgotten: MemoryAtom[];
}

/**
 * One forgetting pass. Pure, and safe to run as often as you like: it is
 * idempotent for a fixed `now`.
 *
 * Order matters and is not arbitrary. Decay is applied before capacity, so that
 * a full store first sheds what time has already taken, and only then has to
 * make a choice between memories that are all still alive. Doing capacity first
 * would evict a living memory to make room for a dead one.
 */
export function consolidate(atoms: readonly MemoryAtom[], now = Date.now()): ConsolidationResult {
  const faded: MemoryAtom[] = [];
  const forgotten: MemoryAtom[] = [];
  const surviving: MemoryAtom[] = [];

  for (const atom of atoms) {
    const stage = stageOf(atom, now);
    if (stage === "gone") {
      forgotten.push(atom);
      continue;
    }
    if (stage === "faded" && !atom.faded) {
      // An atom with no gist cannot fade gracefully. Rather than truncate its
      // text into nonsense, it keeps its detail and rides on to the forget
      // floor: half a sentence she never wrote is worse than nothing.
      if (atom.gist && atom.gist.length > 0) {
        const dimmed = { ...atom, text: atom.gist, faded: true };
        faded.push(dimmed);
        surviving.push(dimmed);
        continue;
      }
    }
    surviving.push(atom);
  }

  if (surviving.length <= MEMORY_MAX_ATOMS) {
    return { kept: surviving, faded, forgotten };
  }

  // Capacity. Each kind keeps its reserve off the top before anything competes,
  // which is the structural guarantee: a month of forty urgent work facts can
  // fill the shared ground and still not touch a single reserved keepsake slot.
  const byRetention = (a: MemoryAtom, b: MemoryAtom) => retention(b, now) - retention(a, now);
  const protectedAtoms = new Set<MemoryAtom>();
  for (const kind of MEMORY_KINDS) {
    const ofKind = surviving.filter((a) => a.kind === kind).sort(byRetention);
    for (const atom of ofKind.slice(0, MEMORY_RESERVE[kind])) protectedAtoms.add(atom);
  }

  const contested = surviving.filter((a) => !protectedAtoms.has(a)).sort(byRetention);
  const freeSlots = Math.max(0, MEMORY_MAX_ATOMS - protectedAtoms.size);
  const winners = new Set(contested.slice(0, freeSlots));
  for (const atom of contested.slice(freeSlots)) forgotten.push(atom);

  const kept = surviving.filter((a) => protectedAtoms.has(a) || winners.has(a));
  return { kept, faded, forgotten };
}

export interface RecallOptions {
  /** How many characters of memory the persona can afford. */
  budgetChars: number;
  /**
   * Strongest memories by retention, allotted per kind rather than pooled.
   *
   * Pooling them was the first implementation and the retention eval caught it:
   * keepsakes outrank facts by construction here, so a single ranked list handed
   * her thirteen jokes and four facts to walk in with. Being known is the point,
   * but a woman who remembers every absurd thing he ever said and not his
   * deadline is not being known, she is being charming at him. This is D2
   * applied to recall: the useful tier holds ground here exactly as the fond one
   * holds ground in the store.
   */
  topPerKind: Record<Exclude<MemoryKind, "anchor">, number>;
  /** Most recently touched, so she is current as well as fond. */
  recentCount: number;
  /** Old things surfaced for no reason. See below. */
  wanderCount: number;
  /** Injectable so the wander is deterministic under test. */
  random?: () => number;
}

export const DEFAULT_RECALL: RecallOptions = {
  budgetChars: 1400,
  topPerKind: { fact: 6, keepsake: 4, thread: 3 },
  recentCount: 4,
  wanderCount: 1,
};

/**
 * What she walks into the conversation already holding.
 *
 * Selection is not retention, and conflating them is the easy mistake. The store
 * is what she knows; this is what is on her mind today, and it is a much tighter
 * budget. Top-by-retention alone would make her repetitive, always opening with
 * the same dozen strongest memories until they were unbearable.
 *
 * Hence the last slot, which is the only genuinely frivolous thing in this file
 * and the one most worth keeping. A `wander` is a weighted-random draw from the
 * entire store: sometimes a person just remembers something old and odd for no
 * reason and says so. It costs one line of budget. It is also, in all likelihood,
 * the single behaviour that will make her feel like she has an interior life,
 * because unprompted recall is the thing nothing else in the system does.
 */
export function selectForRecall(
  atoms: readonly MemoryAtom[],
  now = Date.now(),
  options: Partial<RecallOptions> = {},
): MemoryAtom[] {
  const opts = { ...DEFAULT_RECALL, ...options };
  const rng = opts.random ?? Math.random;
  const chosen: MemoryAtom[] = [];
  const taken = new Set<string>();
  let spent = 0;

  const take = (atom: MemoryAtom | undefined): boolean => {
    if (!atom || taken.has(atom.id)) return false;
    const cost = atom.text.length + 1;
    if (spent + cost > opts.budgetChars) return false;
    chosen.push(atom);
    taken.add(atom.id);
    spent += cost;
    return true;
  };

  // Anchors first and unconditionally: they are the frame every other memory
  // hangs on, and a fond story about someone whose name you have lost is worse
  // than no story.
  for (const atom of atoms.filter((a) => a.kind === "anchor")) take(atom);

  const rest = atoms.filter((a) => a.kind !== "anchor");
  for (const kind of ["fact", "keepsake", "thread"] as const) {
    const strongest = rest
      .filter((a) => a.kind === kind)
      .sort((a, b) => retention(b, now) - retention(a, now));
    for (const atom of strongest.slice(0, opts.topPerKind[kind] ?? 0)) take(atom);
  }

  const recent = [...rest].sort((a, b) => b.lastTouchedAt - a.lastTouchedAt);
  let added = 0;
  for (const atom of recent) {
    if (added >= opts.recentCount) break;
    if (take(atom)) added += 1;
  }

  for (let i = 0; i < opts.wanderCount; i += 1) {
    const pool = rest.filter((a) => !taken.has(a.id));
    if (pool.length === 0) break;
    const weights = pool.map((a) => retention(a, now));
    const total = weights.reduce((x, y) => x + y, 0);
    if (total <= 0) break;
    let ticket = rng() * total;
    let picked = pool[pool.length - 1];
    for (let j = 0; j < pool.length; j += 1) {
      ticket -= weights[j];
      if (ticket <= 0) {
        picked = pool[j];
        break;
      }
    }
    if (!take(picked)) break;
  }

  return chosen;
}
