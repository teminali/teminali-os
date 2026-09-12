/**
 * A superseded generation is silent. Until now it was not silent on screen.
 *
 * `sendBargeIn()` is a LOCAL guard: Gemini Live has no "cancel this
 * generation" message, so when the shell decides to answer a turn itself the
 * model carries on generating server-side and the engine simply stops
 * forwarding what arrives. The generation counter is what makes that precise,
 * and it gated the AUDIO only. Her WORDS went through ungated, so the
 * abandoned turn still became her caption and still went into
 * `final_assistant_answer`.
 *
 * Measured on a live call, 2026-09-12. The shell barged in and answered from
 * the agent's report, and the operator got one line reading "It is not
 * something I keep an eye on directly.38 gigabytes.": the abandoned
 * conversational turn and the directed answer accumulated into the same
 * `outputTranscript` with nothing between them. The missing space is the tell.
 *
 * Two things are pinned here. The gate exists and is written against the same
 * counter the audio uses, and it is `incomingGeneration()` rather than
 * `this.generation`, which is the subtlety of the whole fix: the transcript
 * branch runs BEFORE the chunk block that mints a new turn's generation, so
 * comparing directly would judge a condemned turn's first words against the
 * previous turn's number and let exactly the measured line through. And
 * `finalizeUserTurn()` stays outside the gate, because her first word is the
 * only proof the operator's turn ended and a turn dropped there never reaches
 * the router at all.
 *
 * The engine opens a socket in its constructor and cannot be instantiated in
 * this suite, so what is pinned is the arrangement of the source. That is the
 * same approach `voice-transcript-render.test.mjs` takes to the transcript
 * component, and for the same reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const engine = await readFile(new URL("../src/services/voice/geminiLiveEngine.ts", import.meta.url), "utf8");

/** The body of the `if (outputText)` branch, where the transcript is handled. */
function transcriptBranch() {
  const start = engine.indexOf("const outputText = content?.outputTranscription?.text;");
  assert.ok(start > 0, "the transcript branch has moved or gone");
  const body = engine.slice(start, engine.indexOf("// Audio arrives on the SDK fast path", start));
  assert.ok(body.length > 0, "could not find the end of the transcript branch");
  return body;
}

test("her words are gated on the generation her audio is gated on", () => {
  const body = transcriptBranch();
  const gate = body.indexOf("if (this.incomingGeneration() !== this.suppressedGeneration)");
  assert.ok(gate > 0, "the transcript is ungated again, and a superseded turn is back on screen");
  const accumulate = body.indexOf("this.outputTranscript += outputText");
  const emit = body.indexOf('type: "partial_assistant_answer"');
  assert.ok(accumulate > gate, "the transcript accumulates before the gate, so suppression does nothing");
  assert.ok(emit > gate, "the caption is emitted before the gate");
});

test("the gate asks incomingGeneration, not the raw counter", () => {
  const body = transcriptBranch();
  // `this.generation` names the PREVIOUS turn at the first transcript delta of
  // a new one, because the chunk block below is the only place `turnActive`
  // flips. Comparing it here is the exact mistake that leaves the words of a
  // condemned turn on screen while dropping its audio.
  assert.doesNotMatch(
    body,
    /if \(this\.generation !== this\.suppressedGeneration\)/,
    "the transcript gate reads the raw counter and will mis-judge the first delta of a turn",
  );
  assert.match(engine, /private incomingGeneration\(\): number \{/, "incomingGeneration has gone");
  // The barge-in must condemn the same number the gate later tests, or the two
  // drift apart the moment either is edited.
  assert.match(
    engine,
    /this\.suppressedGeneration = this\.incomingGeneration\(\);/,
    "sendBargeIn no longer condemns the generation the gates are asked about",
  );
});

test("the operator's turn is still finalised when her words are dropped", () => {
  const body = transcriptBranch();
  const finalize = body.indexOf("this.finalizeUserTurn();");
  const gate = body.indexOf("if (this.incomingGeneration() !== this.suppressedGeneration)");
  assert.ok(finalize > 0, "finalizeUserTurn has gone from the transcript branch");
  assert.ok(
    finalize < gate,
    "finalizeUserTurn moved inside the suppression gate: a barged-in turn is now lost to the router",
  );
});

test("the turnComplete question is recorded as measured, not as open", () => {
  // The guard `if (this.pendingToolCalls.size) return;` is correct and, on this
  // model, never fires. Twelve harness sessions on 2026-09-12 saw exactly one
  // `turnComplete` per delegating turn, after the function response was
  // answered and she had stopped speaking. A comment calling that unverified is
  // a comment that invites someone to re-measure what has been measured.
  assert.doesNotMatch(engine, /was not verified\s*\n?\s*\*?\s*here/i, "the stale unverified note is back");
  assert.match(engine, /if \(this\.pendingToolCalls\.size\) return;/, "the guard itself has gone");
  assert.match(engine, /generationComplete/, "the measured frame order is no longer recorded");
});
