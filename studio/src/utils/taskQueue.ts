/**
 * What a second instruction does while the first one is still running.
 *
 * It used to kill it. `delegateTask` opened with `this.activeController?.abort()`,
 * so a second Enter mid-turn silently ended the turn in flight and started
 * another — no note in the transcript, no entry in the activity log, just work
 * that stopped happening. Both agent CLIs queue instead, and so does this.
 *
 * Pure, so the rules are checked without a bridge, a store or a socket. The
 * bridge holds the array; this decides what may go into it.
 */

export interface QueuedTask {
  id: string;
  prompt: string;
}

/** Why a prompt did not join the queue. `null` means it did. */
export type QueueRejection = "empty" | "duplicate" | "full";

/**
 * Deep enough to hold a train of thought, shallow enough that a queue is still
 * something an operator can hold in their head. Past this the honest answer is
 * that the run is not keeping up, and silently accepting a tenth prompt hides
 * that.
 */
export const QUEUE_LIMIT = 8;

/** Discriminated so a caller that checks `accepted` gets a narrowed `reason`. */
export type EnqueueResult<T> =
  | { queue: T[]; accepted: true; reason: null }
  | { queue: T[]; accepted: false; reason: QueueRejection };

export function enqueueTask<T extends QueuedTask>(queue: readonly T[], task: T): EnqueueResult<T> {
  const clean = task.prompt.trim();
  if (!clean) return { queue: [...queue], accepted: false, reason: "empty" };
  // A double Enter on the same text is a slip, not two requests. The run in
  // flight is not checked against — re-asking for something already underway is
  // a legitimate thing to want, and only the queue is ours to deduplicate.
  if (queue.some((entry) => entry.prompt.trim() === clean)) {
    return { queue: [...queue], accepted: false, reason: "duplicate" };
  }
  if (queue.length >= QUEUE_LIMIT) return { queue: [...queue], accepted: false, reason: "full" };
  return { queue: [...queue, { ...task, prompt: clean }], accepted: true, reason: null };
}

/** The next task, and the queue without it. FIFO: order is the operator's. */
export function dequeueTask<T extends QueuedTask>(queue: readonly T[]): { queue: T[]; next: T | null } {
  if (queue.length === 0) return { queue: [], next: null };
  return { queue: queue.slice(1), next: queue[0] };
}

/**
 * What the toast says.
 *
 * The count is the point — "Queued" alone leaves the operator unable to tell a
 * queue of one from a queue of five, which is exactly when they want to know.
 */
export function describeQueue(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "Queued — 1 waiting" : `Queued — ${count} waiting`;
}

/** What the operator is told when the prompt was turned away. */
export function describeRejection(reason: QueueRejection): string {
  if (reason === "duplicate") return "Already queued";
  if (reason === "full") return `Queue is full — ${QUEUE_LIMIT} waiting`;
  return "";
}
