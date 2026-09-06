import { useCallback, useEffect, useRef, useState } from "react";
import { createAskGate, type AskAnswer, type AskGate, type AskQuestion } from "../services/askToolCalls";

export interface AskOperator {
  /** The questions awaiting an answer, or null when nothing is pending. */
  pending: AskQuestion[] | null;
  /** Executor passed to the engine; resolves once the operator decides. */
  askOperator: (questions: AskQuestion[]) => Promise<AskAnswer[] | null>;
  /** Submit the operator's choices. */
  answer: (answers: AskAnswer[]) => void;
  /** Dismiss without answering — the model is told to pick a default. */
  dismiss: () => void;
  /** Dismisses anything outstanding — call when a stream is cancelled. */
  cancel: () => void;
}

/**
 * Bridges the agent's ask fence to a human decision.
 *
 * The sibling of `useCommandApproval`, and it keeps that hook's one guarantee:
 * the underlying gate always settles, so a pending question can never stall an
 * agent turn — cancellation and unmount both dismiss.
 */
export function useAskOperator(): AskOperator {
  const [pending, setPending] = useState<AskQuestion[] | null>(null);
  const gateRef = useRef<AskGate | null>(null);
  if (gateRef.current === null) gateRef.current = createAskGate(setPending);
  const gate = gateRef.current;

  useEffect(() => () => gate.cancel(), [gate]);

  return {
    pending,
    askOperator: useCallback((questions: AskQuestion[]) => gate.request(questions), [gate]),
    answer: useCallback((answers: AskAnswer[]) => gate.settle(answers), [gate]),
    dismiss: useCallback(() => gate.settle(null), [gate]),
    cancel: useCallback(() => gate.cancel(), [gate]),
  };
}
