/**
 * How the voice transcript renders text, as distinct from what it renders.
 *
 * Two halves, tested two ways.
 *
 * The caption pacer is a class with no DOM in it, so it is exercised directly.
 * The fragment sizes in the first test are not invented: they are what Gemini's
 * `outputTranscription` sends at the start of a turn — one short word, then the
 * rest of the sentence — and against the default 14.5 chars/sec they blanked
 * the caption for ~100ms on the first word of every turn.
 *
 * `TemiTranscript` is React and cannot be mounted by this suite, so the
 * property pinned there is an arrangement rather than a behaviour. Rendered
 * through react-dom/server during the audit on 2026-09-12, a turn with empty
 * content produced, on the operator's side, a `bg-[#06512f] px-5 py-3.5`
 * element with no children — a green pill with 40px of padding and nothing in
 * it — and on Temi's side an empty block that still spent the column's
 * `gap-8`, which is a 32px hole between two things she said. Neither is
 * hypothetical: the chat panel appends an empty assistant message as its
 * streaming placeholder into the very array this transcript draws.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CaptionPacer } from "../src/services/voice/captionPacer.ts";

const transcript = readFileSync(
  new URL("../src/components/voice/TemiTranscript.tsx", import.meta.url),
  "utf8",
);

test("the caption does not blank when a fragment lands on a word it has already shown", () => {
  const pacer = new CaptionPacer();
  pacer.beginTurn();

  // Fragment one. Short enough that the playback budget covers all of it, so
  // it is returned whole — there is no later word to hold the boundary back.
  pacer.setText("Sure");
  assert.equal(pacer.advanceTo(0.3), "Sure");

  // Fragment two arrives before the voice has caught up. The budget has moved
  // by one character; what is on screen must not move by minus four.
  pacer.setText("Sure, I can do that.");
  assert.equal(pacer.advanceTo(0.35), "Sure", "the caption blanked on the first word of the turn");
  assert.equal(pacer.advanceTo(0.4), "Sure");
  assert.equal(pacer.advanceTo(0.45), "Sure,");
});

test("nothing already on screen is ever taken back as the voice catches up", () => {
  const pacer = new CaptionPacer();
  pacer.beginTurn();
  // The fragments one real turn arrives in, each a prefix of the next.
  const fragments = [
    "Okay",
    "Okay, the build",
    "Okay, the build finished about",
    "Okay, the build finished about a minute ago and it is green.",
  ];
  let shown = "";
  let seconds = 0;
  for (const fragment of fragments) {
    pacer.setText(fragment);
    for (let step = 0; step < 12; step += 1) {
      seconds += 0.05;
      const next = pacer.advanceTo(seconds);
      assert.ok(
        next.startsWith(shown),
        `"${shown}" was on screen and became "${next}" — the caption went backwards`,
      );
      assert.ok(fragment.startsWith(next), `"${next}" is not something she is saying`);
      shown = next;
    }
  }
});

test("a revised transcription wins over a caption it no longer contains", () => {
  const pacer = new CaptionPacer();
  pacer.beginTurn();
  pacer.setText("Sorry, I cannot do that today at all");
  const before = pacer.advanceTo(1.5);
  assert.ok(before.length > 0);

  // Held text is held only while it is still a prefix of what she is saying.
  // A caption that outlives the words it was quoting is worse than a short one.
  pacer.setText("Sorry");
  assert.equal(pacer.advanceTo(1.5), "Sorry");
});

test("a multi-byte prefix is never cut inside a character", () => {
  const pacer = new CaptionPacer();
  pacer.beginTurn();
  const spoken = "That is 🎉 wonderful news 👨‍👩‍👧 for the whole team 🇹🇿 honestly.";
  pacer.setText(spoken);
  for (let seconds = 0.05; seconds < 8; seconds += 0.05) {
    const shown = pacer.advanceTo(seconds);
    // U+FFFD is what a half-written surrogate pair looks like on screen.
    assert.equal(/�/.test(shown), false, `"${shown}" contains a replacement glyph`);
    assert.equal(/[\uD800-\uDBFF]$/.test(shown), false, `"${shown}" ends on a lone surrogate`);
    assert.ok(spoken.startsWith(shown), `"${shown}" is not a prefix of what she said`);
  }
});

test("a finished turn stops handing back a caption", () => {
  /* The duplicate-reply bug, on screen 2026-09-12: one answer rendered twice,
     the second copy sitting below whatever the operator said next.

     Playback progress outlives the reply. The worklet keeps reporting for audio
     still in its buffer after `turnComplete` has committed the text to the
     transcript, and `completeTurn()` leaves `shown` holding the whole reply so
     the hold in `visible()` can never give back less. The next progress tick
     therefore handed the finished sentence straight back, and
     `TemiVoiceStage`'s `onTTSProgress` painted it into the live caption row
     underneath the copy already committed. */
  const pacer = new CaptionPacer();
  pacer.beginTurn();
  const reply = "Oh, hello there. I'm perfectly sharp, thank you.";
  pacer.setText(reply);
  pacer.advanceTo(4);
  pacer.completeTurn(reply, 4);

  // The ticks that arrive after the turn was committed.
  assert.equal(pacer.advanceTo(4.05), "", "a closed turn painted its caption again");
  assert.equal(pacer.advanceTo(9), "", "a later tick painted it too");

  // And the next turn is unaffected: the hold is a mid-turn promise, and it is
  // still kept once a new turn has begun.
  pacer.beginTurn();
  pacer.setText("Sure");
  assert.equal(pacer.advanceTo(1), "Sure", "the next turn was silenced with it");
});

test("a turn with nothing in it is not drawn", () => {
  // Trimmed, not `length`: whitespace draws exactly the same empty shape as no
  // content at all, and Gemini's input transcription arrives in fragments that
  // can be a single space.
  assert.match(
    transcript,
    /const hasWords\s*=\s*\(turn: DialogueTurn\): boolean =>\s*turn\.content\.trim\(\)\.length > 0/,
    "the transcript no longer has a rule for what counts as an empty turn",
  );
  assert.match(
    transcript,
    /turns\.filter\(hasWords\)\.map\(/,
    "turns are drawn without being filtered — an empty one draws an empty bubble",
  );
});
