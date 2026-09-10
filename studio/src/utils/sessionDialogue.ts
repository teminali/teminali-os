import type { ChatMessage } from "../types";
import type { DialogueTurn } from "../components/voice/TemiTranscript";

/**
 * The voice stage's transcript, as a chat session — and back again.
 *
 * The stage kept its conversation in a `useState` of its own, which meant the
 * sidebar's chat history could not open anything: clicking a row moved the
 * highlight, `switchSession` faithfully swapped `frontierMessages`, and the
 * screen went on rendering the same local array it had rendered before. Every
 * chat showed the same conversation and a reload lost all of them. Making the
 * store the source of truth is what turns those rows into chats you can
 * actually return to.
 *
 * Two shapes meet here. `ChatMessage` is what a session persists — it carries
 * timestamps and per-turn telemetry. `DialogueTurn` is what the transcript
 * draws, and knows only who spoke, what they said, and whether they are still
 * saying it.
 */

/**
 * The id of the seeded greeting.
 *
 * Named here rather than matched by its text: the stage tests emptiness with
 * `turns[0]?.id === "init-temi"`, so the id is already load-bearing in two
 * places and a third copy of the literal is one rename away from a bug.
 */
export const GREETING_ID = "init-temi";

/**
 * The turns to draw for one session's messages.
 *
 * An empty session renders `greeting` rather than nothing, because an empty
 * transcript is not what "you have not started this chat" looks like — the
 * landing hero is. The greeting is synthesised on the way out and dropped on
 * the way back in, so it is never stored: a chat that holds only a greeting
 * would no longer count as empty, and the hero would never show again.
 *
 * `system` messages are not drawn. The transcript has two columns, you and the
 * assistant, and a system note belongs to neither.
 */
export function dialogueFromMessages(messages: ChatMessage[], greeting: DialogueTurn[]): DialogueTurn[] {
  const turns = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: message.id,
      role: message.role as "user" | "assistant",
      content: message.content,
    }));
  return turns.length ? turns : greeting;
}

/**
 * The messages to store for one session's turns.
 *
 * `previous` is read, not replaced: a turn that was already stored keeps the
 * fields the transcript never knew about — what it cost, how long it took, how
 * many tokens it burned. Round-tripping through the stage would otherwise
 * quietly strip the telemetry off every message in the chat you are looking at.
 *
 * Dropped: turns still being spoken (`pending`), which are live state and not
 * yet anything anyone said, and the synthesised greeting, which was never a
 * message. Both would survive a reload as real history if they were kept.
 */
export function messagesFromDialogue(turns: DialogueTurn[], previous: ChatMessage[]): ChatMessage[] {
  const known = new Map(previous.map((message) => [message.id, message]));
  return turns
    .filter((turn) => !turn.pending && turn.id !== GREETING_ID)
    .map((turn) => {
      const existing = known.get(turn.id);
      if (existing) {
        return existing.content === turn.content ? existing : { ...existing, content: turn.content };
      }
      return {
        id: turn.id,
        role: turn.role,
        content: turn.content,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      } satisfies ChatMessage;
    });
}

