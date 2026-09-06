/**
 * Switching between conversations.
 *
 * Pure, because the bug it exists to prevent was invisible in the UI: the
 * sidebar's chat rows moved the highlight and left the transcript alone, so
 * the operator clicked a chat and saw nothing happen. Two causes, and both are
 * decided here:
 *
 * - the incoming conversation was loaded **only when it had messages**, so
 *   opening an empty chat kept the previous one on screen. An empty session is
 *   a real answer — it is a conversation nobody has started;
 * - nothing wrote the outgoing conversation back, so leaving a chat discarded
 *   it. Saving on the way out is what makes these rows a history rather than
 *   three labels over one transcript.
 */

export interface StoredSession<M> {
  id: string;
  messages: M[];
}

export interface SessionSwitch<M, S extends StoredSession<M>> {
  sessions: S[];
  messages: M[];
}

/**
 * Move from `fromId` to `toId`: the conversation being left is written back
 * onto its session, and the one being entered is loaded whether or not it has
 * anything in it.
 *
 * An unknown `toId` yields an empty transcript rather than the old one — the
 * one thing that must never happen is a switch that appears not to have
 * happened.
 */
export function applySessionSwitch<M, S extends StoredSession<M>>(
  sessions: S[],
  fromId: string,
  toId: string,
  messages: M[],
): SessionSwitch<M, S> {
  const saved = sessions.map((session) => (session.id === fromId ? { ...session, messages } : session));
  const target = saved.find((session) => session.id === toId);
  return { sessions: saved, messages: target ? target.messages : [] };
}
