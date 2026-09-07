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

/**
 * A chat that has started an agent CLI thread, and which agent owns it.
 *
 * `agentSessionKey` is `engine:model`. It is stored beside the id because the
 * id now outlives the mount that made it: before it was persisted, remounting
 * cleared it and the mismatch could not arise, so nothing had to be written
 * down. Persisted, it can — and resuming a Codex thread as Claude Code fails
 * rather than politely starting fresh.
 */
export interface AgentThread {
  id: string;
  agentSessionId?: string | null;
  agentSessionKey?: string | null;
}

/**
 * The id to offer back to the agent for its next turn, or null to start fresh.
 *
 * Null whenever anything is uncertain: no agent selected, no such chat, no
 * thread yet, or a thread belonging to a different agent. Starting fresh costs
 * the agent its memory of the conversation; resuming the wrong thread fails
 * the turn outright, so the tie goes to fresh.
 */
export function resumableAgentSession<S extends AgentThread>(
  sessions: S[],
  activeId: string,
  key: string | null,
): string | null {
  if (!key) return null;
  const session = sessions.find((entry) => entry.id === activeId);
  if (!session || session.agentSessionKey !== key) return null;
  return session.agentSessionId ?? null;
}

/**
 * Records — or, with a null id, forgets — the agent thread belonging to one
 * chat. Forgetting drops the key too, so a stale key can never outlive the id
 * it described.
 */
export function rememberAgentSession<S extends AgentThread>(
  sessions: S[],
  activeId: string,
  agentSessionId: string | null,
  key: string | null,
): S[] {
  return sessions.map((session) =>
    session.id === activeId
      ? { ...session, agentSessionId, agentSessionKey: agentSessionId ? key : null }
      : session,
  );
}
