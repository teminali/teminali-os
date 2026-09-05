/**
 * Synthesis. Kokoro-82M through kokoro-js, on CPU.
 *
 * Measured on an M4 Pro at int8: 249 ms warm load, 683 ms for a five-word
 * clause, 4.4 s for a forty-word sentence rendered whole. macOS `say` beats it
 * on a short line and loses badly on a long one, because `say` renders the
 * entire file before returning anything. Long text is therefore split on
 * clause boundaries and rendered piece by piece: the same total work, but the
 * first audio is ready in the time it takes to say the first clause.
 * `synthesiseClauses` hands each clause out as it lands, which is what the
 * streaming form of `/speak` sends; `synthesise` is the same loop concatenated.
 */
import { KokoroTTS } from "kokoro-js";

export const TTS_MODEL = process.env.TEMINALI_TTS_MODEL || "onnx-community/Kokoro-82M-v1.0-ONNX";
const TTS_DTYPE = process.env.TEMINALI_TTS_DTYPE || "q8";

/** Kokoro's own default. Warm, American, and the closest thing it has to Siri. */
export const DEFAULT_VOICE = process.env.TEMINALI_TTS_VOICE || "af_heart";

/**
 * A clause is the unit of synthesis. Kokoro's own splitter breaks on sentences
 * only, so a single long sentence would render as one 4-second block and give
 * up the latency win entirely.
 *
 * A conjunction opens the next clause rather than being the break itself:
 * until 2026-09-05 the split consumed it, so "I tried, but it failed" was
 * spoken as "I tried, it failed". Two conjunctions in a row ("and then") stay
 * together, because "and" on its own is not a clause anyone would say.
 */
const CONJUNCTION = "(?:and|but|so|because|then|which|while)";
const CLAUSE_BREAK = new RegExp(
  `(?<=[.!?,;:])\\s+|(?<=\\s)(?<!\\b${CONJUNCTION}\\s)(?=${CONJUNCTION}\\s)`,
  "gi",
);
const MAX_CLAUSE_WORDS = 18;

let loading = null;

export function loadTts() {
  if (!loading) {
    loading = KokoroTTS.from_pretrained(TTS_MODEL, { dtype: TTS_DTYPE, device: "cpu" });
  }
  return loading;
}

/** Split text into clauses no longer than `MAX_CLAUSE_WORDS`. */
export function splitClauses(text, maxWords = MAX_CLAUSE_WORDS) {
  const parts = String(text ?? "").split(CLAUSE_BREAK).map((part) => part.trim()).filter(Boolean);
  const clauses = [];
  for (const part of parts) {
    const words = part.split(/\s+/);
    if (words.length <= maxWords) {
      clauses.push(part);
      continue;
    }
    // A clause with no punctuation to break on: cut it on word count rather
    // than hand the model a paragraph.
    for (let start = 0; start < words.length; start += maxWords) {
      clauses.push(words.slice(start, start + maxWords).join(" "));
    }
  }
  return clauses.length ? clauses : [String(text ?? "").trim()].filter(Boolean);
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where each clause sits in the original text, as `[start, end)` character
 * offsets. `splitClauses` trims and re-spaces, so the match tolerates any run
 * of whitespace; a clause that still cannot be placed is assumed to follow the
 * previous one, which keeps the offsets monotonic rather than exact.
 */
export function clauseOffsets(text, clauses) {
  const source = String(text ?? "");
  const offsets = [];
  let cursor = 0;
  for (const clause of clauses) {
    const pattern = new RegExp(clause.split(/\s+/).map(escapeRegExp).join("\\s+"), "g");
    pattern.lastIndex = cursor;
    const match = pattern.exec(source);
    const start = match ? match.index : cursor;
    const end = match ? match.index + match[0].length : Math.min(source.length, cursor + clause.length);
    offsets.push({ start, end });
    cursor = end;
  }
  return offsets;
}

/** The voices this build serves, for `/status`. */
export async function listVoices() {
  const tts = await loadTts();
  const voices = tts.voices ?? {};
  return Object.keys(voices).length ? Object.keys(voices) : [DEFAULT_VOICE];
}

/**
 * Render clause by clause, yielding each one the moment it is ready:
 * `{ clause, start, end, samples, sampleRate }`, with `start`/`end` the
 * clause's character offsets in `text`.
 *
 * `rate` is the studio's pace multiplier, which `speakable.ts#paceFor` has
 * already shaped for the length of the line; it maps straight onto Kokoro's
 * `speed`, clamped to the range the model stays intelligible in.
 *
 * Rendering stops when `signal` aborts. A barge-in must not leave the CPU
 * finishing a sentence nobody will hear.
 */
export async function* synthesiseClauses(text, { voice = DEFAULT_VOICE, rate = 1, signal } = {}) {
  const tts = await loadTts();
  const speed = Math.max(0.5, Math.min(2, Number(rate) || 1));
  const clauses = splitClauses(text);
  if (!clauses.length) throw new Error("Nothing to speak.");
  const offsets = clauseOffsets(text, clauses);

  for (let i = 0; i < clauses.length; i += 1) {
    if (signal?.aborted) return;
    const audio = await tts.generate(clauses[i], { voice, speed });
    yield {
      clause: clauses[i],
      start: offsets[i].start,
      end: offsets[i].end,
      samples: audio.audio,
      sampleRate: audio.sampling_rate ?? 24_000,
    };
  }
}

/** Render text to a single float32 waveform: `synthesiseClauses`, concatenated. */
export async function synthesise(text, options = {}) {
  const rendered = [];
  let sampleRate = 24_000;
  for await (const clause of synthesiseClauses(text, options)) {
    rendered.push(clause.samples);
    sampleRate = clause.sampleRate;
  }

  const total = rendered.reduce((sum, part) => sum + part.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const part of rendered) {
    samples.set(part, offset);
    offset += part.length;
  }
  return { samples, sampleRate };
}
