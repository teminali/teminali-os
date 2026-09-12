/**
 * Why a spoken turn did nothing.
 *
 * The spoken path has four places that can end a turn by returning, and all
 * four look identical to the operator: he says a sentence and the shell sits
 * there. Two echo filters drop the transcript before it is ever seen
 * (`TemiVoiceStage.tsx`), `parseWorkspaceCommand` refuses by design and returns
 * null, and the `!busy` gate falls through to conversation. None of them wrote
 * anything down, so the live call on 2026-09-12 failed with no evidence left
 * behind at all: the renderer state died with the restart and the only record
 * was the operator's word that nothing happened.
 *
 * This is the record. It is deliberately NOT a console log. A log is only
 * readable by whoever is attached to the console at the moment it is printed,
 * and the whole difficulty here is that the failure happens while the operator
 * is talking and is inspected afterwards, over CDP, by someone who was not
 * watching. A bounded ring on `window` can be read at any point after the fact,
 * which is what this failure needs.
 *
 * It records what was HEARD, which is the datum the whole diagnosis turns on:
 * "open the 4K video downloader folder" resolves and "open the 4K video
 * downloader PLUS folder" does not, and nothing downstream can tell you which
 * one the microphone actually produced.
 */

/** One thing that happened to a spoken turn, in the order it happened. */
export type VoiceTraceEvent = {
  /** Wall clock, so a trace can be lined up against what he remembers saying. */
  at: string;
  /** `heard`, `dropped`, or `turn`. Free-form on purpose; this is a diagnostic. */
  stage: string;
  detail: Record<string, unknown>;
};

/**
 * Forty is enough to hold a conversation's worth of turns and small enough that
 * a transcript ring is not a memory question. The old events go, not the new
 * ones: the failure being diagnosed is always the most recent thing he tried.
 */
const LIMIT = 40;

const events: VoiceTraceEvent[] = [];

/** The ring, for a test or a CDP read. Newest last. */
export function voiceTraceEvents(): readonly VoiceTraceEvent[] {
  return events;
}

export function clearVoiceTrace(): void {
  events.length = 0;
}

/**
 * Record one step of a spoken turn.
 *
 * Never throws and never returns anything a caller could branch on. It sits on
 * the path between a microphone and a workspace switch, and a diagnostic that
 * can change what that path does is worse than no diagnostic.
 */
export function traceVoice(stage: string, detail: Record<string, unknown> = {}): void {
  events.push({ at: new Date().toISOString(), stage, detail });
  if (events.length > LIMIT) events.splice(0, events.length - LIMIT);

}

/* Published at import, not on first event, and that timing is the point: an
   empty `window.__temiVoiceTrace` says the voice stage is mounted and heard
   nothing, while a MISSING one says this build is not even running. Those two
   need opposite next steps and the operator cannot tell them apart. Guarded
   because a node test imports this module with no `window`. */
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__temiVoiceTrace = events;
}
