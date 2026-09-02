import { useCallback, useEffect, useRef, useState } from "react";
import { createApprovalGate, type AgentCommandRequest, type ApprovalGate } from "../services/agentCommands";

export interface CommandApproval {
  /** The command awaiting a decision, or null when nothing is pending. */
  pending: AgentCommandRequest | null;
  /** Gate passed to AIService; resolves once the user decides. */
  approveCommand: (request: AgentCommandRequest) => Promise<boolean>;
  approve: () => void;
  deny: () => void;
  /** Denies anything outstanding — call when a stream is cancelled. */
  cancel: () => void;
}

/**
 * Bridges the agent's command loop to a human decision. The underlying gate
 * guarantees the promise always settles, so a pending approval can never
 * stall an agent turn — cancellation and unmount both deny.
 */
export function useCommandApproval(): CommandApproval {
  const [pending, setPending] = useState<AgentCommandRequest | null>(null);
  const gateRef = useRef<ApprovalGate | null>(null);
  if (gateRef.current === null) gateRef.current = createApprovalGate(setPending);
  const gate = gateRef.current;

  useEffect(() => () => gate.cancel(), [gate]);

  return {
    pending,
    approveCommand: useCallback((request: AgentCommandRequest) => gate.request(request), [gate]),
    approve: useCallback(() => gate.settle(true), [gate]),
    deny: useCallback(() => gate.settle(false), [gate]),
    cancel: useCallback(() => gate.cancel(), [gate]),
  };
}
