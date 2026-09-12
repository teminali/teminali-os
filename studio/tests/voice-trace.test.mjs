/**
 * The ring a dead spoken turn is diagnosed from must not lie about itself.
 *
 * `voiceTrace.ts` exists because the live command on 2026-09-12 died with no
 * evidence at all: a spoken turn can end silently in four different places,
 * the renderer's state does not survive a restart, and "nothing happened" was
 * the only record left behind. The fix is a bounded ring, published on
 * `window.__temiVoiceTrace`, read after the fact by whoever is attached over
 * CDP — not necessarily whoever was in the room when it failed.
 *
 * That reader only ever gets a snapshot, taken later, of something that
 * happened earlier. Everything pinned in this file is here because getting it
 * wrong turns that snapshot into a MISLEADING one rather than an absent one,
 * which is worse than having no trace at all:
 *
 * - order has to survive intact. A snapshot read out of order tells a story
 *   that never happened.
 * - the ring drops the OLDEST entry once it is full, never the newest and
 *   never itself. The turn being diagnosed is always the last one attempted,
 *   so a bound that protects old entries at the newest one's expense protects
 *   the wrong end of the ring.
 * - `clearVoiceTrace` has to actually empty it, or a stale entry from a
 *   previous session reads as evidence about this one.
 * - `traceVoice` can never throw. It sits between a microphone event and a
 *   workspace switch (`TemiVoiceStage.tsx`), fed values it does not control —
 *   whatever Gemini transcribed, whatever a store snapshot happened to hold at
 *   that instant. A diagnostic that can throw on odd input does not just fail
 *   to record — it takes the spoken turn down with it, which is strictly
 *   worse than the silent failure it exists to explain.
 * - the module has to import cleanly with no `window` at all, because that is
 *   exactly what this test file's own process is. If the guard at the bottom
 *   of `voiceTrace.ts` ever regresses, every test below fails at the import
 *   line — and that failure mode is itself the first thing worth knowing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { traceVoice, voiceTraceEvents, clearVoiceTrace } from "../src/services/voice/voiceTrace.ts";

/* ── Import survives with no `window` ────────────────────────────────────── */

test("the module imports cleanly with no `window`, which is what this process is", () => {
  assert.equal(
    typeof window,
    "undefined",
    "documents the environment the rest of this file runs under: a node test has no window, same as the failure this trace is read from over CDP has no one watching live",
  );
  assert.equal(typeof traceVoice, "function", "the import must succeed even with nothing to publish onto");
  assert.equal(typeof voiceTraceEvents, "function", "the import must succeed even with nothing to publish onto");
  assert.equal(typeof clearVoiceTrace, "function", "the import must succeed even with nothing to publish onto");

  clearVoiceTrace();
  traceVoice("heard", { text: "still works with no window to publish onto" });
  assert.equal(voiceTraceEvents().length, 1, "voiceTraceEvents must work whether or not the window guard ran");
});

/* ── Shape and order ──────────────────────────────────────────────────────── */

test("events append in call order, each carrying a stage, a detail, and an ISO timestamp", () => {
  clearVoiceTrace();
  traceVoice("heard", { text: "open dukabot" });
  traceVoice("turn", { source: "spoken", busy: false });
  traceVoice("dropped", { by: "directive-echo" });

  const events = voiceTraceEvents();
  assert.equal(events.length, 3, "all three calls must be recorded");
  assert.deepEqual(
    events.map((event) => event.stage),
    ["heard", "turn", "dropped"],
    "events must stay in call order; a trace that can reorder them tells a story that never happened",
  );
  assert.deepEqual(events[0].detail, { text: "open dukabot" });
  assert.deepEqual(events[1].detail, { source: "spoken", busy: false });
  assert.deepEqual(events[2].detail, { by: "directive-echo" });

  for (const event of events) {
    assert.equal(typeof event.at, "string", "`at` must be a string timestamp");
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.at),
      `"${event.at}" must be ISO 8601 (Date#toISOString): the one format a reader can sort and compare without guessing the source's local time`,
    );
  }
});

/* ── The bound: 40, oldest out, newest always survives ───────────────────── */

test("the ring is bounded at 40 and drops the oldest, never the newest", () => {
  clearVoiceTrace();
  for (let i = 0; i < 45; i += 1) {
    traceVoice("turn", { i });
  }

  const events = voiceTraceEvents();
  assert.equal(events.length, 40, "the ring must never grow past its limit");
  assert.equal(
    events[0].detail.i,
    5,
    "the five oldest calls (i = 0..4) must be the ones dropped once the ring is full",
  );
  assert.equal(
    events[events.length - 1].detail.i,
    44,
    "the most recent call must always survive: the failure being diagnosed is always the most recent thing tried",
  );
});

test("clearVoiceTrace empties the ring", () => {
  clearVoiceTrace();
  traceVoice("heard", { text: "hello" });
  assert.equal(voiceTraceEvents().length, 1);

  clearVoiceTrace();
  assert.equal(voiceTraceEvents().length, 0, "a stale entry from a previous session must not survive a clear");
});

/* ── traceVoice never throws ──────────────────────────────────────────────── */

test("traceVoice never throws on a missing detail or a non-string/nullish stage", () => {
  clearVoiceTrace();

  assert.doesNotThrow(() => traceVoice("heard"), "no detail argument must fall back quietly, not throw");
  assert.deepEqual(voiceTraceEvents().at(-1)?.detail, {}, "the fallback detail must be an empty object, not undefined");

  // TypeScript refuses these at the call site in TemiVoiceStage.tsx, but this
  // function sits at a runtime boundary this ring exists precisely because
  // things go wrong on -- a WebSocket payload, a store snapshot taken mid
  // turn. The runtime has to be safe regardless of what the type contract
  // promises, because the whole point of this ring is to survive the case
  // where something upstream did not behave.
  assert.doesNotThrow(() => traceVoice(42), "a numeric stage must not throw");
  assert.doesNotThrow(() => traceVoice(null), "a null stage must not throw");
  assert.doesNotThrow(() => traceVoice(undefined), "an undefined stage must not throw");
  assert.doesNotThrow(() => traceVoice(""), "an empty-string stage must not throw");
  assert.equal(voiceTraceEvents().length, 5, "every odd call above must still have been recorded, not swallowed");
});

test("traceVoice never throws on a weird or cyclic detail object", () => {
  clearVoiceTrace();

  const cyclic = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(
    () => traceVoice("turn", cyclic),
    "a self-referential detail must not throw merely by being stored in the ring",
  );

  const weird = {
    fn: () => {},
    sym: Symbol("x"),
    big: 10n,
    err: new Error("boom"),
    nested: { deep: { deeper: [1, 2, { three: 3 }] } },
  };
  assert.doesNotThrow(
    () => traceVoice("turn", weird),
    "a function, symbol, bigint, Error and nested structure must not throw when merely stored",
  );

  assert.equal(voiceTraceEvents().length, 2, "both odd calls above must still have been recorded, not swallowed");
});
