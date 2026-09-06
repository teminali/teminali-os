/**
 * The one prompt the operator is being asked about, wherever it came from.
 *
 * Two different subsystems stop and ask: the built-in chat's command gate
 * (`hooks/useCommandApproval.ts`) and an agent CLI's permission prompt
 * (`panels/AgentPane.tsx`). Each draws its own prompt in its own pane, and that
 * is right — the transcript above it is the context the decision needs.
 *
 * What neither of them could do is be answered out loud, because the voice
 * engine is a third thing again, built per pane. This store is the seam: a pane
 * that is blocked on a decision publishes it here, and whichever voice engine
 * is actually listening reads it aloud and answers it. See
 * `hooks/useSpokenApproval.ts`.
 *
 * Deliberately one slot rather than a queue. A pane may have several requests
 * stacked up, but only the one in front of the operator can be spoken about
 * without ambiguity — "yes" has to mean the thing they were just read.
 *
 * Not persisted. A pending approval belongs to a live run; restoring one across
 * a restart would offer to allow a command whose process is long gone.
 */

import { create } from "zustand";

/** Who is blocked, and what answering does. */
export interface PendingApproval {
  /** Stable for the life of one request, so it is spoken about exactly once. */
  id: string;
  /** Which subsystem is asking — the two prompts read differently out loud. */
  source: "chat" | "agent";
  /** Who wants it: "Claude Code", "The assistant". */
  asker: string;
  /** What it wants to do: a command line, or a tool name. */
  action: string;
  /** What "always" would cover ("npm", "Bash(git)"), or null when there is no always. */
  alwaysLabel: string | null;
  /**
   * Settle it. The pane owns the answer — this store never resolves anything
   * itself, because the promise, the run and the socket all live over there.
   */
  answer: (behavior: "allow" | "deny", remember: boolean) => void;
}

interface ApprovalState {
  pending: PendingApproval | null;
  /** A pane is now blocked. Replaces whatever was there: one slot, by design. */
  offer: (approval: PendingApproval) => void;
  /**
   * This request is settled or abandoned.
   *
   * Takes the id and ignores a mismatch, because the pane that raised it may
   * withdraw late — after a newer prompt has already taken the slot — and a
   * blind clear would silence a question the operator is still being asked.
   */
  withdraw: (id: string) => void;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  pending: null,
  offer: (approval) => set({ pending: approval }),
  withdraw: (id) => set((state) => (state.pending?.id === id ? { pending: null } : state)),
}));
