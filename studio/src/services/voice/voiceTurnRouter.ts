/**
 * One assistant to the operator, two engines underneath.
 *
 * Temi holds the conversation. The Teminali OS assistant does the work, with
 * no chat surface of its own — its only visible presence is the process line
 * under the orb. This module is the switch between them: it takes one finished
 * transcript and decides which engine owns it.
 *
 * Before this, every transcript went to the Python pipeline's own LLM and, if
 * it looked like engineering, *also* to the agent. So while a build ran:
 *
 *   - "how's it going?"      started a second, unrelated conversation, because
 *                            the pipeline answers from a persona prompt that
 *                            has never heard of the run.
 *   - "stop"                 stopped nothing.
 *   - "nice, keep going"     was praise the pipeline replied to at length,
 *                            over the top of the work it was praising.
 *
 * `turnIntent` already knew the difference. It was simply never asked. This is
 * the asking, and it is pure: transcript plus a snapshot of what is running,
 * out comes a decision. The renderer performs it; nothing here touches a
 * socket, a store or a clock it was not handed.
 *
 * See `studio/DESIGN.md` §6.1 — the contract this brings the realtime tier
 * into line with.
 */

import { classifyTurnIntent, type TurnIntent } from "./turnIntent.ts";
import { summariseProgress, type RunProgress } from "./progressNarration.ts";
import {
  classifyMachineAction,
  acknowledgeAction,
  type MachineActionKind,
} from "./machineAction.ts";

export type VoiceTurnAction =
  /** Let the pipeline answer as itself. The ordinary conversational path. */
  | { kind: "converse" }
  /**
   * Hand it to the Teminali OS assistant. Temi speaks the acknowledgement
   * herself — see `machineAction.ts` for why the pipeline no longer does.
   */
  | { kind: "delegate"; prompt: string; action: MachineActionKind }
  /** Answered here, from the live run. The pipeline never sees the question. */
  | { kind: "answer"; text: string }
  /** Cancel the run. */
  | { kind: "stop" }
  /** Stop the voice. The run keeps going — this is the split §6.8 insists on. */
  | { kind: "hush" }
  /** Say the last thing again. */
  | { kind: "repeat"; text: string }
  /** Praise. Carry on, quietly. */
  | { kind: "acknowledge" };

export interface VoiceTurnState {
  /** An agent run is in flight. */
  busy: boolean;
  /** Temi was mid-sentence when this transcript landed. */
  speaking: boolean;
  /** What the run has done so far, or null if nothing is running. */
  run?: RunProgress | null;
  /** The last thing Temi said, for "say that again". */
  lastSpoken?: string | null;
  now?: number;
}

export interface VoiceTurnDecision {
  intent: TurnIntent;
  reason: string;
  action: VoiceTurnAction;
  /**
   * The pipeline began generating its own reply the moment it broadcast the
   * transcript. Every action except `converse` and `delegate` needs that reply
   * cancelled, or two voices answer the same sentence.
   */
  suppressPipelineAnswer: boolean;
  /** A line for Temi to say, or null when the right answer is silence. */
  speak: string | null;
}

/** Said when the operator asks about a run whose steps have not arrived yet. */
export const EMPTY_RUN_ANSWER = "It's still going — nothing to report yet.";

/** Said when a run is cancelled by voice. Short on purpose: the ask was for it to end. */
export const STOP_ACKNOWLEDGEMENT = "Stopped.";

function decision(
  intent: TurnIntent,
  reason: string,
  action: VoiceTurnAction,
  suppressPipelineAnswer: boolean,
  speak: string | null,
): VoiceTurnDecision {
  return { intent, reason, action, suppressPipelineAnswer, speak };
}

/**
 * Decide what one finished transcript means.
 *
 * `busy` is the whole hinge. Nothing is running, so there is nothing to report
 * on, nothing to stop and nothing to praise: the transcript is either work for
 * the assistant or talk for Temi, and `turnIntent` says so itself by returning
 * `instruction` for everything once it sees an idle session.
 */
export function routeVoiceTurn(text: string, state: VoiceTurnState): VoiceTurnDecision {
  const clean = (text ?? "").trim();
  if (!clean) {
    return decision("instruction", "Empty transcript — nothing to route.", { kind: "converse" }, false, null);
  }

  const { intent, reason } = classifyTurnIntent(clean, {
    busy: state.busy,
    speaking: state.speaking,
  });
  const now = state.now ?? Date.now();
  const run = state.run ?? null;

  switch (intent) {
    case "hush":
      return decision(intent, reason, { kind: "hush" }, true, null);

    case "repeat": {
      const last = (state.lastSpoken ?? "").trim();
      // With nothing to repeat, the pipeline is a better answer than silence:
      // it can at least say it does not remember.
      if (!last) return decision(intent, reason, { kind: "converse" }, false, null);
      return decision(intent, reason, { kind: "repeat", text: last }, true, last);
    }

    case "stop":
      // A bare "stop" with nothing running is about the voice, not the work.
      // `turnIntent` returns `stop` either way, on purpose: it does not know
      // whether a run exists, and this does.
      if (!state.busy) return decision(intent, reason, { kind: "hush" }, true, null);
      return decision(intent, reason, { kind: "stop" }, true, STOP_ACKNOWLEDGEMENT);

    case "acknowledge":
      // "Excellent, keep going." The worst possible reply is a paragraph.
      return decision(intent, reason, { kind: "acknowledge" }, true, null);

    case "status":
    case "explain": {
      const answer = run ? summariseProgress(run, now).trim() : "";
      return decision(
        intent,
        reason,
        { kind: "answer", text: answer || EMPTY_RUN_ANSWER },
        true,
        answer || EMPTY_RUN_ANSWER,
      );
    }

    case "instruction":
    default: {
      const machine = classifyMachineAction(clean);
      if (machine) {
        // The pipeline's reply is suppressed here, reversing the original
        // §6.0.2 decision. It was letting the persona LLM improvise the "on
        // it", and a persona asked to acknowledge an action it cannot observe
        // narrates the action instead — the fantasising the operator reported.
        // Temi says one grounded line; the truth arrives afterwards from the
        // activity record.
        const line = acknowledgeAction(machine.kind, now);
        return decision(
          intent,
          `${reason} · ${machine.reason}`,
          { kind: "delegate", prompt: clean, action: machine.kind },
          true,
          line,
        );
      }
      return decision(intent, reason, { kind: "converse" }, false, null);
    }
  }
}
