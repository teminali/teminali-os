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
  costLabel?: string;
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
    fields.push(`${message.durationSec.toFixed(1)}s`);
  }
  if (message.costLabel) fields.push(message.costLabel);
  return fields;
}
