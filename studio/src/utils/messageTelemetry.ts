/**
 * The line under a settled reply: when, which engine, how much, how long.
 *
 * Here rather than in `MessageBlock.tsx` for the reason `orbExpression.ts` is:
 * node strips types from `.ts` and not JSX from `.tsx`, so a rule that lives
 * beside a component cannot be tested without a browser — and this one is a
 * rule about formatting that is worth pinning. `tests/message-telemetry.test.mjs`
 * holds it.
 */

/** "12:56" from an ISO stamp, or whatever was already a clock. */
export function clockOf(timestamp: string): string {
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  if (!Number.isNaN(parsed.getTime()) && /\d{4}-\d{2}-\d{2}/.test(timestamp)) {
    return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return timestamp;
}

export interface TelemetrySource {
  timestamp?: string;
  engineUsed?: string;
  tokensCount?: number;
  durationSec?: number;
  /**
   * Of `durationSec`, the part spent loading the model's weights rather than
   * answering. Only the local lane has one; an agent CLI reports zero.
   */
  loadSec?: number;
  costLabel?: string;
  /**
   * System-prompt sections the model's window could not afford this turn, from
   * `InferenceTelemetry.contextBudget.dropped`. Empty or absent on a turn that
   * fitted, and on every lane that manages its own context.
   */
  droppedSections?: string[];
}

/**
 * A load is worth naming when it changes what the number means.
 *
 * Ollama reports a load duration on every turn, and on a warm model it is
 * milliseconds — printing that is noise, and noise in this row is what made
 * the row wrap. A cold turn is different: most of the wait was weights, and
 * without saying so the row reads as a slow model, which is the wrong thing to
 * go and fix. So: at least a second of it, and at least a fifth of the turn.
 */
export function loadWorthNaming(durationSec?: number, loadSec?: number): boolean {
  if (typeof loadSec !== "number" || typeof durationSec !== "number") return false;
  if (loadSec < 1 || durationSec <= 0) return false;
  return loadSec >= durationSec * 0.2;
}

/**
 * Sections whose loss costs style, not capability.
 *
 * `systemPrompt.ts` ranks these last *on purpose* — the visual contract alone
 * was costing every "play that song" turn 1,858 characters — so their being
 * dropped is the budget working, not a fault. Naming them on the turns they
 * fall off would put a warning under most short replies, which is the same
 * mistake `loadWorthNaming` exists to avoid: a row that cries every turn is a
 * row nobody reads.
 */
const AFFORDABLE_SECTIONS = new Set(["completeness", "multi-agent", "house-style"]);

/**
 * Which dropped sections changed what the model could *do*.
 *
 * The rest of the ranking is capability: `screen` is the eye, `ask` is the
 * question, `tool-execution-mandate` is the instruction to act rather than
 * offer. Losing one of those silently is how a turn comes back saying "could
 * you describe the error or provide a screenshot?" from a machine that can see
 * the screen perfectly well — a failure that cost a session to not explain,
 * because the only record of it was computed and thrown away.
 *
 * Returned in the order the budget reported them, which is priority order.
 */
export function droppedWorthNaming(dropped?: string[]): string[] {
  if (!dropped || dropped.length === 0) return [];
  return dropped.filter((name) => !AFFORDABLE_SECTIONS.has(name));
}

/**
 * The fields, in order, with the empty ones gone.
 *
 * Assembled rather than rendered one span at a time so the row can be a single
 * non-wrapping, truncating string: it was five flex children with a gap
 * between every value *and* every separator, so in a narrow column each field
 * wrapped inside its own box — "Claude / Code", "44,409 / tok" — a two-line
 * row inside a one-line-high container.
 *
 * A field nobody measured is dropped here rather than rendered as an empty
 * box, so the separators can never end up doubled or trailing. Zero is one of
 * those: a reply reporting `0 tok` is reporting a number nobody counted.
 */
export function telemetry(message: TelemetrySource): string[] {
  const fields: string[] = [];
  const clock = clockOf(message.timestamp ?? "");
  if (clock) fields.push(clock);
  if (message.engineUsed) fields.push(message.engineUsed);
  if (typeof message.tokensCount === "number" && message.tokensCount > 0) {
    fields.push(`${message.tokensCount.toLocaleString()} tok`);
  }
  if (typeof message.durationSec === "number" && message.durationSec > 0) {
    fields.push(
      loadWorthNaming(message.durationSec, message.loadSec)
        ? `${message.durationSec.toFixed(1)}s (${message.loadSec!.toFixed(1)}s load)`
        : `${message.durationSec.toFixed(1)}s`,
    );
  }
  if (message.costLabel) fields.push(message.costLabel);
  // Last, because it is the exception rather than a reading: a turn that
  // fitted says nothing here at all.
  const lost = droppedWorthNaming(message.droppedSections);
  if (lost.length > 0) fields.push(`${lost.join(", ")} dropped`);
  return fields;
}
