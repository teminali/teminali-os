import { FrontierEngine } from "../frontierEngine";
import type { CompleteFn } from "./temiMemoryExtract.ts";

/**
 * The model that reads the transcript, and the only file in the memory layer
 * that knows which one it is.
 *
 * `temiMemoryExtract.ts` takes its model as an argument on purpose, so the
 * choice lives here, at the edge, where it can be argued with without touching
 * the prompt or the parser. Three things decided it.
 *
 * **Local, not Gemini.** She talks over Gemini Live, so the transcript has
 * already left the machine and privacy is not the argument. Cost and silence
 * are. This runs after every conversation, forever, on a growing transcript,
 * and it produces nothing anyone is waiting for. A lane like that should not
 * bill and should not fail when the network does.
 *
 * **Flash, through the digest lane.** `streamDigest` is already the shape this
 * needs: one prompt, no agent system prompt, no history, no tool loop. Reusing
 * it also means the memory pass reuses whatever runner Ollama already has
 * resident from the reply lane, rather than forcing a `num_ctx` change, which
 * was measured at 1.5 to 2.4 s of reload.
 *
 * **Its own deadline, not the caller's.** This is the subtle one. The pass is
 * started from the voice screen's teardown, so the obvious signal to pass in is
 * the one that just fired, which would abort the extraction before it read a
 * word. The pass outlives the screen that started it by design, so it carries a
 * clock of its own.
 */

/**
 * How long the pass may take before it is abandoned.
 *
 * Generous because nothing is waiting: a whole transcript through a local model
 * is tens of seconds, and the only cost of being patient is a background
 * generation nobody sees. Bounded because an Ollama that has wedged should not
 * leave a promise pending for the life of the app.
 */
export const MEMORY_EXTRACTION_TIMEOUT_MS = 120_000;

export function temiMemoryModel(timeoutMs = MEMORY_EXTRACTION_TIMEOUT_MS): CompleteFn {
  return async (prompt, maxTokens) => {
    let reply = "";
    await FrontierEngine.streamDigest(prompt, {
      signal: AbortSignal.timeout(timeoutMs),
      maxTokens,
      onToken: (token) => {
        reply += token;
      },
    });
    return reply;
  };
}
