/*
  The ask contract, from the local lane.

  What is worth testing is what actually goes wrong. Measured before this
  existed, the lane asked for options in prose — "Here are a few approaches:
  1. Monolithic…" — and ended the turn with nothing to click, 0/3 on the eval.
  So the fence has to parse; a malformed one has to come back as a sentence the
  model can act on rather than silence; documentation must never open a modal;
  and a dismissed picker must still produce an observation, because a turn that
  ends in silence because the operator clicked away is worse than a wrong guess.

  The gate gets its own case for the reason `useCommandApproval` has one: the
  bug that ships with a gate is a promise that never settles, and it takes an
  operator staring at a dead composer to notice.
*/
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ASK_OPTIONS,
  MAX_ASK_QUESTIONS,
  askQuestionsFrom,
  buildAskEvidence,
  checkAskQuestion,
  createAskGate,
  executeAskRequests,
  hasAskToolCalls,
  isAskRejection,
  parseAskToolCalls,
  parseFallbackAskToolCalls,
} from "../src/services/askToolCalls.ts";

const fence = (body) => "Two ways to go here.\n```ask\n" + body + "\n```";
const one = { question: "How should I structure this?", header: "Structure", options: [{ label: "Monolith" }, { label: "Workspaces" }] };

test("parses a well-formed ask fence", () => {
  const questions = askQuestionsFrom(parseAskToolCalls(fence(JSON.stringify(one))));
  assert.equal(questions.length, 1);
  assert.equal(questions[0].header, "Structure");
  assert.deepEqual(questions[0].options.map((o) => o.label), ["Monolith", "Workspaces"]);
  assert.equal(questions[0].multiSelect, false);
});

test("an array of questions is the stepped set", () => {
  const questions = askQuestionsFrom(parseAskToolCalls(fence(JSON.stringify([one, { ...one, header: "Tests" }]))));
  assert.equal(questions.length, 2);
  assert.deepEqual(questions.map((q) => q.header), ["Structure", "Tests"]);
});

test("a ```json block is documentation and never asks", () => {
  const text = "Here is how the ask fence works:\n```json\n" + JSON.stringify(one) + "\n```";
  assert.equal(hasAskToolCalls(text), false);
  assert.equal(parseAskToolCalls(text).length, 0);
});

test("bare strings are options, and duplicates collapse", () => {
  const request = checkAskQuestion({ question: "Which?", options: ["Postgres", "SQLite", "postgres"] });
  assert.ok(!isAskRejection(request));
  assert.deepEqual(request.question.options.map((o) => o.label), ["Postgres", "SQLite"]);
});

test("a missing header is derived rather than refused", () => {
  const request = checkAskQuestion({ question: "Which database should the project use?", options: ["A", "B"] });
  assert.ok(!isAskRejection(request));
  assert.ok(request.question.header.length > 0);
  assert.ok(request.question.header.length <= 12);
});

test("a question with one answer is refused, with a reason the model can act on", () => {
  const rejection = checkAskQuestion({ question: "Shall I?", options: ["Yes"] });
  assert.ok(isAskRejection(rejection));
  assert.match(rejection.reason, /at least 2/);
});

test("a missing question is refused", () => {
  const rejection = checkAskQuestion({ options: ["A", "B"] });
  assert.ok(isAskRejection(rejection));
  assert.match(rejection.reason, /"question"/);
});

test("options and questions are capped", () => {
  const many = checkAskQuestion({ question: "Which?", options: ["a", "b", "c", "d", "e", "f"] });
  assert.ok(!isAskRejection(many));
  assert.equal(many.question.options.length, MAX_ASK_OPTIONS);
  const set = Array.from({ length: 9 }, (_, i) => ({ ...one, header: `H${i}` }));
  assert.equal(askQuestionsFrom(parseAskToolCalls(fence(JSON.stringify(set)))).length, MAX_ASK_QUESTIONS);
});

test('"multiSelect": "true" is honoured, like the player runner honours "30"', () => {
  const request = checkAskQuestion({ question: "Which?", options: ["A", "B"], multiSelect: "true" });
  assert.ok(!isAskRejection(request));
  assert.equal(request.question.multiSelect, true);
});

test("the editor fence's wrapper shape is unwrapped, not refused", () => {
  const request = checkAskQuestion({ tool: "ask", arguments: { question: "Which?", options: ["A", "B"] } });
  assert.ok(!isAskRejection(request));
  assert.equal(request.question.question, "Which?");
});

test("a mistyped tag still reaches the operator", () => {
  const text = "```ask-user\n" + JSON.stringify(one) + "\n```";
  assert.equal(parseAskToolCalls(text).length, 0);
  assert.equal(askQuestionsFrom(parseFallbackAskToolCalls(text)).length, 1);
});

test("the answer is handed back as the operator's decision", async () => {
  const execution = await executeAskRequests(parseAskToolCalls(fence(JSON.stringify(one))), {
    execute: async (questions) => [{ header: questions[0].header, question: questions[0].question, labels: ["Workspaces"] }],
  });
  assert.equal(execution.answered, true);
  const evidence = buildAskEvidence(execution);
  assert.match(evidence, /Workspaces/);
  assert.match(evidence, /do not ask it again/i);
});

test("a dismissed picker still tells the model what to do", async () => {
  const execution = await executeAskRequests(parseAskToolCalls(fence(JSON.stringify(one))), { execute: async () => null });
  assert.equal(execution.answered, false);
  assert.match(buildAskEvidence(execution), /Do not ask again/);
  assert.match(buildAskEvidence(execution), /carry on with the work/);
});

test("an executor that throws does not take the turn down with it", async () => {
  const execution = await executeAskRequests(parseAskToolCalls(fence(JSON.stringify(one))), {
    execute: async () => { throw new Error("no picker mounted"); },
  });
  assert.equal(execution.answered, false);
});

test("the gate always settles: cancel resolves the pending question", async () => {
  const gate = createAskGate();
  const pending = gate.request([one]);
  assert.deepEqual(gate.pending(), [one]);
  gate.cancel();
  assert.equal(await pending, null);
  assert.equal(gate.pending(), null);
});

test("a second question settles the first rather than stranding it", async () => {
  const gate = createAskGate();
  const first = gate.request([one]);
  const second = gate.request([{ ...one, header: "Later" }]);
  assert.equal(await first, null);
  gate.settle([{ header: "Later", question: one.question, labels: ["Monolith"] }]);
  assert.deepEqual((await second)[0].labels, ["Monolith"]);
});
