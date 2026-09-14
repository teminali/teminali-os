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
function flatten(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifySelfVoiceCommand(text: string): "mute" | "unmute" | null {
  const flat = flatten(text);
  if (!flat) return null;
  const stem = flat.replace(WRAPPER_PREFIX, "").replace(WRAPPER_SUFFIX, "").trim();
  // Unmute is asked first because it is the phrase a muted session most needs
  // to land. The two sets are disjoint, so the order is about reading, not
  // about precedence.
  if (UNMUTE_PHRASES.has(flat) || UNMUTE_PHRASES.has(stem)) return "unmute";
  if (MUTE_PHRASES.has(flat) || MUTE_PHRASES.has(stem)) return "mute";
  return null;
}

/**
 * Which assistant the operator asked for, out loud.
 *
 * The four values are `CodingEngine` in `store/assistantActivityStore.ts` —
 * read, not invented — because that store is what `TeminaliAgentBridge` asks
 * when it decides who runs a delegation. Nothing else in the app has a fifth.
 */
export type VoiceEngineChoice = "claude" | "codex" | "gemini" | "frontier";

/**
 * What Temi calls each engine when she confirms the switch.
 *
 * The labels are the product's own: `PROFILES_LIST` in `store/studioStore.ts`
 * for the Frontier tiers, `agentCliService.ts` for the two CLIs.
 *
 * Two collapses are deliberate, and both exist so she cannot claim a switch
 * that did not happen — the fabrication this whole intent was added to stop:
 *
 *   - **Frontier Max is `gemini`.** The bridge maps that engine onto the
 *     Gemini-backed max lane; there is no separate `max` engine to set.
 *   - **Frontier Flash and Frontier Auto are both `frontier`.** The delegation
 *     lane has exactly one local mode (`streamMode` is "auto" for every
 *     non-Gemini engine in `teminaliAgentBridge.runTask`), so asking for Flash
 *     and asking for Auto land in the same place. She answers "Frontier",
 *     which is true of both, rather than naming a tier she cannot select.
 */
export const ENGINE_LABELS: Record<VoiceEngineChoice, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Frontier Max",
  frontier: "Frontier",
};

/**
 * The spoken names, and what each one means.
 *
 * "cloud code" and "code x" are here because that is how the two CLI names
 * come back from recognition often enough to matter; a switch that works only
 * when the transcript is perfect is a switch that works for nobody. Nothing
 * bare and ambiguous is listed — no "max", no "flash", no "cloud" — because
 * this is a video editor as well, and the cost of a false match is the work
 * running on the wrong assistant.
 */
const ENGINE_NAMES: ReadonlyArray<readonly [string, VoiceEngineChoice]> = [
  ["claude code", "claude"],
  ["cloud code", "claude"],
  ["claude cli", "claude"],
  ["claude", "claude"],
  ["open ai codex", "codex"],
  ["openai codex", "codex"],
  ["codex cli", "codex"],
  ["codex", "codex"],
  ["code x", "codex"],
  ["frontier max", "gemini"],
  ["gemini", "gemini"],
  ["frontier flash", "frontier"],
  ["frontier auto", "frontier"],
  ["frontier", "frontier"],
];

const ENGINE_BY_NAME = new Map<string, VoiceEngineChoice>(ENGINE_NAMES);

/** Longest first, so "claude code" is never read as "claude" plus a stray word. */
const NAME_ALTERNATION = [...ENGINE_NAMES]
  .map(([name]) => name)
  .sort((a, b) => b.length - a.length)
  .join("|");

/**
 * The frames that make a name a *choice of engine* rather than a word.
 *
 * A bare mention is not enough. "Claude said the build was fine" names an
 * assistant and asks for nothing; "ask Claude to check the build" hands over
 * the work. The frame is the difference, and requiring one is what keeps this
 * out of ordinary conversation.
 */
const ENGINE_FRAME =
  "use|using|switch(?:\\s+(?:over|back))?\\s+to|switch\\s+engines?\\s+to|go\\s+(?:back\\s+)?to" +
  "|change\\s+to|move\\s+to|delegate\\s+(?:it|this|that)?\\s*to" +
  "|hand\\s+(?:it|this|that)\\s+(?:over\\s+|off\\s+)?to|give\\s+(?:it|this|that)\\s+to" +
  "|send\\s+(?:it|this|that)\\s+to|put\\s+(?:it|this|that)\\s+on" +
  "|run\\s+(?:it|this|that)?\\s*(?:on|with|through)" +
  "|ask|tell|have|get|let|with|via|on|through";

const FRAMED_ENGINE = new RegExp(`\\b(?:${ENGINE_FRAME})\\s+(?:the\\s+)?(${NAME_ALTERNATION})\\b`);

/** "Codex, look at this file." The name is the address, the rest is the job. */
const ADDRESSED_ENGINE = new RegExp(`^(?:hey\\s+|ok\\s+|okay\\s+)?(${NAME_ALTERNATION})\\b(?=\\s+\\S)`);

/**
 * Words that can be left over from a pure switch without making it a task.
 *
 * Curated tightly, and biased on purpose. Reading a task as a switch loses the
 * task silently — Temi confirms the engine and the work never runs — while
 * reading a switch as a task only falls back to what happens today. So no verb
 * is in this set: "use Claude Code to run it" keeps "run it" and stays a job.
 */
const SWITCH_RESIDUE = new Set([
  "the", "a", "an", "to", "for", "from", "on", "in", "of", "as", "and", "then", "now",
  "instead", "please", "thanks", "temi", "temy", "teminali", "engine", "engines",
  "model", "models", "assistant", "agent", "mode", "lane", "everything", "default",
  "going", "forward", "future", "onwards", "onward", "again", "back", "over",
  "next", "rest", "one", "time", "task", "tasks", "work", "this", "that", "it",
  "all", "my", "i", "you", "we", "want", "would", "like", "let's", "lets", "can",
  "could", "should", "ok", "okay", "yeah", "yes",
]);

export interface EngineChoice {
  engine: VoiceEngineChoice;
  /** What she says back. Never the spoken name — see `ENGINE_LABELS`. */
  label: string;
  /** The spoken name that matched, for the decision trail. */
  heard: string;
  /**
   * True when the utterance chose an engine and asked for nothing else, so the
   * right answer is to switch and say so rather than to start a run.
   */
  switchOnly: boolean;
}

/**
 * "Which assistant did that sentence ask for?" — and nothing else.
 *
 * Pure, and shared with `teminaliAgentBridge`, which is the half that can act
 * on it. Two different questions are answered by one parse:
 *
 *   - "use Frontier Max"            → `switchOnly`: change who does the work.
 *   - "have Codex look at this file" → the engine for *this* job, which the
 *     bridge used to discard entirely, so Codex work ran on Frontier.
 */
export function parseEngineChoice(text: string): EngineChoice | null {
  const flat = flatten(text);
  if (!flat) return null;

  const build = (engine: VoiceEngineChoice, heard: string, switchOnly: boolean): EngineChoice => ({
    engine,
    label: ENGINE_LABELS[engine],
    heard,
    switchOnly,
  });

  // The whole utterance is the name: "Frontier Max." said on its own is a
  // choice, even with no verb in front of it.
  const bare = flat.replace(WRAPPER_PREFIX, "").replace(WRAPPER_SUFFIX, "").trim();
  const whole = ENGINE_BY_NAME.get(bare) ?? ENGINE_BY_NAME.get(flat);
  if (whole) return build(whole, bare || flat, true);

  const match = FRAMED_ENGINE.exec(flat) ?? ADDRESSED_ENGINE.exec(flat);
  if (!match) return null;
  const heard = match[1];
  const engine = ENGINE_BY_NAME.get(heard);
  if (!engine) return null;

  const rest = `${flat.slice(0, match.index)} ${flat.slice(match.index + match[0].length)}`;
  const leftover = rest.split(" ").filter((word) => word && !SWITCH_RESIDUE.has(word));
  return build(engine, heard, leftover.length === 0);
}

/**
 * What she says once the engine has actually changed.
 *
 * Said *after* the store is written, never before, and it does not pretend the
 * run in flight moved: a switch mid-run applies to the next job, because the
 * one already streaming was started by another CLI and cannot be handed over.
 */
export function describeEngineSwitch(label: string, busy: boolean): string {
  return busy
    ? `${label} takes the next one. What's running now stays where it is.`
    : `${label} has the work from here.`;
}

/**
 * Questions about a run that has already finished.
 *
 * Asked while the run is live, these reach `status`/`explain` and are answered
 * from the digest. Asked a moment after it ends, `turnIntent` sees an idle
 * session, calls everything an instruction, and "what did it change" starts a
 * *second* run to find out what the first one did. The bridge holds the report
 * of the run that just ended and answers from it; this is the recogniser.
 *
 * Narrow on purpose, and safe when it is wrong: the bridge only answers from a
 * report it actually has, and otherwise delegates exactly as before.
 *
 * Consulted twice in the `instruction` branch, and the second call is the one
 * that does the work. Where `classifyMachineAction` has already matched it only
 * annotates the decision trail. Where the gate found nothing, it is what routes
 * the question to the bridge at all, and without it four of the six phrasings
 * below went to the persona instead. See that branch for why it is gated on an
 * idle session and why it lives there rather than in the gate's own patterns.
 */
const RUN_RECALL_PATTERNS: RegExp[] = [
  /^(?:so|and|ok|okay)?\s*(?:what|which)\s+(?:files?\s+)?(?:did|has|have)\s+(?:it|that|you|the\s+(?:agent|assistant|run|task))\b/,
  /^(?:so|and|ok|okay)?\s*what\s+(?:just\s+)?(?:happened|changed|broke)\b/,
  /^(?:so|and|ok|okay)?\s*what\s+(?:was|were)\s+(?:that|those|changed|touched)\b/,
  /^(?:so|and|ok|okay)?\s*(?:how\s+did|did)\s+(?:it|that)\s+(?:go|work|finish|pass|succeed|end)\b/,
  /^(?:so|and|ok|okay)?\s*tell\s+me\s+what\s+(?:it|that|you)\s+(?:did|changed|found)\b/,
  /^(?:so|and|ok|okay)?\s*(?:what|which)\s+files?\s+(?:did\s+it\s+)?(?:changed?|touched?|edited?)\b/,
  /^(?:so|and|ok|okay)?\s*how\s+(?:many|much)\s+[^?.]{0,50}?\b(?:did\s+you|was|were)\s+(?:just\s+)?(?:find|found|see|say|report|have|left|free)\b/,
  /^(?:so|and|ok|okay)?\s*(?:what|how\s+much)\s+(?:was\s+the\s+)?(?:storage|disk|space|size|number|count|result|outcome)\b/,
  /\b(?:did\s+you\s+just\s+find|you\s+just\s+found|did\s+you\s+find)\b/,
];

export function isRunRecallQuestion(text: string): boolean {
  const flat = flatten(text);
  if (!flat) return false;
  return RUN_RECALL_PATTERNS.some((pattern) => pattern.test(flat));
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
      /*
        "Use Frontier Max." Nothing in `machineAction` has ever recognised a
        choice of engine, so this reached the persona, which answered in
        character — it said it had switched, and it had not. That is the exact
        fabrication §6 forbids, and it is worse than silence because the
        operator then believes the next run is on a different assistant.

        Routed as a delegation with nothing to say yet, on purpose. The switch
        is a store write and this module is pure, so `TeminaliAgentBridge`
        performs it — it parses the same utterance with the same
        `parseEngineChoice`, never starts a run, and speaks the confirmation
        only once the store has actually changed. The kind is `workspace`
        because that is the closest family the gate has; the bridge intercepts
        before anything reads it.
      */
      const engineChoice = parseEngineChoice(clean);
      if (engineChoice?.switchOnly) {
        return decision(
          intent,
          `${reason} · Named ${engineChoice.label} and asked for nothing else — a change of engine, not a job.`,
          { kind: "delegate", prompt: clean, action: "workspace" },
          true,
          null,
        );
      }

      const machine = classifyMachineAction(clean);
      if (machine) {
        // The pipeline's reply is suppressed here, reversing the original
        // §6.0.2 decision. It was letting the persona LLM improvise the "on
        // it", and a persona asked to acknowledge an action it cannot observe
        // narrates the action instead — the fantasising the operator reported.
        // Temi says one grounded line; the truth arrives afterwards from the
        // activity record.
        const line = acknowledgeAction(machine.kind, now);
        /*
          "What did it change?", asked after the run ended rather than during
          it. `turnIntent` sees an idle session and calls it an instruction, so
          a question *about* work became a second lot of work — measured: a
          fresh agent run, started to discover what the last one did, when the
          report was already in hand. The bridge holds that report and answers
          from it; this only marks the decision trail, because a router that
          cannot see the report must not promise one.
        */
        const recall = isRunRecallQuestion(clean)
          ? " · Asks about a run that has already finished — the bridge answers from its own report if it still holds one."
          : "";
        return decision(
          intent,
          `${reason} · ${machine.reason}${recall}`,
          { kind: "delegate", prompt: clean, action: machine.kind },
          true,
          line,
        );
      }

      /*
        The same question, in the wording the gate cannot see.

        Measured with nothing running: "what did it change" and "what files did
        it touch" reach the bridge, while "what did you change", "what just
        happened", "how did it go" and "tell me what you did" reached the
        persona instead. The difference is a pronoun and a verb list, not a
        difference in what was asked. `STATE_QUESTIONS` needs one of `it`, `this`
        or `that` to be somewhere in the sentence at all, and its verb list holds
        "changed" but neither "happened" nor "go", so the four phrasings that
        address her directly or name no object fall out of the gate entirely.
        The persona has never seen the finished run's report, so it answers from
        character. That is the fabrication §6 forbids, about work that really was
        done and really was written down.

        `isRunRecallQuestion` already recognised all six. It was only ever
        consulted on the branch above, where a machine action had already
        matched, so for these four it never ran at all. This is the same
        recogniser asked in the one place it could not reach.

        It lives here rather than in `classifyMachineAction` for three reasons,
        and each is also what keeps it as narrow as the recogniser's own comment
        promises.

        First, it needs an IDLE session, and `busy` is the router's own input:
        `classifyMachineAction(text)` is pure by contract and cannot see it.
        Widening the gate's patterns instead would fire in both states, and
        while a run is live these questions are about the thing in flight and
        the branches above own them.

        Second, this is a FALL-THROUGH, reached only once the gate has already
        returned null. It can turn `converse` into `delegate` and nothing else,
        so no deliberate refusal above it moves and no instruction is
        reclassified. "Run the tests" is still shell, "open the dukabot folder"
        is still open, "what should I do next" is still conversation.

        Third, a run-recall question is not a request for work, which is the
        only question `machineAction.ts` asks. It is a read of a report the
        bridge is already holding. `isMachineAction` is re-exported from
        `teminaliAgentBridge` and pinned in both directions by
        `tests/voice-delegation-safety.test.mjs`, so teaching the gate this
        concept would fork it across three modules that could then disagree.

        Safe when wrong, for the reason the recogniser already gives:
        `teminaliAgentBridge` answers from a report only when it actually holds
        a recent one, and otherwise delegates exactly as before.

        `inspect` is the kind on purpose. It is what the gate already returns
        for the two siblings that work, so the four join them rather than
        arriving as some new family that the acknowledgement and the outcome
        summary have never been told about.
      */
      if (!state.busy && isRunRecallQuestion(clean)) {
        return decision(
          intent,
          `${reason} · No machine action in it, but it asks about a run that has already finished. The bridge answers from its own report if it still holds one, and delegates if it does not.`,
          { kind: "delegate", prompt: clean, action: "inspect" },
          true,
          acknowledgeAction("inspect", now),
        );
      }

      return decision(intent, reason, { kind: "converse" }, false, null);
    }
  }
}
