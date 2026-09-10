/**
 * The last exchange, and nothing else.
 *
 * Temi's stage shows no conversation log. The core assistant never appears as
 * a chat, and neither does she: the orb is the surface, and text exists only
 * long enough for you to see what was heard and what was answered. This module
 * decides *what* is on screen and *which phase* the fade is in; the stage owns
 * the timer and the CSS that performs it.
 *
 * Pure by design — same inputs, same answer, no clock it was not handed — so
 * the whole behaviour is testable without a renderer. Same split as
 * `voiceTurnRouter.ts`.
 */

export interface EphemeralTurn {
  role: "user" | "assistant";
  content: string;
}

export interface EphemeralTranscriptInput {
  /** Full dialogue record. Only its tail is ever shown. */
  history: readonly EphemeralTurn[];
  /** Partial ASR text while the user is still speaking, if any. */
  liveUserSpeech?: string | null;
  /** Partial answer streaming in from the pipeline, if any. */
  liveAssistantStream?: string | null;
  /** True while TTS is playing. Nothing fades out from under a voice. */
  isSpeaking?: boolean;
  /** When the last turn settled, epoch ms. `null` before anything has happened. */
  lastTurnAt: number | null;
  /** Now, epoch ms. */
  now: number;
  /** Fully opaque for this long after the turn settles. */
  holdMs?: number;
  /** Then fades over this long. */
  fadeMs?: number;
}

export type EphemeralPhase = "hidden" | "held" | "fading";

export interface EphemeralTranscript {
  userLine: string | null;
  assistantLine: string | null;
  phase: EphemeralPhase;
  /**
   * ms until `phase` changes on its own, or `null` if it never will (either
   * already hidden, or held open by live speech). The stage arms one timeout
   * with this rather than ticking every frame.
   */
  nextChangeInMs: number | null;
}

export const EPHEMERAL_HOLD_MS = 6000;
export const EPHEMERAL_FADE_MS = 1400;

const HELD: Pick<EphemeralTranscript, "phase" | "nextChangeInMs"> = {
  phase: "held",
  nextChangeInMs: null,
};

/**
 * The last exchange in `history`: the final assistant answer with the user
 * turn that prompted it, or a lone user turn still waiting for one.
 */
function lastExchange(history: readonly EphemeralTurn[]): {
  userLine: string | null;
  assistantLine: string | null;
} {
  const last = history[history.length - 1];
  if (!last) return { userLine: null, assistantLine: null };

  if (last.role === "user") {
    return { userLine: last.content, assistantLine: null };
  }

  const before = history[history.length - 2];
  return {
    userLine: before && before.role === "user" ? before.content : null,
    assistantLine: last.content,
  };
}

export function selectEphemeralTranscript(input: EphemeralTranscriptInput): EphemeralTranscript {
  const {
    history,
    liveUserSpeech,
    liveAssistantStream,
    isSpeaking = false,
    lastTurnAt,
    now,
    holdMs = EPHEMERAL_HOLD_MS,
    fadeMs = EPHEMERAL_FADE_MS,
  } = input;

  // Speaking replaces the previous exchange outright — a new question should
  // not sit under the answer to the old one.
  if (liveUserSpeech) {
    return { userLine: liveUserSpeech, assistantLine: null, ...HELD };
  }

  const settled = lastExchange(history);

  if (liveAssistantStream) {
    return { userLine: settled.userLine, assistantLine: liveAssistantStream, ...HELD };
  }

  if (settled.userLine === null && settled.assistantLine === null) {
    return { userLine: null, assistantLine: null, phase: "hidden", nextChangeInMs: null };
  }

  // Her voice outlasts the stream: hold until she stops, then start the clock.
  if (isSpeaking) {
    return { ...settled, ...HELD };
  }

  if (lastTurnAt === null) {
    return { ...settled, ...HELD };
  }

  const elapsed = now - lastTurnAt;

  if (elapsed < holdMs) {
    return { ...settled, phase: "held", nextChangeInMs: holdMs - elapsed };
  }

  if (elapsed < holdMs + fadeMs) {
    return { ...settled, phase: "fading", nextChangeInMs: holdMs + fadeMs - elapsed };
  }

  return { userLine: null, assistantLine: null, phase: "hidden", nextChangeInMs: null };
}
