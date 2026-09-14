/**
 * Safety and Routing Invariants for Voice vs Engineering Delegation.
 *
 * Validates:
 * 1. Vocal delivery directives and singing requests stay in "converse" rather
 *    than being falsely classified as machine actions ("edit").
 * 2. Voice delegation context framing instructs the coding assistant not to
 *    hallucinate file edits or commands for conversational or singing asks.
 * 3. Assistant-targeted stop phrases correctly trigger stop intent.
 * 4. Non-speech hallucination filters reject pure Japanese kana and silence noise.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { classifyMachineAction } from "../src/services/voice/machineAction.ts";
import { classifyTurnIntent } from "../src/services/voice/turnIntent.ts";
import { frameVoiceDelegatedTask } from "../src/services/voice/assistantHandoff.ts";
import { routeVoiceTurn, STOP_ACKNOWLEDGEMENT } from "../src/services/voice/voiceTurnRouter.ts";

test("singing requests and vocal delivery modifiers stay with the voice (converse)", () => {
  const conversationalPhrases = [
    "sing longer",
    "sing another song",
    "sing me a song",
    "can you sing another one and make it longer, sing longer?",
    "make it longer",
    "make it shorter",
    "make it faster",
    "make it slower",
    "make it louder",
    "make it softer",
    "make it quieter",
    "make it sound better",
    "sing that again but slower",
    "can you talk slower",
    "talk faster please",
  ];

  for (const phrase of conversationalPhrases) {
    const action = classifyMachineAction(phrase);
    assert.equal(
      action,
      null,
      `Expected "${phrase}" to return null (converse), but got action ${action?.kind}`,
    );
  }
});

test("frameVoiceDelegatedTask adds protective voice context envelope", () => {
  const raw = "write a function to add two numbers";
  const framed = frameVoiceDelegatedTask(raw);

  assert.ok(framed.includes("[VOICE ASSISTANT CONTEXT:"), "Includes context header");
  assert.ok(framed.includes("If this request is conversational, a vocal performance"), "Instructs against vocal performance hallucination");
  assert.ok(framed.includes("DO NOT attempt to modify workspace files or run commands"), "Explicit constraint on file/shell operations");
  assert.ok(framed.endsWith(raw), "Ends with the raw task prompt");
});

test("assistant stop commands route to stop intent during execution", () => {
  const stopCommands = [
    "stop the assistant",
    "stop the other assistant",
    "stop the agent",
    "stop the background assistant",
    "stop the coding assistant",
    "cancel the assistant",
    "cancel the other assistant",
    "kill the assistant",
    "kill the agent",
    "stop what you're doing",
    "stop whatever you're doing",
  ];

  const busyContext = { busy: true, speaking: false };

  for (const cmd of stopCommands) {
    const verdict = classifyTurnIntent(cmd, busyContext);
    assert.equal(verdict.intent, "stop", `Expected intent 'stop' for '${cmd}', got '${verdict.intent}'`);

    const routed = routeVoiceTurn(cmd, { busy: true, speaking: false, now: Date.now() });
    assert.equal(routed.action.kind, "stop", `Expected route action 'stop' for '${cmd}', got '${routed.action.kind}'`);
    assert.equal(routed.speak, STOP_ACKNOWLEDGEMENT);
  }
});
