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
 * `agentSessionKey` is the **engine** — `claude` or `codex` — and deliberately
 * not the model. The engine has to match, because resuming a Codex thread as
 * Claude Code fails rather than politely starting fresh. The model does not:
 * both CLIs resume a thread under whatever `--model` the new turn names. Keying
 * on `engine:model` threw the conversation away every time the operator moved
 * between two models of the same CLI, which is a routine thing to do in the
 * middle of a task and has never meant "start again".
 *
 * The key is stored beside the id because the id now outlives the mount that
 * made it: before it was persisted, remounting cleared it and the mismatch
 * could not arise, so nothing had to be written down.
 */
export interface AgentThread {
  id: string;
  agentSessionId?: string | null;
  agentSessionKey?: string | null;
  /**
   * Arms the next turn to fork this thread instead of extending it: the CLI
   * answers from the same history and writes that answer to a **new** session
   * id, leaving the thread this chat was forked from untouched. Cleared as soon
   * as a turn reports an id — by then the fork has happened, and leaving it
   * armed would fork again on every turn after it.
   */
  agentForkPending?: boolean;
}

/**
 * The engine half of a session key.
 *
 * Tolerates the `engine:model` form, which is what keys were written in before
 * a model switch was allowed to keep its thread. A stored key from before that
 * change still names its engine, so an upgrade keeps the conversation instead
 * of silently dropping it on the first turn.
 */
function engineOf(key: string): string {
  const colon = key.indexOf(":");
  return colon === -1 ? key : key.slice(0, colon);
}

/**
 * The key naming the agent that owns a chat's thread, or null when there is
 * nothing to own one. Null is also the honest answer for the local lane: it is
 * not a CLI and has no thread to resume.
 *
 * Derived here rather than at each call site because two of them now need it —
 * the composer, which sends the turn, and the picker, which says what the next
 * turn will do — and a key those two disagreed about would show one thing and
 * do another.
 */
export function agentSessionKeyFor(selection: { engine: string } | null | undefined): string | null {
  return selection ? selection.engine : null;
}

/**
 * The id to offer back to the agent for its next turn, or null to start fresh.
 *
 * Null whenever anything is uncertain: no agent selected, no such chat, no
 * thread yet, or a thread belonging to a different engine. Starting fresh costs
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
  if (!session?.agentSessionKey) return null;
  if (engineOf(session.agentSessionKey) !== engineOf(key)) return null;
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
      ? {
          ...session,
          agentSessionId,
          agentSessionKey: agentSessionId ? key : null,
          /*
            Recording an id settles whatever the fork was going to do.

            The id being recorded *is* the fork — the CLI has already answered
            from the parent and written this new thread — so staying armed would
            fork the fork on the next turn, and every turn after it. Forgetting a
            thread disarms it too: there is nothing left to fork from.
          */
          agentForkPending: false,
        }
      : session,
  );
}

/**
 * The fork of one chat: the same transcript and the same agent thread, under a
 * new chat id, armed to diverge on its next turn.
 *
 * Forking into a second chat rather than in place is what makes the control
 * visible. A `--fork-session` turn that quietly moved this chat onto a copy
 * would look exactly like a turn that did nothing — the failure this lane has
 * already shipped once. Two rows in the sidebar, both holding the history up to
 * the split, is what the word promises.
 *
 * Both chats carry the parent's thread id, so they are the same thread until the
 * copy takes a turn. That turn is the one that forks, which is why nothing here
 * has to be undone if the operator never sends it.
 */
export function forkSession<M, S extends AgentThread & StoredSession<M>>(
  source: S,
  id: string,
  messages: M[],
): S {
  return {
    ...source,
    id,
    messages,
    // Nothing to fork from without a thread. The copy is then simply a chat
    // holding the same transcript, and its first turn opens a thread of its own.
    agentForkPending: Boolean(source.agentSessionId),
  };
}

/**
 * The folder name a chat is filed under, from a workspace root.
 *
 * `"No Repo"` is a real group in the sidebar, not a placeholder: it holds the
 * chats whose repository is gone. An empty root belongs there.
 */
export function workspaceLabel(workspacePath: string): string {
  return workspacePath.split("/").filter(Boolean).pop() || "No Repo";
}

/**
 * Moves the active chat to the root the operator has just opened.
 *
 * `workspace` was stamped once, when the chat was made, and nothing ever wrote
 * it again — so opening another repository moved the composer's project chip
 * and left the chat filed where it was born. The two then disagreed on screen,
 * and the sidebar was the one that was wrong: the chat lane sends no `cwd` at
 * all, so `resolveAgentCwd` resolves the turn against the gateway's own
 * workspace root — the very value the chip renders. A chat filed under
 * `teminaliCode` while the chip read `4K Video Downloader+` was a chat whose
 * next turn would have edited the other repository.
 *
 * Re-stamping rewrites history, and that is the accepted cost: the chat's
 * earlier turns did run somewhere else. The alternative was to blind the one
 * control that was telling the truth.
 */
export function restampWorkspace<S extends { id: string; workspace: string }>(
  sessions: S[],
  activeId: string,
  workspacePath: string,
): S[] {
  const label = workspaceLabel(workspacePath);
  return sessions.map((session) => (session.id === activeId ? { ...session, workspace: label } : session));
}
