import type { ChatMessage, ToolCall } from "../types";

/**
 * Stopping a turn, described once.
 *
 * Interruption used to be four hand-written copies of the same three lines —
 * one in `send()` where a new prompt pre-empts the old run, one in the voice
 * host's `interrupt`, one in `stop()`, one in the stream's own error path —
 * and they had drifted apart. None of them settled a tool call that was still
 * running, so a stopped turn kept a spinner turning under a reply that had
 * finished; none of them marked the reply as cut short, so a half-written
 * answer sat in the transcript looking like the whole answer.
 *
 * The two rules this module exists to hold:
 *
 * 1. **A stopped turn tells the truth about itself.** What arrived is kept —
 *    it is real work and the operator may want it — and it is marked
 *    `cancelled` so the surface can say so. A turn that produced nothing says
 *    `Interrupted.` in its own words, because an empty assistant message is
 *    what the *next* turn carries into the model's history.
 * 2. **Nothing is left mid-flight.** Every tool call still reporting `running`
 *    is settled here, in the same patch that clears `isStreaming`. The process
 *    strip reads its glyphs straight off `status`, so a call left running is a
 *    spinner that never stops.
 *
 * Pure, and deliberately so: this is the one description of what a stopped
 * turn looks like, and it is checked in `tests/interruption.test.mjs` rather
 * than by mounting a chat.
 */

/** What a turn that produced nothing says once it is stopped. */
export const INTERRUPTED_NOTE = "Interrupted.";

/** What a tool call that was still in flight reports once the run is stopped. */
export const INTERRUPTED_TOOL_RESULT = "Stopped by the operator.";

/**
 * Settles the calls that were still running.
 *
 * `error` rather than `completed`: the call did not finish, and a step that
 * reads as done when it was killed halfway is the kind of small lie that makes
 * the whole strip untrustworthy. Its own `result` says who stopped it.
 */
export function settleRunningCalls(calls: ToolCall[] | undefined): ToolCall[] | undefined {
  if (!calls || calls.length === 0) return calls;
  if (!calls.some((call) => call.status === "running")) return calls;
  return calls.map((call) =>
    call.status === "running"
      ? { ...call, status: "error" as const, result: call.result ?? INTERRUPTED_TOOL_RESULT }
      : call,
  );
}

/**
 * The patch that turns a live assistant turn into a stopped one.
 *
 * Returns nothing for a message that is not the assistant's: the store's
 * `updateLastMessageInEngine` writes to whatever sits last in the list, and a
 * stop that lands a beat after a turn settled must not rewrite the operator's
 * own prompt.
 */
export function interruptTurn(
  message: Pick<ChatMessage, "role" | "content" | "toolCalls">,
): Partial<ChatMessage> {
  if (message.role !== "assistant") return {};
  const settled = settleRunningCalls(message.toolCalls);
  return {
    isStreaming: false,
    cancelled: true,
    content: message.content.trim() ? message.content : INTERRUPTED_NOTE,
    // Only when there are calls to write back: the store merges by spread, so
    // an explicit `undefined` would erase a list rather than leave it alone.
    ...(settled ? { toolCalls: settled } : {}),
  };
}

/**
 * Every turn that was still live when the application stopped.
 *
 * A message carries `isStreaming` and the message list is persisted, so a turn
 * in flight when the app quit — or crashed, or was restarted for a `.cjs`
 * change — comes back marked live. Nothing will ever finish it: the process
 * that owned the run died with the app, and the stop button on that row points
 * at a run id nobody holds. The operator sees a spinner that says "Working", a
 * frozen elapsed time, and a stop that does nothing, which reads as the agent
 * having got stuck rather than as the app having been closed underneath it.
 *
 * A restart *is* an interruption, so it is recorded as one — the same patch the
 * Escape key applies, with the same partial answer kept and the same "Stopped —
 * this reply is incomplete" under it. Applied on rehydrate, before any of it is
 * drawn, because there is no moment at which the restored state was true.
 *
 * Returns the same array when there was nothing live, so a rehydrate that
 * changes nothing allocates nothing.
 */
export function settleRestoredTurns<T extends ChatMessage>(messages: T[] | undefined): T[] | undefined {
  if (!messages?.some((message) => message.isStreaming)) return messages;
  return messages.map((message) =>
    message.isStreaming ? { ...message, ...interruptTurn(message) } : message,
  );
}

/** True when the stopped turn left a partial answer, and not only the note. */
export function keptPartialReply(message: Pick<ChatMessage, "content" | "cancelled">): boolean {
  return Boolean(message.cancelled) && message.content.trim() !== INTERRUPTED_NOTE && message.content.trim().length > 0;
}

/**
 * One keystroke, judged.
 *
 * Read off a real `KeyboardEvent` by the shell; a plain object here so the
 * rule can be tested without a DOM.
 */
export interface InterruptKeystroke {
  key: string;
  /** An IME is assembling a character. Escape belongs to the IME, not to us. */
  isComposing?: boolean;
  /** Something nearer the keystroke already claimed it — the composer's / menu. */
  defaultPrevented?: boolean;
  /** The keystroke landed in a text field. */
  inTextField: boolean;
  /** The keystroke landed inside the chat column (`[data-chat-column]`). */
  inChat: boolean;
}

/**
 * Whether Escape should stop the run.
 *
 * The old rule refused whenever a text field had focus, which sounds careful
 * and is the whole bug: the composer is a textarea, it is autofocused, and it
 * still holds focus after a prompt is sent — so the one place the operator
 * actually presses Escape was the one place it was ignored. There is nothing
 * to protect there either; Escape is not an edit, and the draft survives it.
 *
 * What the field guard was really for is the fields that are *not* the chat:
 * the terminal's command line, a search box, a settings input. Those keep
 * Escape. So the question is not "is this a field" but "is this the chat" —
 * which the column already answers, through `[data-chat-column]`.
 */
export function interruptsRun(stroke: InterruptKeystroke): boolean {
  if (stroke.key !== "Escape") return false;
  if (stroke.isComposing) return false;
  if (stroke.defaultPrevented) return false;
  return stroke.inChat || !stroke.inTextField;
}
