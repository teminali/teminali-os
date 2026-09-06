/**
 * Being asked for permission out loud, and answering out loud.
 *
 * The operator's words, verbatim: *"the assistant has to ask me if i say yes it
 * accepts itself, but do show the option incase i wanted to click myself"*. So
 * this adds a second door onto the existing prompt and touches nothing about
 * the first: the buttons stay exactly where they were, keep working, and a
 * click settles the request whether or not anything was ever said.
 *
 * Two halves:
 *
 * - **Asking.** When a pane publishes a pending approval (`store/approvalStore`)
 *   and *this* pane's voice engine is the one listening, the question is spoken
 *   as an aside — outside the turn, so it does not become part of the reply and
 *   is not queued behind one.
 * - **Answering.** The pane's `submit` runs `consume` before it sends anything
 *   to the model. A short "yes" settles the prompt and goes no further; anything
 *   that is not plainly an answer travels on as ordinary speech with the prompt
 *   still standing. `services/voice/approvalIntent.ts` draws that line, and
 *   draws it narrowly on purpose.
 *
 * ## Why the guard is "is this engine listening"
 *
 * Every chat surface builds its own `VoiceEngine`, so three of them may be
 * mounted at once. Only one can hold the microphone, and the question must be
 * asked once, by that one. `mode === "conversation"` and a non-idle state is
 * exactly that test — a push-to-talk engine is not listening between presses
 * and must not narrate, and an idle one is not listening at all.
 *
 * A prompt raised while nothing is listening is simply never spoken. That is
 * the correct outcome, not a gap: the operator is at the keyboard, and the
 * buttons are in front of them.
 */

import { useCallback, useEffect, useRef } from "react";
import { useApprovalStore, type PendingApproval } from "../store/approvalStore";
import { classifyApprovalReply, describeApprovalRequest } from "../services/voice/approvalIntent";
import type { UseVoiceResult } from "./useVoice";

export interface SpokenApproval {
  /**
   * Read an utterance as an answer to the standing prompt.
   *
   * True when it was one and has been acted on — the caller must then drop the
   * text rather than sending it to the model, which would otherwise be asked to
   * do something about the word "yes".
   */
  consume: (text: string) => boolean;
  /** Whether a prompt is being listened for right now — for the hint on the prompt. */
  listening: boolean;
}

/** Is this engine the one with the microphone open? */
function isListening(voice: UseVoiceResult | null): boolean {
  return Boolean(voice && voice.mode === "conversation" && voice.state !== "idle");
}

/**
 * @param voiceRef the pane's own engine, read through a ref because it is built
 * once and re-created never — see `useVoice`.
 */
export function useSpokenApproval(voiceRef: React.MutableRefObject<UseVoiceResult | null>): SpokenApproval {
  const pending = useApprovalStore((state) => state.pending);
  const withdraw = useApprovalStore((state) => state.withdraw);

  /* Which request has already been read out. Without it every re-render of a
     streaming pane would ask the same question again over the top of itself. */
  const spokenFor = useRef<string | null>(null);
  const pendingRef = useRef<PendingApproval | null>(null);
  pendingRef.current = pending;

  const listening = isListening(voiceRef.current);

  useEffect(() => {
    if (!pending) {
      spokenFor.current = null;
      return;
    }
    if (spokenFor.current === pending.id) return;
    const voice = voiceRef.current;
    if (!isListening(voice)) return;
    spokenFor.current = pending.id;
    /*
      `expectsAnswer` is what opens the engine's follow-up window. An aside is
      spoken outside a turn, so nothing else marks the assistant as having just
      asked something — and without that mark the addressing gate reads the
      one-word answer as room noise and never hands it to `consume`.
    */
    void voice?.speakAside(
      describeApprovalRequest({ asker: pending.asker, action: pending.action, alwaysLabel: pending.alwaysLabel }),
      { expectsAnswer: true },
    );
    // `voiceRef` is a ref and `withdraw` a stable store action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, listening]);

  const consume = useCallback(
    (text: string): boolean => {
      const request = pendingRef.current;
      if (!request) return false;
      const verdict = classifyApprovalReply(text);
      if (!verdict) return false;

      /*
        Withdrawn here as well as by the pane that raised it. The pane clears
        its own slot when the answer lands, but that is a round trip through a
        gateway for an agent run, and until it returns the prompt is still
        pending — a second "yes" in that window would answer it twice.
      */
      withdraw(request.id);
      request.answer(verdict === "deny" ? "deny" : "allow", verdict === "allow-always");

      /*
        Said back, briefly. An operator who says "yes" to a machine and hears
        nothing does not know whether it heard them, and says it again louder.
      */
      const voice = voiceRef.current;
      if (isListening(voice)) {
        void voice?.speakAside(
          verdict === "deny" ? "Refused." : verdict === "allow-always" ? "Allowed, and I won't ask again." : "Allowed.",
        );
      }
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [withdraw],
  );

  return { consume, listening };
}
