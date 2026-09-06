/**
 * How much of a model's context window Teminali is allowed to spend on itself.
 *
 * The measurement that made this necessary: on this machine the local lane runs
 * `frontier-qwen2.5-coder-14b-8k` — an 8,192-token window — and the system
 * prompt alone tokenised at **3,127 tokens, 38% of the window**, before a single
 * message of history, before the operator's own sentence, and before any tool
 * output came back. Asked to drive the player, the model answered in prose and
 * emitted no fence. There was no room left for it to think in.
 *
 * The rule here is a fraction of the window rather than a constant, because a
 * constant is wrong in both directions at once: 4,000 characters of command
 * output is a third of an 8k window and a rounding error in a 200k one. Every
 * limit below is derived from the window the lane actually has.
 *
 * ## The CLI lanes are not governed
 *
 * Claude Code and Codex compact their own context, in their own way, against
 * their own windows. A budget calibrated for a local 8k model would starve a
 * 200k one to protect a small one, and the agent would lose detail its own
 * compactor had decided to keep. So the CLI lanes get the same *shape* of
 * budget — one mechanism, not two — derived from their real window, which
 * leaves every ceiling so far above what a turn produces that it never binds.
 * `governed` says which case a lane is in, so a caller can say so rather than
 * silently truncating something a CLI was relying on.
 */

/** The engines a turn can be routed to. Mirrors `AIService.streamMessage`. */
export type EngineId = "frontier" | "antigravity" | "claude" | "codex";

/**
 * Characters per token, measured — not assumed.
 *
 * 14,475 characters of the real assembled system prompt tokenised to 3,127 by
 * `frontier-qwen2.5-coder-14b-8k` itself: 4.63. Instruction prose is the most
 * favourable case, so the figure used for planning prose is that measurement
 * rounded down.
 */
export const PROSE_CHARS_PER_TOKEN = 4.6;

/**
 * Command output, JSON and source are denser than prose — more punctuation and
 * fewer whole words per token. Budgeting tool results at the prose rate would
 * quietly overspend, so they are planned at a deliberately pessimistic rate.
 */
export const DENSE_CHARS_PER_TOKEN = 3.2;

/**
 * The window a lane has when nothing more specific is known.
 *
 * The local figure is the smallest window any shipped `frontier-*` build pins,
 * so an unknown local model is budgeted as the tightest one rather than the
 * roomiest. The CLI figure is the published window of the models those CLIs
 * run; it is used only to prove the ceilings never bind, never to truncate.
 */
const DEFAULT_WINDOW_TOKENS: Record<EngineId, number> = {
  frontier: 8_192,
  antigravity: 8_192,
  claude: 200_000,
  codex: 200_000,
};

/** Lanes whose context is managed by the agent itself, not by Teminali. */
const SELF_MANAGED: ReadonlySet<EngineId> = new Set<EngineId>(["claude", "codex"]);

/**
 * The share of the window each part of a turn may occupy.
 *
 * They deliberately do not sum to 1. What is left is the room the model needs
 * to reason and answer in; a budget that spends the whole window leaves a model
 * able to read its instructions and unable to act on them, which is exactly the
 * failure this module exists to prevent.
 */
export const SHARES = Object.freeze({
  /**
   * Everything Teminali tells the model about itself and its tools.
   *
   * 25%, not less: with the editor and the player both mounted, the contract
   * sections alone are ~7,900 characters on an 8k window, and the eval showed
   * the next section in rank — the live-data rule — is the one that stops a
   * model refusing "what's the bitcoin price?" At 22% it was dropped.
   */
  systemPrompt: 0.25,
  /** All prior turns kept for this request, together. */
  history: 0.3,
  /** Any single prior message, so one long paste cannot evict the rest. */
  message: 0.12,
  /** What one tool call is allowed to return into the conversation. */
  toolResult: 0.1,
});

export interface ContextBudget {
  engine: EngineId;
  /** The window the limits below were derived from, in tokens. */
  windowTokens: number;
  /** False when the lane compacts its own context and Teminali must not. */
  governed: boolean;
  systemPromptChars: number;
  historyChars: number;
  messageChars: number;
  toolResultChars: number;
}

/**
 * The budget for one lane.
 *
 * `windowTokens` comes from the catalogue for a local model — the `-8k`/`-32k`
 * its Modelfile pins — and from the engine descriptor for a CLI. A caller that
 * does not know passes nothing and gets the tightest defensible default.
 */
export function budgetFor(engine: EngineId, windowTokens?: number | null): ContextBudget {
  const window =
    typeof windowTokens === "number" && Number.isFinite(windowTokens) && windowTokens > 0
      ? Math.floor(windowTokens)
      : DEFAULT_WINDOW_TOKENS[engine];
  const prose = (share: number) => Math.floor(window * share * PROSE_CHARS_PER_TOKEN);
  const dense = (share: number) => Math.floor(window * share * DENSE_CHARS_PER_TOKEN);
  return {
    engine,
    windowTokens: window,
    governed: !SELF_MANAGED.has(engine),
    systemPromptChars: prose(SHARES.systemPrompt),
    historyChars: prose(SHARES.history),
    messageChars: prose(SHARES.message),
    // Output, not prose: budgeted at the pessimistic rate.
    toolResultChars: dense(SHARES.toolResult),
  };
}

/** One labelled part of a prompt, in the order it should survive under pressure. */
export interface PromptSection {
  /** Named so a dropped section can be reported rather than vanishing silently. */
  name: string;
  text: string;
  /** True when the turn is wrong without it; kept even past the budget. */
  required?: boolean;
}

export interface AssembledPrompt {
  text: string;
  chars: number;
  /** Names of the sections the budget could not afford, in priority order. */
  dropped: string[];
  /** True when a required section pushed the result past the budget anyway. */
  overBudget: boolean;
}

/**
 * Join prompt sections in priority order, spending no more than the budget.
 *
 * Sections are taken in the order given: earlier is more important. A section
 * that does not fit is dropped whole rather than cut mid-sentence — half an
 * instruction is worse than none, because a model will follow the half it can
 * see. `required` sections are never dropped; if they alone exceed the budget
 * the result says so instead of pretending it fits.
 */
export function assemblePrompt(sections: PromptSection[], budgetChars: number, separator = "\n\n"): AssembledPrompt {
  const kept: string[] = [];
  const dropped: string[] = [];
  let chars = 0;

  for (const section of sections) {
    if (!section.text) continue;
    const cost = section.text.length + (kept.length ? separator.length : 0);
    if (section.required || chars + cost <= budgetChars) {
      kept.push(section.text);
      chars += cost;
      continue;
    }
    dropped.push(section.name);
  }

  return { text: kept.join(separator), chars, dropped, overBudget: chars > budgetChars };
}

/**
 * Trim a conversation to what the budget affords, newest first.
 *
 * Newest first because the turn being answered is the one that matters: an
 * older message is the first thing a human would drop too. Each message is also
 * capped on its own, so a single pasted file cannot spend the whole history
 * allowance and evict every turn around it.
 */
export function fitHistory<T extends { content: string }>(
  messages: T[],
  budget: Pick<ContextBudget, "historyChars" | "messageChars">,
  clamp: (message: T, limit: number) => T,
): T[] {
  const kept: T[] = [];
  let used = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const clamped = message.content.length > budget.messageChars ? clamp(message, budget.messageChars) : message;
    const cost = clamped.content.length;
    if (used + cost > budget.historyChars) break;
    kept.unshift(clamped);
    used += cost;
  }

  return kept;
}
