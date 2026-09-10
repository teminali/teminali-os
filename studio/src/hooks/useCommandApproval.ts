import { useCallback, useEffect, useRef, useState } from "react";
import { createApprovalGate, type AgentCommandRequest, type ApprovalGate } from "../services/agentCommands";
import { useStudioStore } from "../store/studioStore";

export interface CommandApproval {
  /** The command awaiting a decision, or null when nothing is pending. */
  pending: AgentCommandRequest | null;
  /** Gate passed to AIService; resolves once the user decides. */
  approveCommand: (request: AgentCommandRequest) => Promise<boolean>;
  /** `remember` allows every later command with the same executable. */
  approve: (remember?: boolean) => void;
  deny: () => void;
  /** Denies anything outstanding — call when a stream is cancelled. */
  cancel: () => void;
}

/**
 * Bridges the agent's command loop to a human decision. The underlying gate
 * guarantees the promise always settles, so a pending approval can never
 * stall an agent turn — cancellation and unmount both deny.
 *
 * The gate's "always allow" answers are kept in preferences rather than in the
 * gate, because an answer the operator can neither see nor take back is not
 * really an answer. That makes the stored list the truth and the gate a mirror
 * of it: a grant is pushed out to the store, and the store is pushed back in
 * whenever it changes, so deleting an entry in settings stops it allowing
 * things immediately rather than at the next launch.
 */
export function useCommandApproval(): CommandApproval {
  const [pending, setPending] = useState<AgentCommandRequest | null>(null);
  const allowlist = useStudioStore((state) => state.preferences.commandAllowlist);
  const gateRef = useRef<ApprovalGate | null>(null);
  /* Read through a ref so the gate's callback never closes over a stale list —
     it outlives every render, and the store's own setter is the one that
     merges. */
  const allowlistRef = useRef(allowlist);
  allowlistRef.current = allowlist;

  if (gateRef.current === null) {
    gateRef.current = createApprovalGate(setPending, {
      allowlist,
      onRemember: (scope) =>
        useStudioStore.getState().setPreferences({
          commandAllowlist: [...allowlistRef.current, scope],
        }),
    });
  }
  const gate = gateRef.current;

  useEffect(() => gate.replaceAllowlist(allowlist), [gate, allowlist]);
  useEffect(() => () => gate.cancel(), [gate]);

  return {
    pending,
    approveCommand: useCallback((request: AgentCommandRequest) => gate.request(request), [gate]),
    approve: useCallback((remember = false) => gate.settle(true, remember), [gate]),
    deny: useCallback(() => gate.settle(false), [gate]),
    cancel: useCallback(() => gate.cancel(), [gate]),
  };
}
