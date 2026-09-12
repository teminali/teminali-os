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
  /**
   * Close the ears as well as the mouth, and keep them closed.
   *
   * `mute` is not a stronger `hush`, it is a different request, and the
   * microphone is the whole difference. `hush` ends the sentence she is in the
   * middle of and leaves the mic open, so the very next thing the operator says
   * is heard and answered: that is what makes "quiet for a second" usable while
   * a build finishes. `mute` closes the capture path too and stays closed until
   * it is asked to open, which is why "be quiet" must never reach it. Neither
   * touches the run, which is the same split §6.8 insists on.
   */
  | { kind: "mute" }
  /** Open the ears again. See `classifySelfVoiceCommand` for what can carry it. */
  | { kind: "unmute" }
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

/**
 * Said when the operator asks how it is going and nothing is going at all.
 *
 * Reachable only by interrupting: `status` requires `busy || speaking`, so with
 * `busy` false the question arrived over Temi's own voice. `EMPTY_RUN_ANSWER`
 * was answering that case too, and "it's still going" was then simply untrue.
 * It is the only wrong sentence this branch could produce, because
 * `summariseProgress` never returns empty — it opens with elapsed time — so an
 * empty answer never meant a quiet run, it only ever meant no run.
 */
export const IDLE_STATUS_ANSWER = "Nothing is running right now.";

/** Said when a run is cancelled by voice. Short on purpose: the ask was for it to end. */
export const STOP_ACKNOWLEDGEMENT = "Stopped.";

/**
 * Said when the microphone is closed by voice: before the silence, and audible
 * despite it.
 *
 * The ordering is worth stating because it is not obvious from the call site.
 * `speakLine` hands a verbatim line to the live socket as a directive and the
 * audio comes back over that socket a moment later, so the line is not spoken
 * synchronously and cannot be. Muting does not silence it: `isMuted` in
 * `voiceAudioEngine` gates the capture path only, where `flushBatch` drops the
 * mic batch, and playback is untouched. So a confirmation sent before the mute
 * still lands, provided nothing clears the TTS buffer after it was sent. That
 * is the one thing the renderer has to get right, and it is why this is a line
 * rather than `null`.
 *
 * It names the way back on purpose. With the mic closed the operator cannot say
 * "unmute" and be heard, so a confirmation that did not say what still works
 * would leave them talking at a machine that had stopped listening.
 */
export const MUTE_ACKNOWLEDGEMENT = "Going quiet. Type or tap the orb when you want me back.";

/** Said when the ears open again. Short: the ask was to get on with it. */
export const UNMUTE_ACKNOWLEDGEMENT = "Listening again.";

/**
 * Whole utterances that ask her to close her own microphone.
 *
 * A whitelist of complete phrases rather than a keyword, because the costly
 * false positive is right next door: this shell is a video editor as well, so
 * "mute the video" and "mute that track" are ordinary editing commands that
 * belong to the hands. A gate that keyed on the word `mute` would close the
 * microphone instead of muting a clip, and the operator could not then say so
 * out loud. Nothing counts here unless the utterance is the request entire and
 * its object is her, her voice, or the session's microphone.
 *
 * "stop listening" is in this set and not in `turnIntent`'s: there it falls to
 * the bare-stop rule, which mid-run cancels the run, so an operator closing the
 * mic lost the build to it.
 */
const MUTE_PHRASES = new Set([
  "mute", "go mute", "go on mute", "going mute", "mute now",
  "mute yourself", "mute you", "mute your mic", "mute your microphone",
  "mute the mic", "mute the microphone", "mute your voice",
  "mic off", "mics off", "microphone off",
  "turn off the mic", "turn off your mic", "turn the mic off", "turn your mic off",
  "turn off the microphone", "turn off your microphone", "turn the microphone off",
  "switch off the mic", "switch the mic off",
  "cut the mic", "kill the mic", "close the mic", "close your mic", "close the microphone",
  "stop listening", "stop listening to me", "stop the mic", "stop the microphone",
  "stop your mic", "don't listen", "dont listen", "do not listen",
  "don't listen to me", "dont listen to me", "do not listen to me",
  "stop listening and talking", "stop talking and listening",
]);

/**
 * Whole utterances that ask for the microphone back.
 *
 * Same whitelist discipline, for the same reason: "unmute the video" is the
 * editor's business. The bare forms are what survives wrapper stripping, so
 * "you can listen again" is matched twice over, once as spoken and once as
 * "listen again".
 */
const UNMUTE_PHRASES = new Set([
  "unmute", "un mute", "unmute yourself", "unmute you",
  "unmute your mic", "unmute your microphone", "unmute the mic",
  "unmute the microphone", "unmute your voice",
  "mic on", "mic back on", "microphone on", "microphone back on",
  "turn on the mic", "turn the mic on", "turn on your mic", "turn your mic on",
  "turn the mic back on", "turn your mic back on", "turn on the microphone",
  "turn the microphone on", "turn the microphone back on",
  "switch on the mic", "switch the mic on",
  "open the mic", "open your mic", "open the microphone", "open your ears",
  "start listening", "start listening again", "listen again", "listen to me again",
  "hear me again", "you can listen again", "you can hear me again",
  "you can talk again", "you can speak again", "you can listen",
]);

/**
 * Politeness and address that wrap a request without changing it, taken off
 * both ends before the sets above are consulted.
 *
 * `turnIntent` has a filler set of its own and does not export it, so this is
 * deliberately narrower rather than a copy: only the wrappers this particular
 * request arrives in. Spoken mutes land as "okay, mute yourself", "Temi,
 * mute", "can you mute yourself please". Nothing that carries meaning for
 * these two sets is stripped, which is why "again" is absent from the tail.
 */
const WRAPPER_PREFIX =
  /^(?:(?:ok|okay|alright|right|so|well|hey|yo|hi|please|now|just|and|then|also|actually|temi|temy|teminali|can you|could you|would you|will you|i need you to|i want you to|you can|you should|let's|lets)\s+)+/;

const WRAPPER_SUFFIX =
  /(?:\s+(?:please|now|ok|okay|thanks|thank you|temi|temy|teminali|for a second|for a sec|for a minute|for a moment|for a bit|for a while|for now))+$/;

/**
 * "Was that about her own microphone?" — and only that.
 *
 * Reachability, stated plainly rather than assumed: `unmute` cannot arrive by
 * voice while she is muted. `voiceAudioEngine.flushBatch` drops the captured
 * batch whenever `isMuted` is set, so no audio reaches the socket, no
 * transcript comes back, and this function is never called on a muted lane.
 * The routes that do work are typing, which reaches this same router, and the
 * mic toggle. `unmute` is still routed in every state, because the router is
 * not told who is muted and a redundant unmute costs a no-op.
 */
function classifySelfVoiceCommand(text: string): "mute" | "unmute" | null {
  const flat = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  const stem = flat.replace(WRAPPER_PREFIX, "").replace(WRAPPER_SUFFIX, "").trim();
  // Unmute is asked first because it is the phrase a muted session most needs
  // to land. The two sets are disjoint, so the order is about reading, not
  // about precedence.
  if (UNMUTE_PHRASES.has(flat) || UNMUTE_PHRASES.has(stem)) return "unmute";
  if (MUTE_PHRASES.has(flat) || MUTE_PHRASES.has(stem)) return "mute";
  return null;
}

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

  /*
    Read before the intent, because `turnIntent` cannot see this distinction and
    two of its verdicts are wrong once it exists: "mute" and "mute yourself" sit
    in its hush set, and "stop listening" falls through to its bare-stop rule,
    which while a run is in flight cancels the run. Both are the same class of
    mistake as the one §6.8 fixed for "stop talking" — the operator asks for one
    kind of silence and loses something else.

    The classifier's own verdict is still reported in `intent`, unchanged. It is
    what the intent gate saw, and saying otherwise here would hide the very
    disagreement this branch exists to settle; the appended reason carries the
    rest.
  */
  const selfVoice = classifySelfVoiceCommand(clean);
  if (selfVoice === "unmute") {
    return decision(
      intent,
      `${reason} · Asked for the microphone back.`,
      { kind: "unmute" },
      true,
      UNMUTE_ACKNOWLEDGEMENT,
    );
  }
  if (selfVoice === "mute") {
    return decision(
      intent,
      `${reason} · Asked for the microphone closed, not merely for quiet.`,
      { kind: "mute" },
      true,
      MUTE_ACKNOWLEDGEMENT,
    );
  }

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
      // Which sentence is true when there is nothing to summarise depends on
      // why we got here: busy means a run younger than its first tool call,
      // and not busy means no run at all and a question asked over Temi.
      const fallback = state.busy ? EMPTY_RUN_ANSWER : IDLE_STATUS_ANSWER;
      return decision(
        intent,
        reason,
        { kind: "answer", text: answer || fallback },
        true,
        answer || fallback,
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
