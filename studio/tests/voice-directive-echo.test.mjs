/**
 * The shell's own directive must not come back as a user turn.
 *
 * `sendAssistantDirective` is not a user turn, but the pipeline has one way in,
 * so `realtime-voice/code/server.py` wraps the line and delivers it through
 * `on_final` -- the same callback a spoken turn uses. It therefore returns as
 * `final_user_request`, which type alone cannot distinguish from speech.
 *
 * Unguarded that closes a loop, observed live on 2026-09-10: the shell
 * delegates, speaks "On it.", the directive returns as a user turn, the turn
 * switch classifies it as work, and it delegates again -- the activity queue
 * filling with identical tasks while the assistant talks to itself. The Stop
 * button could not win, because each stop was followed by another delegation.
 *
 * The guard is a pure predicate so the loop can be pinned without a socket, a
 * pipeline, or a 2 GB virtualenv.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Realtime8000ProtocolManager } from "../src/services/voice/realtime8000Engine.ts";

const isEcho = (t) => Realtime8000ProtocolManager.isAssistantDirectiveEcho(t);

/** Exactly what server.py builds, so the test fails if either side drifts. */
function asServerWrapsIt(directive) {
  return (
    "[Say this to the user now, in your own voice, warmly and in one or " +
    "two spoken sentences. Do not add any facts that are not in it: " +
    `"${directive}"]`
  );
}

test("the directive server.py builds is recognised as an echo", () => {
  assert.equal(isEcho(asServerWrapsIt("On it.")), true);
  assert.equal(isEcho(asServerWrapsIt("The tests passed.")), true);
  // The loop was driven by the short acknowledgement, so pin that one exactly.
  assert.equal(isEcho(asServerWrapsIt("On it.")), true);
});

test("leading whitespace and casing do not let an echo through", () => {
  assert.equal(isEcho("   " + asServerWrapsIt("Done.")), true);
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
