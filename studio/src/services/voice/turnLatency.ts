/**
 * Where every answered turn's stopwatch lands.
 *
 * Moving the endpoint off Google was measured against four scripted
 * utterances played into a live session: 993 ms off the median wait. That is a
 * harness, and a harness speaks one sentence, in one voice, with one kind of
 * pause. His real turns trail off, restart, and think out loud. This is the
 * accumulator that turns those into a distribution, so the next decision about
 * the lane is taken against his conversations rather than against a recording.
 *
 * It also counts the thing no latency number can show. A faster endpoint is
 * only an improvement if it is still right about when he stopped, and being
 * wrong is invisible from the outside: the engine reopens the turn and carries
 * on. `corrections` is how often that happened and `tightestCutMs` is the
 * shortest silence it happened on, which is the difference between clipping a
 * trailing pause and cutting him off mid-sentence.
 *
 * Module level on purpose, and reset only by `resetTurnLatency`. The stage
 * remounts whenever he leaves the voice screen and comes back, and a
 * distribution that empties on remount answers a question nobody asked.
 */
import type { TurnTiming } from "./geminiLiveEngine.ts";

/**
 * A conversation, not a soak test. 500 turns is far past any single sitting,
 * and the cap is here so a machine left running for a week cannot grow this
 * without bound.
 */
const MAX_TURNS = 500;

export interface Quantiles {
  /** Average of the two middle values on an even count, matching how the A/B was reported. */
  medianMs: number;
  /** Nearest rank. The tail he actually notices. */
  p90Ms: number;
  worstMs: number;
}

export interface TurnLatencySummary {
  turns: number;
  /** He stopped speaking to the first byte of her voice. The number he feels. */
  wait: Quantiles;
  /** Our endpointer's share of it: speech end to `activityEnd` on the wire. */
  commit: Quantiles;
  /** Gemini's share: `activityEnd` to her first audio. The larger term since 5109911. */
  model: Quantiles;
  /** Turns that had to be reopened because the endpoint was early. */
  cutTurns: number;
  /** Reopenings in total, which can exceed `cutTurns` if one turn was called over twice. */
  corrections: number;
  /** The tightest silence we wrongly ended on, in ms, 0 if we never did. */
  tightestCutMs: number;
  /** The endpointer's learned pause floor as of the last turn. */
  pacingFloorMs: number;
}

const turns: TurnTiming[] = [];

function quantiles(values: number[]): Quantiles {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { medianMs: 0, p90Ms: 0, worstMs: 0 };
  const mid = n >> 1;
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    medianMs: Math.round(median),
    p90Ms: sorted[Math.ceil(0.9 * n) - 1],
    worstMs: sorted[n - 1],
  };
}

/** Record one answered turn and hand back the distribution it just joined. */
export function recordTurn(timing: TurnTiming): TurnLatencySummary {
  turns.push(timing);
  if (turns.length > MAX_TURNS) turns.shift();
  return turnLatencySummary();
}

export function turnLatencySummary(): TurnLatencySummary {
  const cuts = turns.map((t) => t.cutGapMs).filter((ms) => ms > 0);
  return {
    turns: turns.length,
    wait: quantiles(turns.map((t) => t.firstAudioMs)),
    commit: quantiles(turns.map((t) => t.commitMs)),
    model: quantiles(turns.map((t) => Math.max(0, t.firstAudioMs - t.commitMs))),
    cutTurns: turns.filter((t) => t.corrections > 0).length,
    corrections: turns.reduce((sum, t) => sum + t.corrections, 0),
    tightestCutMs: cuts.length ? Math.min(...cuts) : 0,
    pacingFloorMs: turns.length ? turns[turns.length - 1].pacingFloorMs : 0,
  };
}

/** Every turn recorded this session, oldest first. */
export function turnLatencyLog(): readonly TurnTiming[] {
  return turns;
}

export function resetTurnLatency(): void {
  turns.length = 0;
}

/**
 * One line per turn, written for reading in a console during a real
 * conversation: this turn first, then what the session looks like so far.
 * The split matters more than the total. `commit` is ours and `model` is
 * Gemini's, and since 5109911 the second is roughly twice the first, which is
 * the argument against spending another release on endpointing.
 */
export function formatTurnLatency(timing: TurnTiming, summary: TurnLatencySummary): string {
  const model = Math.max(0, timing.firstAudioMs - timing.commitMs);
  const parts = [
    `voice turn ${summary.turns}: wait ${timing.firstAudioMs}ms`,
    `(commit ${timing.commitMs} + model ${model}, window ${timing.windowMs})`,
    `| median ${summary.wait.medianMs}ms p90 ${summary.wait.p90Ms}ms over ${summary.turns}`,
  ];
  if (timing.corrections > 0) {
    parts.push(`| CUT ${timing.corrections}x, tightest ${timing.cutGapMs}ms`);
  }
  if (summary.cutTurns > 0) {
    parts.push(`| cut ${summary.cutTurns}/${summary.turns} turns, floor ${summary.pacingFloorMs}ms`);
  }
  return parts.join(" ");
}
