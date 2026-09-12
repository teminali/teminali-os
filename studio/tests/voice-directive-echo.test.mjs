/**
 * The shell's own directive must not come back as a user turn.
 *
 * `sendAssistantDirective` is not a user turn, but the lane has one way in, so
 * the directive is wrapped and delivered to the model as text. On the Gemini
 * Live lane a text turn produces no input transcription, so the wrapped line
 * cannot return as `final_user_request` the way the retired :8000 pipeline
 * delivered it -- the loop below cannot form the same way there.
 *
 * The guard stays anyway, for two reasons. The wrapper is still the shape the
 * shell puts on the wire, so anything that ever echoes a model turn back into
 * the transcript -- a resumed session, a replayed history, an ASR that hears
 * the speaker -- reintroduces exactly this input. And the failure it prevents
 * was expensive: observed live on 2026-09-10, the shell delegates, speaks
 * "On it.", the directive returns as a user turn, the turn switch classifies it
 * as work, and it delegates again -- the activity queue filling with identical
 * tasks while the assistant talks to itself. The Stop button could not win,
 * because each stop was followed by another delegation.
 *
 * The guard is a pure predicate, so the loop can be pinned without a socket, a
 * session, or an API key.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { GeminiLiveEngine } from "../src/services/voice/geminiLiveEngine.ts";

const isEcho = (t) => GeminiLiveEngine.isAssistantDirectiveEcho(t);

/** Exactly what the shell wraps a directive in, so the test fails if either side drifts. */
function asTheShellWrapsIt(directive) {
  return (
    "[Say this to the user now, in your own voice, warmly and in one or " +
    "two spoken sentences. Do not add any facts that are not in it: " +
    `"${directive}"]`
  );
}

test("the directive the shell builds is recognised as an echo", () => {
  assert.equal(isEcho(asTheShellWrapsIt("On it.")), true);
  assert.equal(isEcho(asTheShellWrapsIt("The tests passed.")), true);
  // The loop was driven by the short acknowledgement, so pin that one exactly.
  assert.equal(isEcho(asTheShellWrapsIt("On it.")), true);
});

test("leading whitespace and casing do not let an echo through", () => {
  assert.equal(isEcho("   " + asTheShellWrapsIt("Done.")), true);
  assert.equal(isEcho("[say this to the user now: \"Done.\"]"), true);
});

test("real speech is never mistaken for a directive", () => {
  // The words alone are not the signal -- the bracketed opening is.
  assert.equal(isEcho("say this to the user now please"), false);
  assert.equal(isEcho("Can you say this to the user now?"), false);
  assert.equal(isEcho("What is on my screen?"), false);
});

test("other bracketed artefacts are left alone", () => {
  // transcriptRepair owns these; this guard must not swallow them.
  assert.equal(isEcho("[keyboard clicking]"), false);
  assert.equal(isEcho("[upbeat music]"), false);
});

test("empty and missing input are not echoes", () => {
  assert.equal(isEcho(""), false);
  assert.equal(isEcho("   "), false);
  assert.equal(isEcho(undefined), false);
  assert.equal(isEcho(null), false);
});
