// The ask contract: how the local lane puts a question to the operator.
//
// The fourth sibling of agentCommands.ts, videoToolCalls.ts and
// playerToolCalls.ts, and shaped like all three — parse an explicit fence,
// execute through an injected capability, hand the model back what actually
// happened. What differs is what "execute" means. The other three act on a
// machine and return a result; this one stops the turn and waits for a person.
//
// It exists because the alternative is guessing. A model that needs one fact
// it cannot measure has three moves: invent it, ask in prose and end the turn,
// or ask and keep the turn open. The first is the failure `parseWorkspaceEdits`
// keeps catching — a path the operator never named. The second is what the
// lane did before this file: the question arrives as the last line of a reply,
// the agent loop ends, and the operator answers into a fresh turn that has lost
// the context the question came from. Only the third keeps the work alive.
//
// Parity note: this is `AskUserQuestion` for a lane that has no such tool.
// Measured in a prior session, Claude Code driven headlessly is offered 40
// tools with `AskUserQuestion` and `ExitPlanMode` both absent — so the CLI
// lanes cannot be given this by wiring, only the local lane can, and the local
// lane is also the one the eval can grade. Hence it goes first.
import type { ToolCall } from "../types";

/**
 * Only an explicit opt-in fence is executed, for the same reason the shell,
 * editor and player runners insist on one: a model routinely prints example
 * JSON as documentation, and treating that as an instruction would stop the
 * turn with a modal because a sentence explained how asking works.
 */
/*
  The tag is `ask` and only `ask`. The negative lookahead is not pedantry: it
  is the one tag in this family that is a prefix of other words, so without it
  ```ask-user and ```askew both parse here and the fallback list below — which
  exists to be more forgiving than this — would never be reached at all.
*/
const ASK_FENCE = /```ask(?![-\w])[^\n]*\n([\s\S]*?)(?:```|$)/g;

/**
 * What a local model writes when it has half-remembered the fence name. The
 * player and editor runners carry the same list for the same reason: a model
 * that has understood the protocol and mistyped the tag has earned its call.
 */
const FALLBACK_FENCE = /```(?:ask-tool|ask_tool|asktool|ask-user|ask_user|ask-question|ask_question|question)[^\n]*\n([\s\S]*?)(?:```|$)/g;

/** One answer the operator can pick. `description` is optional and often absent. */
export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  /** The short chip over the picker — 12 characters, like AskUserQuestion. */
  header: string;
  options: AskOption[];
  multiSelect: boolean;
}

/**
 * Four questions, four options.
 *
 * The ceilings are AskUserQuestion's, and they are not arbitrary: a picker the
 * operator has to scroll is one they answer by picking the first plausible
 * row. The operator asked for "a tree of options and stepped tabs" — the tabs
 * are the questions, so more than four of them is a form, not a question.
 */
export const MAX_ASK_QUESTIONS = 4;
export const MAX_ASK_OPTIONS = 4;
const MIN_ASK_OPTIONS = 2;
/** The chip is a label, not a sentence; longer than this is a header that lies. */
const MAX_HEADER_CHARS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Derives the chip from the question when the model omitted it.
 *
 * It omits it often, and refusing the whole ask over a missing label would
 * trade a working question for a retry. Two or three significant words of the
 * question is what a person would have written anyway.
 */
function deriveHeader(question: string): string {
  const words = question
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !/^(the|and|for|you|your|which|what|how|should|would|want|use|this|that|with|from|are|does|did|can|will)$/i.test(word));
  const chip = (words.slice(0, 2).join(" ") || question.trim().split(/\s+/).slice(0, 2).join(" ") || "Choose").trim();
  return chip.slice(0, MAX_HEADER_CHARS);
}

/**
 * A bare string is a valid option here.
 *
 * `["Postgres", "SQLite"]` is what a 14B model writes when it is thinking
 * about the choice rather than the schema, and the intent is unambiguous.
 * Rejecting it buys a round trip and no safety.
 */
function checkOption(raw: unknown): AskOption | null {
  if (typeof raw === "string") {
    const label = raw.trim();
    return label ? { label } : null;
  }
  if (!isRecord(raw)) return null;
  const label = typeof raw.label === "string" ? raw.label.trim() : typeof raw.name === "string" ? raw.name.trim() : "";
  if (!label) return null;
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  return description ? { label, description } : { label };
}

/** One parsed question, or the sentence explaining why it is not one. */
export interface AskRequest {
  question: AskQuestion;
}

export interface AskRejection {
  raw: unknown;
  reason: string;
}

/**
 * Checks one object from a fence.
 *
 * A rejection is returned rather than thrown and carries a sentence the model
 * can act on — the same choice `checkPlayerCommand` makes, for the same
 * reason: "bad request" tells a model nothing, so it re-emits the identical
 * fence and the operator watches it fail twice.
 */
export function checkAskQuestion(raw: unknown): AskRequest | AskRejection {
  if (!isRecord(raw)) return { raw, reason: "an ask must be a JSON object" };
  // `{"tool":"ask","arguments":{...}}` is the editor fence's shape, and a
  // model that has just used that one writes it here out of habit.
  const body = isRecord(raw.arguments) ? raw.arguments : raw;

  const question = typeof body.question === "string" ? body.question.trim() : typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!question) return { raw, reason: 'an ask needs a "question" — the sentence the operator reads' };

  const rawOptions = Array.isArray(body.options) ? body.options : Array.isArray(body.choices) ? body.choices : null;
  if (!rawOptions) return { raw, reason: `"${question.slice(0, 40)}" has no "options" array — give the operator ${MIN_ASK_OPTIONS}–${MAX_ASK_OPTIONS} choices to pick from` };

  const options: AskOption[] = [];
  for (const item of rawOptions) {
    const option = checkOption(item);
    // Deduplicated by label: a model that repeats an option gives the operator
    // two identical buttons, which reads as a bug in the product.
    if (option && !options.some((seen) => seen.label.toLowerCase() === option.label.toLowerCase())) options.push(option);
    if (options.length === MAX_ASK_OPTIONS) break;
  }
  if (options.length < MIN_ASK_OPTIONS) {
    return { raw, reason: `an ask needs at least ${MIN_ASK_OPTIONS} distinct options; "${question.slice(0, 40)}" has ${options.length}. A question with one answer is not a question — just do it.` };
  }

  const header = typeof body.header === "string" && body.header.trim() ? body.header.trim().slice(0, MAX_HEADER_CHARS) : deriveHeader(question);
  // A local model writes `"multiSelect": "true"` about as often as it writes
  // the boolean, and refusing that is pedantry the operator pays for.
  const wantsMulti = body.multiSelect ?? body.multi_select ?? body.multiple;
  const multiSelect = wantsMulti === true || wantsMulti === "true";

  return { question: { question, header, options, multiSelect } };
}

function toRequests(body: string): (AskRequest | AskRejection)[] {
  const parsed = tryParse(body);
  if (parsed === null) return [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map(checkAskQuestion);
}

function collect(text: string, pattern: RegExp): (AskRequest | AskRejection)[] {
  const out: (AskRequest | AskRejection)[] = [];
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(text)) !== null) out.push(...toRequests(match[1] ?? ""));
  return out;
}

export function parseAskToolCalls(text: string): (AskRequest | AskRejection)[] {
  return collect(text, ASK_FENCE);
}

export function parseFallbackAskToolCalls(text: string): (AskRequest | AskRejection)[] {
  return collect(text, FALLBACK_FENCE);
}

export function hasAskToolCalls(text: string): boolean {
  ASK_FENCE.lastIndex = 0;
  return ASK_FENCE.test(text);
}

export function isAskRejection(item: AskRequest | AskRejection): item is AskRejection {
  return "reason" in item;
}

/** The questions from a parse, capped, with the rejections dropped. */
export function askQuestionsFrom(items: (AskRequest | AskRejection)[]): AskQuestion[] {
  return items.filter((item): item is AskRequest => !isAskRejection(item)).map((item) => item.question).slice(0, MAX_ASK_QUESTIONS);
}

/** What the operator picked for one question. `other` is their own words. */
export interface AskAnswer {
  header: string;
  question: string;
  /** The labels chosen. Empty only when the operator typed their own answer. */
  labels: string[];
  other?: string;
}

export interface AskExecution {
  questions: AskQuestion[];
  answers: AskAnswer[];
  /** False when the operator dismissed the picker or the turn was cancelled. */
  answered: boolean;
  durationMs: number;
}

/**
 * Puts the questions in front of the operator and resolves with what they
 * chose, or null if they dismissed it.
 *
 * Injected, so this runner needs no store import and stays testable — the same
 * contract the editor and player runners have with their executors.
 */
export type AskExecutor = (questions: AskQuestion[]) => Promise<AskAnswer[] | null>;

export interface RunAskToolCallsOptions {
  execute: AskExecutor;
  signal?: AbortSignal;
  onToolCall?: (toolCall: ToolCall) => void;
}

export async function executeAskRequests(
  items: (AskRequest | AskRejection)[],
  options: RunAskToolCallsOptions,
): Promise<AskExecution | null> {
  const questions = askQuestionsFrom(items);
  if (questions.length === 0) return null;
  if (options.signal?.aborted) return null;

  const started = Date.now();
  const call: ToolCall = {
    id: `tool-ask-${started}`,
    // One tool call for the whole fence, not one per question: the operator
    // sees a single picker with tabs, so a single row in the transcript is
    // what actually happened.
    name: "ask",
    arguments: { questions: questions.map((q) => ({ header: q.header, question: q.question, options: q.options.map((o) => o.label) })) },
    status: "running",
  };
  options.onToolCall?.(call);

  try {
    const answers = await options.execute(questions);
    const durationMs = Date.now() - started;
    if (!answers || answers.length === 0) {
      options.onToolCall?.({ ...call, status: "error", result: "The operator dismissed the question." });
      return { questions, answers: [], answered: false, durationMs };
    }
    options.onToolCall?.({ ...call, status: "completed", result: answers.map(describeAnswer).join("; ") });
    return { questions, answers, answered: true, durationMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onToolCall?.({ ...call, status: "error", result: message });
    return { questions, answers: [], answered: false, durationMs: Date.now() - started };
  }
}

export async function runAskToolCalls(text: string, options: RunAskToolCallsOptions): Promise<AskExecution | null> {
  return executeAskRequests(parseAskToolCalls(text), options);
}

function describeAnswer(answer: AskAnswer): string {
  const picked = answer.other ? [...answer.labels, answer.other] : answer.labels;
  return `${answer.header}: ${picked.join(", ") || "no answer"}`;
}

/**
 * Builds the observation the model reads on its next turn.
 *
 * The wording carries the whole point of the tool. A model that asked and was
 * answered has to treat the answer as settled and get on with the work — the
 * failure this replaces is the one where the question is re-asked, or where
 * the turn ends politely with the answer in hand and nothing done with it.
 */
export function buildAskEvidence(execution: AskExecution): string {
  if (!execution.answered) {
    return [
      "The operator dismissed the question without answering.",
      "Do not ask again. Pick the most reasonable default yourself, say in one sentence which one you picked and why, and carry on with the work.",
    ].join("\n\n");
  }
  const lines = execution.answers.map((answer) => {
    const picked = answer.labels.length > 0 ? answer.labels.join(" and ") : "";
    const own = answer.other ? `${picked ? `${picked}; ` : ""}in their own words: "${answer.other}"` : picked;
    return `> ${answer.question}\n# ${own || "no answer"}`;
  });
  return [
    "The operator answered. This is their decision, not a suggestion: it overrides any default you had in mind, "
      + "and it is now settled — do not ask it again this exchange.",
    ...lines,
    "Now do the work they chose, in this same reply.",
  ].join("\n\n");
}

/**
 * The bridge between the agent loop and a human decision.
 *
 * A copy of `createApprovalGate`'s contract, deliberately not a generalisation
 * of it: that gate resolves a verdict and remembers an executable, this one
 * resolves a choice and must never remember anything — an answer to "which
 * database?" in one exchange says nothing about the next. What they do share
 * is the guarantee that matters, and it is the reason both exist: the promise
 * always settles, so a pending question can never stall an agent turn.
 */
export interface AskGate {
  request(questions: AskQuestion[]): Promise<AskAnswer[] | null>;
  settle(answers: AskAnswer[] | null): void;
  cancel(): void;
  pending(): AskQuestion[] | null;
}

export function createAskGate(onPendingChange?: (pending: AskQuestion[] | null) => void): AskGate {
  let resolver: ((answers: AskAnswer[] | null) => void) | null = null;
  let current: AskQuestion[] | null = null;

  const set = (next: AskQuestion[] | null) => {
    current = next;
    onPendingChange?.(next);
  };

  const settle = (answers: AskAnswer[] | null) => {
    const resolve = resolver;
    resolver = null;
    set(null);
    resolve?.(answers);
  };

  return {
    request(questions) {
      if (questions.length === 0) return Promise.resolve(null);
      // A second question while one is outstanding dismisses the first rather
      // than dropping its resolver, which would stall the agent turn.
      if (resolver) settle(null);
      return new Promise<AskAnswer[] | null>((resolve) => {
        resolver = resolve;
        set(questions);
      });
    },
    settle,
    cancel() {
      if (resolver) settle(null);
    },
    pending: () => current,
  };
}
