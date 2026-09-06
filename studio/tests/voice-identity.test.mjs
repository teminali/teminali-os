/**
 * The assistant answers to one name, and a greeting is not a task.
 *
 * Both from the same session report: "when I ask for the name it has to say
 * Temy, even if I run on another code assistant like Claude Code or Codex",
 * and "the 'on it' is so inhuman — I say hello, it says I'm on it".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getImmediateAcknowledgment } from "../src/services/voice/acknowledgment.ts";
import { AGENT_IDENTITY } from "../server/agent-cli.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a bare greeting is never answered with a work acknowledgement", () => {
  for (const greeting of ["hello", "Hello.", "hi", "hey there", "habari"]) {
    assert.equal(getImmediateAcknowledgment(greeting), null, greeting);
  }
});

test("a greeting behind a wake word or a filler is still a greeting", () => {
  // Speech is what feeds this, and speech arrives with exactly this preamble.
  for (const greeting of ["Temy, hello", "temy hello", "um, hello", "uh hi", "so, hey", "okay hello"]) {
    assert.equal(getImmediateAcknowledgment(greeting), null, greeting);
  }
});

test("asking who it is is a greeting, not a task", () => {
  for (const question of ["who are you", "what's your name", "who am I talking to"]) {
    assert.equal(getImmediateAcknowledgment(question), null, question);
  }
});

test("a real action still gets its acknowledgement", () => {
  const ack = getImmediateAcknowledgment("run the tests");
  assert.ok(ack && ack.length > 0, "an action command should still be acknowledged");
});

test("the identity names Temy and refuses the engine's name", () => {
  assert.match(AGENT_IDENTITY, /Temy/);
  assert.match(AGENT_IDENTITY, /never the name of the model/i);
  // Short: it is appended to another product's system prompt, not to ours.
  assert.ok(AGENT_IDENTITY.length < 600, `identity is ${AGENT_IDENTITY.length} chars`);
});

test("the Claude lane carries the identity into its own system prompt", () => {
  const source = read("../server/agent-cli.js");
  assert.match(source, /"--append-system-prompt", AGENT_IDENTITY/);
});

test("the local lane states the name and the greeting rule", () => {
  const source = read("../src/services/frontierEngine.ts");
  assert.match(source, /\[WHO YOU ARE\]/);
  assert.match(source, /Your name is Temy/);
  assert.match(source, /Greet a greeting/);
  // Declared once and used once, so there is no second mechanism.
  assert.equal(source.match(/identityInstruction/g).length, 2);
});
