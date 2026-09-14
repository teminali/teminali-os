/**
 * The two things the shell says to the model on the assistant's behalf, and
 * the guard that stops the second of them coming back as speech.
 *
 * These live beside the engine rather than in the stage because they are wire
 * framing: every one of them is text put into a `sendClientContent` turn, and
 * the model reads them. The stage decides WHEN to say them. This decides what
 * they are, so it can be tested against the model's actual behaviour instead
 * of by reading the component's source.
 */

/**
 * What she is told the instant she reaches for the assistant.
 *
 * The `ask_the_assistant` call stays BLOCKING: `behavior` is unset on the
 * declaration in `geminiLiveEngine.ts`, so she can never generate into a turn
 * whose facts have not arrived. What this changes is only WHEN the block ends.
 *
 * It used to end when the agent finished, which on a live call meant she went
 * silent for the whole run. Measured across five delegating turns on
 * 2026-09-12: four emitted no audio and no `outputTranscription` at all before
 * the `toolCall` arrived, while her own thought text read "I'll begin by
 * saying 'One moment.'" She believed she had spoken. The app had turned that
 * line into a toast, which on a voice call is nothing at all.
 *
 * So the block ends at once, with a response that carries no facts: her own
 * note, handed back for her to say. The cost is real and is stated rather than
 * hidden. Between the note and the report she holds the floor with the
 * question still unanswered, and the one thing she must not do there is answer
 * it from nothing. That is what the last line is for.
 */
export function handoffAcknowledgement(note: string): string {
  return [
    "The assistant has started. It has not reported back, so you do not have the answer yet.",
    `Say exactly this to the user, then stop: "${note.trim() || "One moment."}"`,
    "Do not answer the question yourself, do not guess at any part of it, and do not describe what the assistant is doing. Its report will reach you shortly, as a separate message.",
  ].join("\n");
}

/**
 * The report, framed so she answers FROM it rather than reads it out.
 *
 * Deliberately not `sendAssistantDirective`. A directive means "say this
 * line", which is right for a sentence the shell composed and wrong for a
 * report: the tool path was proven on 2026-09-12 by her turning a report into
 * "Lando Norris just won the Abu Dhabi Grand Prix on December 8th, driving for
 * McLaren", and a directive would have had her recite the report instead.
 *
 * The last sentence is the whole of the anti-fabrication contract on this
 * path. She may rephrase what is in the report. She may not add to it.
 */
export function frameAssistantReport(report: string): string {
  const cleanReport = report
    .replace(/(\b[a-zA-Z0-9_-]+)\s+dot\s+(html|css|js|ts|tsx|jsx|json|py|md|txt|sh|yml|yaml|sql|png|jpg|svg)\b/gi, "$1.$2")
    .trim();
  return (
    `[The assistant has reported back: "${cleanReport}"\n` +
    "Answer the user's question now, in one short natural sentence, using only what is in that report. " +
    "Refer to files by their real file names with extensions (e.g. 'index.html', 'style.css'). Never say 'index dot html' or spell out the word 'dot'. " +
    "Do not add any number, name, date, path or version that is not written there.]"
  );
}

/**
 * Our own framed report, arriving back at us as though it were speech.
 *
 * The twin of `GeminiLiveEngine.isAssistantDirectiveEcho`, and here for the
 * same reason: a framed line read as a user turn is classified as work,
 * delegated again, and the loop never closes. On this lane a text turn
 * produces no `inputTranscription`, so neither predicate should ever fire.
 * Both are kept because the cost is a regex and the failure is unbounded.
 */
export function isAssistantReportEcho(text: string): boolean {
  return /^\[\s*The assistant has reported back\b/i.test((text ?? "").trim());
}

/**
 * Frames a prompt delegated from Temi Voice to the background coding assistant.
 *
 * Provides clear context that this request was spoken by an operator to a
 * voice assistant and routed for workspace execution. Instructs the assistant
 * that if the request is conversational, a vocal performance (e.g. singing,
 * chatting), or not an actual file, terminal, or codebase operation, it should
 * NOT attempt to modify workspace files or run commands. Instead, return a
 * concise report stating what it observed so Temi can speak back to the operator.
 */
export function frameVoiceDelegatedTask(task: string): string {
  const clean = (task ?? "").trim();
  return [
    "[VOICE ASSISTANT CONTEXT: This task was spoken by the operator to Temi (voice assistant) and routed to you for workspace action.",
    "If this request is conversational, a vocal performance (e.g. singing, chatting), or not an actual file, terminal, or codebase operation, DO NOT attempt to modify workspace files or run commands. Instead, return a concise report stating what you observed so Temi can speak the answer back to the operator.",
    "IMPORTANT FOR SYSTEM INSPECTIONS: When checking system state, disk space, storage, folder sizes, or test outcomes, ALWAYS report the exact numbers and units found (e.g., 'You have 33 GB free out of 460 GB on your disk' or 'All 14 tests passed'). Never give vague answers like 'storage is fine' without stating the actual figures.]",
    "",
    clean,
  ].join("\n");
}
