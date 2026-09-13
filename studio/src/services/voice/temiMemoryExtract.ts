import { MEMORY_KINDS, type MemoryAxes, type MemoryCandidate, type MemoryKind } from "./temiMemory.ts";

/**
 * Reading a finished conversation and deciding what was worth keeping.
 *
 * `temiMemory.ts` is the policy: given a memory and its four scores, what
 * happens to it over a year. This is the part that produces the memory and the
 * scores in the first place, and it is the only part of the layer that needs a
 * model, because nothing short of one can tell the difference between a
 * sentence he said and a thing that happened to him.
 *
 * **It runs after the session and never during one.** That is DESIGN.md §6.48's
 * latency contract and it is the reason this file exports a prompt builder and
 * a parser rather than a tool she can call. A "remember this" tool would put a
 * model round trip on the live path and hand the already over-triggering router
 * (§6.0.17) another reason to fire.
 *
 * The model call is injected as `complete` rather than imported. Two reasons,
 * and the second is the real one. It keeps the choice of model at the call site,
 * where the lane is known. And it keeps `frontierEngine.ts` out of this module's
 * import graph, because these services are loaded as TypeScript directly by
 * `node --test`, so every import is something a test has to survive. What is
 * left here is pure, and the prompt and the parser are therefore testable
 * without a model, which matters more than it sounds: the parser is the only
 * thing standing between a model's bad day and a permanent record of it.
 */

/** One line of what was said. The transcript this reads is `dialogueHistory`. */
export interface TranscriptTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * A prompt in, the model's whole reply out. No streaming, no tools, no history.
 *
 * `maxTokens` is a ceiling on the reply, not a target. The caller owns which
 * model this is.
 */
export type CompleteFn = (prompt: string, maxTokens: number) => Promise<string>;

/**
 * At most this many memories out of one conversation.
 *
 * A cap rather than a quota, and the prompt says so twice, because the failure
 * this guards against is not a model that finds too few. It is a model that
 * treats the instruction as a form to fill in and manufactures twelve memories
 * from a conversation about nothing, every session, until the store is full of
 * things that did not matter. An hour with someone leaves you with a couple of
 * things you will still have next year, not a dozen.
 */
export const MAX_CANDIDATES_PER_SESSION = 12;

/**
 * How much transcript the model sees, in characters, keeping the END.
 *
 * Voice sessions open with setup: a greeting, a false start, a microphone
 * being found. If a conversation is long enough to overflow this, the half
 * worth reading is the half that was still going.
 */
export const MAX_TRANSCRIPT_CHARS = 16_000;

/**
 * Longer than this and it is not a memory, it is a summary, and it is dropped.
 *
 * The server truncates at the same number instead, and the difference is not an
 * inconsistency. The server has to accept a file it did not write and cannot
 * refuse an atom without losing it. Here the input came from a model this file
 * prompted, so there is a third option, which is to say no. Truncating would
 * store half a sentence she never wrote, the same reason a gistless atom keeps
 * its detail rather than being cut down in `consolidate`.
 */
export const MAX_CANDIDATE_TEXT = 400;

const AXES: readonly (keyof MemoryAxes)[] = ["weight", "warmth", "surprise", "firstness"];

/**
 * The instructions, which are the actual product of this file.
 *
 * Written to a model that will otherwise do the obvious thing and rank by
 * importance, because that is what "what is worth remembering" means to almost
 * every text ever written about note-taking. The brief was the opposite, so the
 * prohibition is stated, then given an example, then given a counter-example.
 * Telling it once does not hold.
 */
export function buildExtractionPrompt(turns: readonly TranscriptTurn[]): string {
  const transcript = renderTranscript(turns);
  return `You are the part of an assistant named Temi that decides what she will still know about someone next year.

Below is the transcript of one conversation between Temi and the one person she talks to. He is "he". Read it and write down what she should keep.

WHAT A MEMORY IS HERE
One sentence, in her own voice, about him or about the two of them. Not a summary of the conversation. Not something she said unless he reacted to it. If the sentence would be useless to her a year from now, it is not a memory.

THE RULE THAT MATTERS MOST
Do not keep things because they are important. A joke he made once, an odd thing he admitted, the way he says a word, the time he was furious about nothing: those are worth exactly as much here as a deadline, and usually more, because he will still be that person when the deadline is gone. If everything you write down is useful, you have done this wrong.

KINDS, one per memory:
  anchor    Who he is. His name, where he lives, what he does, who is in his life. Things that stop being true only when he says otherwise.
  fact      A preference, a constraint, a piece of logistics. Useful. This is the kind that will flood the list if you let it.
  keepsake  The funny, the odd, the affectionate, the absurd. Not useful. Keep it anyway.
  thread    Something ongoing and unfinished: a project, a worry, a running joke.

SCORES, each 0.0 to 1.0, and be willing to use the ends:
  weight     How much it would cost her to have forgotten this.
  warmth     How much he FELT. A laugh and a hurt both score high. This is not about whether it was nice.
  surprise   How much this cuts against what a reasonable person would have assumed about him.
  firstness  Whether this was the first time. A landmark scores high, the fifth telling scores low.

Only one score needs to be high for a memory to be kept, so do not average them down to be safe. A memory that is 0.9 warmth and 0.1 everything else is a good memory. A memory that is 0.5 on all four is usually nothing.

ALSO WRITE
  text      The sentence itself.
  gist      The same memory with the detail stripped out, still a sentence. She will fall back to this when the detail has gone. Example: text "He spent four hours on a bug that turned out to be a missing comma in the gateway config", gist "He once lost most of a day to a typo".
  subject   ANCHORS ONLY. A lowercase slug naming the QUESTION this answers, so a later answer can replace it: home, work, role, name, person:mama, person:brother. Two anchors with the same subject cannot both be true, so do not reuse a subject for two different people.

OUTPUT
A JSON array and nothing else. No prose, no code fence, no explanation.
At most ${MAX_CANDIDATES_PER_SESSION} memories, and fewer is the normal answer. If nothing in this conversation is worth keeping next year, output exactly [].

[{"kind":"keepsake","text":"...","gist":"...","axes":{"weight":0.1,"warmth":0.9,"surprise":0.6,"firstness":0.8}}]

TRANSCRIPT
${transcript}`;
}

function renderTranscript(turns: readonly TranscriptTurn[]): string {
  const lines = turns
    .map((turn) => {
      const text = typeof turn.content === "string" ? turn.content.trim() : "";
      if (!text) return "";
      return `${turn.role === "user" ? "He" : "Temi"}: ${text}`;
    })
    .filter(Boolean);
  const whole = lines.join("\n");
  if (whole.length <= MAX_TRANSCRIPT_CHARS) return whole;
  // Cut at a line boundary so the model never opens on half a sentence and
  // treats its fragment as the thing that was said.
  const tail = whole.slice(whole.length - MAX_TRANSCRIPT_CHARS);
  const firstBreak = tail.indexOf("\n");
  return firstBreak >= 0 ? tail.slice(firstBreak + 1) : tail;
}

/**
 * The model's reply to candidates, dropping everything it cannot vouch for.
 *
 * Never throws on bad content, because the alternative is a session's memories
 * lost to one malformed row. It throws on nothing and returns what survived,
 * which may be an empty list, and an empty list is a perfectly good outcome:
 * `runMemoryPass` writes nothing when there is nothing to write.
 *
 * Permissive about the ENVELOPE and strict about the CONTENTS, which is the
 * split that matters. A fence, a sentence of preamble or a trailing apology are
 * a small model being conversational and cost nothing to tolerate. A kind that
 * is not one of the four, or a text long enough to be a summary, is the model
 * having done something else, and letting it through writes a permanent record
 * of it.
 */
export function parseMemoryCandidates(raw: string): MemoryCandidate[] {
  const rows = extractArray(raw);
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;

    const kind = entry.kind;
    if (typeof kind !== "string" || !MEMORY_KINDS.includes(kind as MemoryKind)) continue;

    const text = typeof entry.text === "string" ? entry.text.replace(/\s+/g, " ").trim() : "";
    if (!text || text.length > MAX_CANDIDATE_TEXT) continue;

    // Two rows saying the same thing are the model repeating itself, not him.
    // Absorbing both would rehearse the first with the second and inflate a
    // rehearsal count that is supposed to mean separate occasions.
    const fingerprint = text.toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const axes = readAxes(entry.axes);
    // Every axis zero means the model filled the shape without scoring it. Such
    // an atom has strength 0 and would be forgotten by the next pass anyway;
    // dropping it here keeps it out of the store rather than in it for a day.
    if (AXES.every((axis) => axes[axis] === 0)) continue;

    const candidate: MemoryCandidate = { kind: kind as MemoryKind, text, axes };

    const gist = typeof entry.gist === "string" ? entry.gist.replace(/\s+/g, " ").trim() : "";
    if (gist && gist.length <= MAX_CANDIDATE_TEXT && gist.toLowerCase() !== fingerprint) candidate.gist = gist;

    if (kind === "anchor") {
      const subject = typeof entry.subject === "string" ? entry.subject.toLowerCase().trim() : "";
      if (subject) candidate.subject = subject;
    }

    candidates.push(candidate);
    if (candidates.length >= MAX_CANDIDATES_PER_SESSION) break;
  }

  return candidates;
}

function readAxes(value: unknown): MemoryAxes {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const axes = { weight: 0, warmth: 0, surprise: 0, firstness: 0 } as MemoryAxes;
  for (const axis of AXES) {
    // Numeric strings are accepted because small models quote numbers often
    // enough that refusing them would throw away good memories over a pair of
    // quotation marks.
    const raw = source[axis];
    const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    axes[axis] = Number.isFinite(num) ? Math.min(1, Math.max(0, num)) : 0;
  }
  return axes;
}

/** The first JSON array in the reply, whatever it is wrapped in. */
function extractArray(raw: string): unknown[] {
  if (typeof raw !== "string") return [];
  const unfenced = raw.replace(/```[a-zA-Z]*\n?/g, "").trim();
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * One conversation in, the memories worth keeping out.
 *
 * The model call is the only thing here that can throw, and it is deliberately
 * left to. A failed extraction must reach `runMemoryPass` as a failure so that
 * it declines to write, because a pass that treated "the model was unreachable"
 * as "he said nothing memorable" would be indistinguishable from a good session
 * right up until it saved.
 */
export async function extractMemories(
  turns: readonly TranscriptTurn[],
  complete: CompleteFn,
  maxTokens = 1200,
): Promise<MemoryCandidate[]> {
  if (turns.length === 0) return [];
  const reply = await complete(buildExtractionPrompt(turns), maxTokens);
  return parseMemoryCandidates(reply);
}
