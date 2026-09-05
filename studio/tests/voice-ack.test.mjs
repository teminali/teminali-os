import assert from "node:assert/strict";
import test from "node:test";

import { getImmediateAcknowledgment } from "../src/services/voice/acknowledgment.ts";
import { classifyTurnIntent } from "../src/services/voice/turnIntent.ts";
import { sanitizeOngoingAssist } from "../src/services/voice/speakable.ts";

test("greetings and presence checks never return a canned acknowledgment", () => {
  const greetings = [
    "hello",
    "Hello",
    "hello there",
    "hey",
    "hey there",
    "hi",
    "hi there",
    "hello temy",
    "temy hello",
    "teminali hello",
    "good morning",
    "good afternoon",
    "good evening",
    "hello how are you",
    "how are you",
    "how is it going",
    "what is up",
    "who are you",
    "can you hear me",
    "are you there",
    "is anyone there",
    "hello?",
    "hello!",
    "yo",
    "hey bro",
    "what can you do",
    "tell me a joke",
  ];

  for (const text of greetings) {
    const ack = getImmediateAcknowledgment(text);
    assert.equal(ack, null, `Expected "${text}" to yield null, got "${ack}"`);
  }
});

test("information queries and explanations speak naturally without filler", () => {
  const queries = [
    "explain this code",
    "what is a closure",
    "why did the test fail",
    "where is index.html",
    "how does the voice sidecar work",
    "which file contains the settings",
    "who committed this change",
    "tell me about react hooks",
    "show me the terminal output",
    "describe the architecture",
  ];

  for (const text of queries) {
    const ack = getImmediateAcknowledgment(text);
    assert.equal(ack, null, `Expected query "${text}" to yield null, got "${ack}"`);
  }
});

test("explicit action commands receive verbal task acknowledgments", () => {
  const actionCommands = [
    "fix the bug in StudioChat.tsx",
    "run the tests",
    "build the project",
    "refactor the voice engine",
    "can you fix the login issue",
    "please deploy the app",
    "delete the temp folder",
    "install dependencies",
    "create a new component called Header",
  ];

  const validActionAcks = new Set(["Working on it.", "Getting right on that.", "On it."]);

  for (const text of actionCommands) {
    const ack = getImmediateAcknowledgment(text);
    assert.ok(ack !== null, `Expected action command "${text}" to yield an acknowledgment`);
    assert.ok(validActionAcks.has(ack), `Expected "${ack}" to be one of valid action acks`);
  }
});

test("affirmations return affirmative acknowledgments", () => {
  const confirmations = [
    "yes",
    "sure",
    "go ahead",
    "proceed",
    "sure thing",
    "please do",
  ];

  const validConfirmAcks = new Set(["Sure thing.", "Right away.", "On it."]);

  for (const text of confirmations) {
    const ack = getImmediateAcknowledgment(text);
    assert.ok(ack !== null, `Expected confirmation "${text}" to yield an acknowledgment`);
    assert.ok(validConfirmAcks.has(ack), `Expected "${ack}" to be one of valid confirm acks`);
  }
});

test("random unrecognized remarks default to null rather than 'I'm on it'", () => {
  const randomRemarks = [
    "interesting",
    "the weather is nice today",
    "maybe later",
    "just thinking aloud",
    "i say hello it says i'm on it",
  ];

  for (const text of randomRemarks) {
    const ack = getImmediateAcknowledgment(text);
    assert.equal(ack, null, `Expected remark "${text}" to default to null, got "${ack}"`);
  }
});

test("attention words during a busy run do not trigger 'acknowledge' intent", () => {
  const busy = { busy: true, speaking: false };

  // Attention words should NOT count as "keep going / carry on"
  assert.notEqual(classifyTurnIntent("hey", busy).intent, "acknowledge");
  assert.notEqual(classifyTurnIntent("hey temy", busy).intent, "acknowledge");
  assert.notEqual(classifyTurnIntent("teminali", busy).intent, "acknowledge");
  assert.notEqual(classifyTurnIntent("yo", busy).intent, "acknowledge");

  // Real encouragement STILL counts as acknowledge
  assert.equal(classifyTurnIntent("nice", busy).intent, "acknowledge");
  assert.equal(classifyTurnIntent("keep going", busy).intent, "acknowledge");
  assert.equal(classifyTurnIntent("carry on", busy).intent, "acknowledge");
  assert.equal(classifyTurnIntent("okay cool carry on", busy).intent, "acknowledge");
});

test("sanitizeOngoingAssist converts robotic 'today' phrasing to 'now' in ongoing turns", () => {
  assert.equal(
    sanitizeOngoingAssist("Hello! How can I assist you today?"),
    "Hello! How can I assist you now?",
  );
  assert.equal(
    sanitizeOngoingAssist("how can I assist you today"),
    "how can I assist you now",
  );
  assert.equal(
    sanitizeOngoingAssist("How can I help you today?"),
    "How can I help you now?",
  );
  assert.equal(
    sanitizeOngoingAssist("What can I help you with today?"),
    "What can I help you with now?",
  );
  assert.equal(
    sanitizeOngoingAssist("What can I do for you today?"),
    "What can I do for you now?",
  );

  // Does not touch unrelated uses of 'today'
  assert.equal(
    sanitizeOngoingAssist("Today is a great day to build an app."),
    "Today is a great day to build an app.",
  );
  assert.equal(
    sanitizeOngoingAssist("The tests passed today."),
    "The tests passed today.",
  );
});
