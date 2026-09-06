import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { classifyApprovalReply, describeApprovalRequest } from "../src/services/voice/approvalIntent.ts";

/**
 * Answering a permission prompt by voice.
 *
 * The operator asked for the assistant to read a pending approval out and take
 * "yes" for an answer, while leaving the buttons exactly where they were. The
 * risk that shapes every test below is a false allow: the microphone hears the
 * room, and a sentence that merely contains the word "yes" must never run a
 * command. So the acceptances are checked, and then — at greater length — the
 * refusals to accept.
 */

test("plain affirmatives allow the pending command", () => {
  for (const phrase of ["yes", "Yes.", "yeah", "yep", "sure", "ok", "Okay!", "go ahead", "do it", "run it", "approve it", "that's fine"]) {
    assert.equal(classifyApprovalReply(phrase), "allow", `"${phrase}" should allow`);
  }
});

test("plain negatives deny it", () => {
  for (const phrase of ["no", "No.", "nope", "nah", "deny", "skip", "cancel", "no thanks", "don't", "not now", "reject"]) {
    assert.equal(classifyApprovalReply(phrase), "deny", `"${phrase}" should deny`);
  }
});

test("a doubled transcript is still one answer", () => {
  /*
    The recogniser writes an utterance down twice — "Thank you. Thank you." is
    what one "thank you" looks like coming out of it — so the operator's spoken
    "yes" arrived as "yes yes" and answered nothing. What is pinned here is
    that collapsing a repetition cannot invent an answer: only an exact repeat
    of the whole phrase folds, and a phrase that was not an answer before is
    not one after.
  */
  assert.equal(classifyApprovalReply("Yes. Yes."), "allow");
  assert.equal(classifyApprovalReply("yes allow yes allow"), "allow");
  assert.equal(classifyApprovalReply("No. No."), "deny");
  assert.equal(classifyApprovalReply("don't run it don't run it"), "deny");
  assert.equal(classifyApprovalReply("always allow always allow"), "allow-always");

  // Not repetitions, and so not answers.
  assert.equal(classifyApprovalReply("yes no"), null);
  assert.equal(classifyApprovalReply("no yes no yes"), null);
  assert.equal(classifyApprovalReply("yes yes yes yes yes"), null);
});

test("\"always\" beats the plain yes inside it", () => {
  // Every one of these also matches an affirmative; the wider grant has to win,
  // or "yes always" would allow once and ask again immediately.
  for (const phrase of ["always", "always allow", "yes, always", "don't ask again", "stop asking me again"]) {
    assert.equal(classifyApprovalReply(phrase), "allow-always", `"${phrase}" should allow always`);
  }
});

test("the words the prompt itself teaches are answers", () => {
  /*
    The regression this pins: the spoken question says "say yes to allow it"
    and the button says "Run", and the table took neither "allow" nor "yes
    allow". An operator who repeated the vocabulary they had just been given
    watched the prompt sit there — which is exactly what happened in the app.
  */
  for (const phrase of ["allow", "approve", "accept", "permit", "run", "Allow.", "RUN"]) {
    assert.equal(classifyApprovalReply(phrase), "allow", phrase);
  }
  for (const phrase of ["yes allow", "yes, allow", "yeah allow it", "ok approve that", "sure run it", "yep do it"]) {
    assert.equal(classifyApprovalReply(phrase), "allow", phrase);
  }
});

test("the wider grant still wins when both readings fit", () => {
  // "allow always" is an always, not an allow; the ALWAYS table is tried first.
  for (const phrase of ["allow always", "approve always", "yes always", "always allow"]) {
    assert.equal(classifyApprovalReply(phrase), "allow-always", phrase);
  }
});

test("the new verbs did not widen into instructions", () => {
  // Each of these contains a newly accepted verb and is not an answer to it.
  for (const phrase of [
    "run the tests",
    "allow the deploy to finish",
    "run it after the build passes",
    "approve the pull request",
    "accept the terms on that page",
    "permit me to explain",
  ]) {
    assert.equal(classifyApprovalReply(phrase), null, phrase);
  }
});

test("a sentence is an instruction, not an answer", () => {
  /*
    The whole safety of the feature. Each of these contains a word the tables
    match, and each is the operator talking rather than answering — so each must
    fall through to the model with the prompt still standing.
  */
  for (const phrase of [
    "yes and then push the branch to origin please",
    "no I meant the other file entirely, open that one",
    "ok so what does that command actually do",
    "sure but first show me the diff for that file",
    "I don't know what that command is going to do",
    "always run the tests before you commit anything",
  ]) {
    assert.equal(classifyApprovalReply(phrase), null, `"${phrase}" must not be read as an answer`);
  }
});

test("a word inside another word is not an answer", () => {
  for (const phrase of ["nothing", "yesterday", "okra", "denying it", "cancellation"]) {
    assert.equal(classifyApprovalReply(phrase), null, `"${phrase}" must not be read as an answer`);
  }
});

test("empty and non-speech input answers nothing", () => {
  for (const phrase of ["", "   ", "...", "uh"]) {
    assert.equal(classifyApprovalReply(phrase), null);
  }
});

test("the spoken question names the command and both answers", () => {
  const line = describeApprovalRequest({ asker: "Claude Code", action: "npm test" });
  assert.match(line, /Claude Code/);
  assert.match(line, /npm test/);
  // An operator who is not told "yes" is a live word says it to nothing.
  assert.match(line, /yes/i);
  assert.match(line, /no/i);
});

test("a long command is announced rather than recited", () => {
  const long = "find . -name '*.tmp' -newer package.json -print0 | xargs -0 rm -f && npm run build";
  const line = describeApprovalRequest({ asker: "Claude Code", action: long });
  assert.ok(!line.includes(long), "a shell one-liner is unlistenable and must not be read out");
  assert.match(line, /on screen/i);
  assert.match(line, /yes/i);
});

test("a request with no command still asks a whole question", () => {
  const line = describeApprovalRequest({ asker: "", action: "" });
  assert.match(line, /permission/i);
  assert.match(line, /yes/i);
});

/**
 * The prompt keeps its buttons.
 *
 * The operator's requirement was explicit — *"but do show the option incase i
 * wanted to click myself"* — so the voice path is additive and this asserts the
 * source still says so. A component test cannot run here; reading the file is
 * the honest check that nothing was replaced by a microphone.
 */
test("both approval prompts still render their buttons", async () => {
  const chat = await readFile(new URL("../src/components/chat/CommandApprovalPrompt.tsx", import.meta.url), "utf8");
  assert.match(chat, /onClick=\{\(\) => onApprove\(false\)\}/, "Run must still be clickable");
  assert.match(chat, /onClick=\{\(\) => onApprove\(true\)\}/, "Always must still be clickable");
  assert.match(chat, /onClick=\{onDeny\}/, "Skip must still be clickable");

  const agent = await readFile(new URL("../src/components/workspace/panels/AgentPane.tsx", import.meta.url), "utf8");
  assert.match(agent, /answer\(approvals\[0\], "allow", false\)/, "Allow once must still be clickable");
  assert.match(agent, /answer\(approvals\[0\], "allow", true\)/, "Always allow must still be clickable");
  assert.match(agent, /answer\(approvals\[0\], "deny", false\)/, "Deny must still be clickable");
});
