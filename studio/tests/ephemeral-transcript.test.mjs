import test from "node:test";
import assert from "node:assert/strict";

import {
  selectEphemeralTranscript,
  EPHEMERAL_HOLD_MS,
  EPHEMERAL_FADE_MS,
} from "../src/services/voice/ephemeralTranscript.ts";

const T0 = 1_000_000;

const exchange = [
  { role: "user", content: "how's it going?" },
  { role: "assistant", content: "Two files in, tests haven't run yet." },
];

function select(overrides = {}) {
  return selectEphemeralTranscript({
    history: exchange,
    lastTurnAt: T0,
    now: T0,
    ...overrides,
  });
}

test("shows the last exchange, held, immediately after it settles", () => {
  const view = select();
  assert.equal(view.userLine, "how's it going?");
  assert.equal(view.assistantLine, "Two files in, tests haven't run yet.");
  assert.equal(view.phase, "held");
  assert.equal(view.nextChangeInMs, EPHEMERAL_HOLD_MS);
});

test("nothing at all when there is no history", () => {
  const view = select({ history: [], lastTurnAt: null });
  assert.deepEqual(view, {
    userLine: null,
    assistantLine: null,
    phase: "hidden",
    nextChangeInMs: null,
  });
});

test("a lone user turn shows with no answer yet", () => {
  const view = select({ history: [{ role: "user", content: "run the tests" }] });
  assert.equal(view.userLine, "run the tests");
  assert.equal(view.assistantLine, null);
});

test("an opening greeting shows without inventing a user line", () => {
  const view = select({ history: [{ role: "assistant", content: "I'm right here with you." }] });
  assert.equal(view.userLine, null);
  assert.equal(view.assistantLine, "I'm right here with you.");
});

test("only the last exchange survives — earlier turns are never shown", () => {
  const view = select({
    history: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      ...exchange,
    ],
  });
  assert.equal(view.userLine, "how's it going?");
  assert.equal(view.assistantLine, "Two files in, tests haven't run yet.");
});

test("two assistant turns in a row do not borrow a stale user line", () => {
  const view = select({
    history: [
      { role: "user", content: "start the build" },
      { role: "assistant", content: "On it." },
      { role: "assistant", content: "Build's green." },
    ],
  });
  assert.equal(view.userLine, null);
  assert.equal(view.assistantLine, "Build's green.");
});

test("live speech replaces the previous exchange outright", () => {
  const view = select({ liveUserSpeech: "stop tal" });
  assert.equal(view.userLine, "stop tal");
  assert.equal(view.assistantLine, null, "the old answer must not sit under a new question");
  assert.equal(view.phase, "held");
  assert.equal(view.nextChangeInMs, null);
});

test("a streaming answer shows under the question that prompted it", () => {
  const view = select({ liveAssistantStream: "Two files" });
  assert.equal(view.userLine, "how's it going?");
  assert.equal(view.assistantLine, "Two files");
  assert.equal(view.phase, "held");
});

test("live speech wins over a streaming answer — she has been interrupted", () => {
  const view = select({ liveUserSpeech: "stop", liveAssistantStream: "Two files" });
  assert.equal(view.userLine, "stop");
  assert.equal(view.assistantLine, null);
});

test("nothing fades out from under her voice", () => {
  const view = select({ isSpeaking: true, now: T0 + EPHEMERAL_HOLD_MS + EPHEMERAL_FADE_MS + 5000 });
  assert.equal(view.phase, "held");
  assert.equal(view.nextChangeInMs, null);
  assert.equal(view.assistantLine, "Two files in, tests haven't run yet.");
});

test("still held one millisecond before the hold expires", () => {
  const view = select({ now: T0 + EPHEMERAL_HOLD_MS - 1 });
  assert.equal(view.phase, "held");
  assert.equal(view.nextChangeInMs, 1);
});

test("fades once the hold expires, and reports the remaining fade", () => {
  const view = select({ now: T0 + EPHEMERAL_HOLD_MS });
  assert.equal(view.phase, "fading");
  assert.equal(view.nextChangeInMs, EPHEMERAL_FADE_MS);
  assert.equal(view.assistantLine, "Two files in, tests haven't run yet.", "text stays put while it fades");
});

test("gone once the fade completes", () => {
  const view = select({ now: T0 + EPHEMERAL_HOLD_MS + EPHEMERAL_FADE_MS });
  assert.deepEqual(view, {
    userLine: null,
    assistantLine: null,
    phase: "hidden",
    nextChangeInMs: null,
  });
});

test("custom hold and fade windows are honoured", () => {
  const view = select({ now: T0 + 900, holdMs: 500, fadeMs: 1000 });
  assert.equal(view.phase, "fading");
  assert.equal(view.nextChangeInMs, 600);
});

test("holds when the turn has no timestamp yet", () => {
  const view = select({ lastTurnAt: null, now: T0 + 999_999 });
  assert.equal(view.phase, "held");
  assert.equal(view.nextChangeInMs, null);
});

test("a clock that runs backwards holds rather than hiding", () => {
  const view = select({ now: T0 - 5000 });
  assert.equal(view.phase, "held");
});

test("the selector never mutates the history it is handed", () => {
  const history = [...exchange];
  const snapshot = JSON.stringify(history);
  select({ history });
  assert.equal(JSON.stringify(history), snapshot);
});
