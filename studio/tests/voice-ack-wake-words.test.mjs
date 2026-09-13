import assert from "node:assert/strict";
import test from "node:test";

import { getImmediateAcknowledgment } from "../src/services/voice/acknowledgment.ts";
import { DEFAULT_VOICE_SETTINGS } from "../src/services/voice/types.ts";

/*
  The wake word has one home, `DEFAULT_VOICE_SETTINGS.wakeWords`, and every
  other spelling of it in the codebase is a copy waiting to go stale. This file
  exists because a fourth copy was living inside `acknowledgment.ts`, in the
  regex that strips her name off the front of a greeting, and it had already
  drifted: it knew "temy" but not "temi", the spelling the recogniser actually
  returns, and it could not know about a word the operator typed into Settings.

  So the tests below never write the list out. They read it from the canonical
  export and build the utterance, which is the only shape of test that would
  have failed on the divergence rather than agreeing with it.

  The preamble in each case is deliberate: `patterns.leading` already strips a
  name standing at the very front, so a case like "Temi, hello" passed with the
  bug in place. The name has to arrive behind a filler for the stripper under
  test to be the one that matters, which is exactly what speech delivers.
*/

test("every canonical wake word is stripped off a greeting that arrives behind a filler", () => {
  for (const word of DEFAULT_VOICE_SETTINGS.wakeWords) {
    for (const utterance of [
      `um okay ${word}, hello`,
      `um okay ${word} hello`,
      `well okay ${word}, hi there`,
      `so okay ${word}, how are you`,
    ]) {
      assert.equal(
        getImmediateAcknowledgment(utterance),
        null,
        `"${utterance}" is a greeting and must not get a canned acknowledgement`,
      );
    }
  }
});

test("a wake word the operator added in Settings is stripped here too", () => {
  // The measured failure: with the list hardcoded, this answered "Sure thing."
  // to a hello, because the greeting test missed and the leading "okay" then
  // matched the affirmation rule.
  assert.equal(getImmediateAcknowledgment("um okay jarvis hello", ["jarvis"]), null);
  assert.equal(getImmediateAcknowledgment("um okay computer, how are you", ["computer"]), null);
  // And the operator's word is additive: the defaults keep working beside it.
  for (const word of DEFAULT_VOICE_SETTINGS.wakeWords) {
    assert.equal(getImmediateAcknowledgment(`um okay ${word}, hello`, ["jarvis"]), null);
  }
});

test("a wake word holding a regex metacharacter is escaped, not thrown on", () => {
  /*
    The assertion is only that nothing throws, and that is the whole contract:
    an unescaped "(" or "+" in the alternation is a SyntaxError on the chat's
    send path. It cannot also be asserted that such a name gets stripped here,
    and that is not a gap in the test. By the time this stripper runs, `lower`
    has already replaced every character outside letters, digits, apostrophes
    and whitespace with a space, so "c++" reached it as "c" several lines ago.
    Punctuation in a wake word is answered by `patterns.leading`, before the
    normalisation, not by this one.
  */
  assert.doesNotThrow(() => getImmediateAcknowledgment("um okay c++ hello", ["c++"]));
  assert.doesNotThrow(() => getImmediateAcknowledgment("hello", ["(temi)"]));
  assert.doesNotThrow(() => getImmediateAcknowledgment("um okay temi hello", ["a.b", "x|y", "[z"]));
});

test("the product's own names are still stripped, though they are not wake words", () => {
  // "frontier" and "studio" were in the hardcoded copy and nowhere else. They
  // are kept, so this is a regression guard rather than a new capability.
  assert.equal(getImmediateAcknowledgment("studio, hello"), null);
  assert.equal(getImmediateAcknowledgment("frontier, hello"), null);
  assert.equal(getImmediateAcknowledgment("um okay studio hello"), null);
  // Kept apart from the wake words, though: neither is an address the operator
  // agreed to, so neither may be added to the list Settings owns.
  assert.ok(!DEFAULT_VOICE_SETTINGS.wakeWords.includes("studio"));
  assert.ok(!DEFAULT_VOICE_SETTINGS.wakeWords.includes("frontier"));
});

test("work still gets an acknowledgement, with or without a name in front of it", () => {
  for (const word of DEFAULT_VOICE_SETTINGS.wakeWords) {
    assert.notEqual(getImmediateAcknowledgment(`${word}, fix the build`), null);
  }
  assert.notEqual(getImmediateAcknowledgment("fix the login bug"), null);
  assert.notEqual(getImmediateAcknowledgment("yes"), null);
  assert.notEqual(getImmediateAcknowledgment("go ahead"), null);
  // A question is still answered by the model, not by a filler.
  assert.equal(getImmediateAcknowledgment("what is this file"), null);
});
