/**
 * The voice assistant's own agent, sitting beside the chat agent.
 *
 * While a run is in flight the operator talks *about* it — "why that file?",
 * "what was that command?", "explain that last step". Every one of those used
 * to be handed to the chat, which replaced the very run the question was
 * about: asking what the work was doing destroyed the work.
 *
 * So questions about the run are answered here instead, from the run's own
 * tool calls and prose, by the local model. The chat agent keeps working and
 * never sees the question. The two co-operate rather than compete — the chat
 * does the job, this explains it — and only an actual redirect crosses over.
 *
 * Fast and reliable is the whole design constraint, so:
 *
 *   - `turnIntent.ts` decides *whether* to come here, by rules, in no time at
 *     all. The model is paid for only on a question that survived that gate.
 *   - The prompt is a digest, never the raw run: a tool-call stream is large,
 *     unbounded, and mostly noise, and a local model's window is small.
 *   - Everything is bounded — the digest by `MAX_CALLS`, the answer by
 *     `ANSWER_TIMEOUT_MS` and `MAX_SENTENCES`. A slow or missing model falls
 *     back to `summariseProgress`, which is rules and cannot fail.
 *
 * The wording is not tested against a model; the digest and the fallback are,
 * because those are the parts that decide whether the answer can be right.
 */
import type { RunProgress } from "./progressNarration.ts";
import { summariseProgress, speakablePath } from "./progressNarration.ts";

/** How long to wait for the local model before answering from rules instead. */
export const ANSWER_TIMEOUT_MS = 6000;

/** Tool calls to include, most recent last. Enough to explain "that step". */
export const MAX_CALLS = 12;

/** The answer is spoken, so it is short by construction. */
export const MAX_SENTENCES = 3;

const PATH_KEYS = ["file_path", "filePath", "path", "file", "target", "filename", "directory", "dir"];
const COMMAND_KEYS = ["command", "cmd", "script", "shell"];

function pick(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** One tool call as a line the model can read, with nothing unbounded in it. */
function callLine(call: RunProgress["toolCalls"][number], index: number): string {
  const path = pick(call.arguments ?? {}, PATH_KEYS);
  const command = pick(call.arguments ?? {}, COMMAND_KEYS);
  const what = command ? `\`${command.slice(0, 120)}\`` : path ? path.slice(0, 120) : "";
  const outcome =
    call.status === "error"
      ? " — failed"
      : call.status === "running"
        ? " — still running"
        : "";
  return `${index + 1}. ${call.name}${what ? ` ${what}` : ""}${outcome}`;
}

/**
 * What the run has done, small enough to prepend to a question.
 *
 * Only the tail: an agent run can make hundreds of calls and the operator's
 * "that step" is never the fortieth one back. The prose is trimmed hard for
 * the same reason — it is context for a question, not the answer to it.
 */
export function runDigest(run: RunProgress, now = Date.now()): string {
  const calls = run.toolCalls.slice(-MAX_CALLS);
  const lines = calls.map((call, index) => callLine(call, index));
  const elapsed = Math.max(0, Math.round((now - run.startedAt) / 1000));
  const parts = [`The ${run.engine} agent has been running for ${elapsed} seconds.`];
  if (lines.length > 0) {
    const omitted = run.toolCalls.length - calls.length;
    parts.push(
      `${omitted > 0 ? `Its last ${calls.length} steps (${omitted} earlier ones omitted)` : "Its steps so far"}:\n${lines.join("\n")}`,
    );
  } else {
    parts.push("It has not run any tools yet.");
  }
  const prose = (run.lastText ?? "").trim();
  if (prose) parts.push(`What it last wrote:\n${prose.slice(-600)}`);
  return parts.join("\n\n");
}

/**
 * The prompt that answers a question about the run.
 *
 * It is told to answer only from the digest and to say so when the digest does
 * not contain the answer. A voice answer that invents a filename is worse than
 * one that admits the step is not visible, because the operator cannot see the
 * screen to check it — that is why they asked out loud.
 */
export function explainPrompt(question: string, run: RunProgress, now = Date.now()): string {
  return [
    "You are the voice of a coding assistant. A task is running right now and the operator has asked about it out loud, without stopping it.",
    "",
    runDigest(run, now),
    "",
    `They asked: "${question.trim()}"`,
    "",
    `Answer in at most ${MAX_SENTENCES} short spoken sentences. Use only what is above; if it does not say, reply that you cannot see that part yet. Speak plainly — no markdown, no code blocks, no lists, no file paths read out character by character. Do not offer to do anything; the task is already running.`,
  ].join("\n");
}

/**
 * Trim a model's answer to something speakable.
 *
 * A local model asked for three sentences will sometimes give six, and a
 * spoken answer that runs long is one the operator interrupts — which puts us
 * back where we started.
 */
export function tidyAnswer(text: string): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]/g, "")
    .replace(/^\s*[-–—]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [clean];
  // Each fragment keeps the space that followed the previous full stop, so
  // they are trimmed before joining or the answer comes back double-spaced.
  return sentences
    .slice(0, MAX_SENTENCES)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .join(" ");
}

/** Read a path aloud as a name, not a spelling, wherever one survived. */
export function speakablePaths(text: string): string {
  return text.replace(/[\w./-]*\/[\w./-]+/g, (match) => speakablePath(match));
}

export interface ExplainDeps {
  /** The local completion the host already lends for the addressing tiebreak. */
  complete?: (prompt: string, signal?: AbortSignal) => Promise<string>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Answer a question about the run, never touching the run.
 *
 * Falls back to `summariseProgress` whenever the model is absent, slow, or
 * empty-handed. The fallback is not as good an answer, but it is an answer,
 * and it is the same rules the status intent already trusts.
 */
export async function explainRun(
  question: string,
  run: RunProgress,
  deps: ExplainDeps = {},
): Promise<{ text: string; source: "model" | "rules" }> {
  const now = deps.now?.() ?? Date.now();
  const fallback = () => ({ text: summariseProgress(run, now), source: "rules" as const });
  if (!deps.complete) return fallback();

  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? ANSWER_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const raw = await deps.complete(explainPrompt(question, run, now), controller.signal);
    const tidied = speakablePaths(tidyAnswer(raw ?? ""));
    return tidied ? { text: tidied, source: "model" } : fallback();
  } catch {
    // A timeout, an abort, or a model that is not there. The operator asked a
    // question out loud and is owed something back either way.
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}
