import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExtractionPrompt,
  parseMemoryCandidates,
  extractMemories,
  MAX_CANDIDATES_PER_SESSION,
  MAX_TRANSCRIPT_CHARS,
  MAX_CANDIDATE_TEXT,
} from "../src/services/voice/temiMemoryExtract.ts";

const ok = (over = {}) => ({
  kind: "fact",
  text: "He takes his coffee black",
  axes: { weight: 0.6, warmth: 0.1, surprise: 0.1, firstness: 0.2 },
  ...over,
});

test("the transcript reaches the model as two named speakers, not as roles", () => {
  const prompt = buildExtractionPrompt([
    { role: "user", content: "I hate Mondays" },
    { role: "assistant", content: "Everyone does" },
  ]);
  assert.match(prompt, /He: I hate Mondays/);
  assert.match(prompt, /Temi: Everyone does/);
});

test("the prompt states the prohibition that the whole policy rests on", () => {
  const prompt = buildExtractionPrompt([{ role: "user", content: "hello" }]);
  assert.match(prompt, /Do not keep things because they are important/);
  assert.match(prompt, /If everything you write down is useful, you have done this wrong/);
});

test("an empty conversation is an allowed answer, and the prompt says so", () => {
  const prompt = buildExtractionPrompt([{ role: "user", content: "hello" }]);
  assert.match(prompt, /output exactly \[\]/);
});

test("a long conversation is cut to its end, at a line boundary", () => {
  const turns = [];
  for (let i = 0; i < 4000; i += 1) turns.push({ role: "user", content: `line number ${i} of the conversation` });
  turns.push({ role: "user", content: "THE LAST THING HE SAID" });
  const prompt = buildExtractionPrompt(turns);
  const transcript = prompt.slice(prompt.indexOf("TRANSCRIPT\n") + "TRANSCRIPT\n".length);
  assert.ok(transcript.length <= MAX_TRANSCRIPT_CHARS, `${transcript.length}`);
  assert.match(transcript, /THE LAST THING HE SAID/);
  // Never opening mid-sentence: the model must not read a fragment as a thing
  // that was said.
  assert.match(transcript.split("\n")[0], /^He: /);
});

test("blank turns are not lines in the transcript", () => {
  const prompt = buildExtractionPrompt([
    { role: "user", content: "   " },
    { role: "user", content: "something" },
  ]);
  assert.equal((prompt.match(/^He: /gm) || []).length, 1);
});

test("a plain array parses", () => {
  assert.equal(parseMemoryCandidates(JSON.stringify([ok()])).length, 1);
});

test("a fenced array parses, because small models fence", () => {
  const raw = "```json\n" + JSON.stringify([ok()]) + "\n```";
  assert.equal(parseMemoryCandidates(raw).length, 1);
});

test("an array wrapped in an apology parses, because small models apologise", () => {
  const raw = `Sure! Here are the memories:\n${JSON.stringify([ok()])}\nLet me know if you need more.`;
  assert.equal(parseMemoryCandidates(raw).length, 1);
});

test("nonsense yields nothing rather than throwing", () => {
  for (const raw of ["", "I could not do that", "{}", "[", "[{", "null"]) {
    assert.deepEqual(parseMemoryCandidates(raw), []);
  }
});

test("a fifth kind is not a kind", () => {
  assert.deepEqual(parseMemoryCandidates(JSON.stringify([ok({ kind: "note" })])), []);
  assert.deepEqual(parseMemoryCandidates(JSON.stringify([ok({ kind: "Fact" })])), []);
});

test("a memory long enough to be a summary is refused, not trimmed", () => {
  const long = ok({ text: "x".repeat(MAX_CANDIDATE_TEXT + 1) });
  assert.deepEqual(parseMemoryCandidates(JSON.stringify([long])), []);
});

test("a memory with no words is not a memory", () => {
  assert.deepEqual(parseMemoryCandidates(JSON.stringify([ok({ text: "  " })])), []);
});

test("scoring nothing is not scoring zero, and is dropped", () => {
  const unscored = ok({ axes: { weight: 0, warmth: 0, surprise: 0, firstness: 0 } });
  assert.deepEqual(parseMemoryCandidates(JSON.stringify([unscored])), []);
  assert.deepEqual(parseMemoryCandidates(JSON.stringify([ok({ axes: undefined })])), []);
});

test("quoted numbers are numbers, and out of range is clamped rather than dropped", () => {
  const [candidate] = parseMemoryCandidates(
    JSON.stringify([ok({ axes: { weight: "0.7", warmth: 4, surprise: -2, firstness: "nope" } })]),
  );
  assert.equal(candidate.axes.weight, 0.7);
  assert.equal(candidate.axes.warmth, 1);
  assert.equal(candidate.axes.surprise, 0);
  assert.equal(candidate.axes.firstness, 0);
});

test("the model repeating itself is not him repeating himself", () => {
  const rows = [ok(), ok({ text: "He takes his coffee BLACK" })];
  assert.equal(parseMemoryCandidates(JSON.stringify(rows)).length, 1);
});

test("a gist that merely restates the text is not a gist", () => {
  const [candidate] = parseMemoryCandidates(JSON.stringify([ok({ gist: "he takes his coffee black" })]));
  assert.equal(candidate.gist, undefined);
});

test("a real gist survives", () => {
  const [candidate] = parseMemoryCandidates(JSON.stringify([ok({ gist: "He is particular about coffee" })]));
  assert.equal(candidate.gist, "He is particular about coffee");
});

test("a subject is kept on anchors, lowercased, and nowhere else", () => {
  const [anchor] = parseMemoryCandidates(
    JSON.stringify([ok({ kind: "anchor", text: "He lives in Arusha", subject: "  Home  " })]),
  );
  assert.equal(anchor.subject, "home");
  const [fact] = parseMemoryCandidates(JSON.stringify([ok({ subject: "home" })]));
  assert.equal(fact.subject, undefined);
});

test("a model that will not stop is stopped at the cap", () => {
  const rows = [];
  for (let i = 0; i < 40; i += 1) rows.push(ok({ text: `He mentioned thing number ${i} in passing` }));
  assert.equal(parseMemoryCandidates(JSON.stringify(rows)).length, MAX_CANDIDATES_PER_SESSION);
});

test("one bad row does not cost the session its good ones", () => {
  const rows = [ok({ kind: "note" }), ok({ text: "He calls the router the spaghetti" })];
  assert.equal(parseMemoryCandidates(JSON.stringify(rows)).length, 1);
});

test("no conversation means no model call at all", async () => {
  let called = false;
  const result = await extractMemories([], async () => {
    called = true;
    return "[]";
  });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("a model that fails fails loudly, so the pass can decline to write", async () => {
  await assert.rejects(
    extractMemories([{ role: "user", content: "hello" }], async () => {
      throw new Error("ollama is not running");
    }),
    /ollama is not running/,
  );
});
