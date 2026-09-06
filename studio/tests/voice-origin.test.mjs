/**
 * A spoken turn must reach the model marked as a transcript.
 *
 * The failure this guards against is real: the recogniser heard a folder name
 * that does not exist, the agent ran `du -sh` on it verbatim, and told the
 * operator to "verify the folder name" without once listing the directory. The
 * words were wrong; the answer was worse. These tests hold both halves of the
 * fix — the origin reaching the engine, and the engine saying what it means.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { VOICE_TRANSCRIPT_NOTICE, transcriptNotice } from "../src/services/voice/types.ts";

const read = (relative) => readFile(new URL(`../src/${relative}`, import.meta.url), "utf8");

/* ── The prompt fragment ──────────────────────────────────────────────────── */

test("a spoken turn gets the transcript notice", () => {
  const notice = transcriptNotice("voice");
  assert.ok(notice.includes(VOICE_TRANSCRIPT_NOTICE));
  // It is spliced onto the end of an existing prompt, so it must bring its own
  // separation rather than run into the previous section.
  assert.match(notice, /^\n\n/);
});

test("a typed turn gets nothing at all", () => {
  assert.equal(transcriptNotice("text"), "");
  // An older caller that threads no origin is a typed caller.
  assert.equal(transcriptNotice(undefined), "");
});

test("the notice names what recognition gets wrong and what to do instead", () => {
  const notice = VOICE_TRANSCRIPT_NOTICE.toLowerCase();
  for (const term of ["proper noun", "file and directory names", "paths", "commands", "identifiers"]) {
    assert.ok(notice.includes(term), `notice should name ${term}`);
  }
  // Look before you answer.
  assert.ok(notice.includes("list the directory"));
  assert.ok(notice.includes("search the workspace"));
  assert.ok(notice.includes("near-match"));
  // And the exact non-answer that started this.
  assert.ok(notice.includes("does not exist, please verify"));
});

test("the notice stays short enough for an 8k window", () => {
  assert.ok(VOICE_TRANSCRIPT_NOTICE.length < 900, `notice is ${VOICE_TRANSCRIPT_NOTICE.length} chars`);
});

/* ── The threading ────────────────────────────────────────────────────────── */

test("the voice host is told the origin, and older hosts still compile", async () => {
  const conversation = await read("services/voice/conversation.ts");
  assert.match(conversation, /submit: \(text: string, options\?: SubmitOptions\) => void \| Promise<void>;/);
  assert.match(conversation, /this\.host\.submit\(value, \{ origin: "voice" \}\)/);
});

test("the React binding forwards the origin rather than dropping it", async () => {
  const hook = await read("hooks/useVoice.ts");
  assert.match(hook, /submit: \(text, options\) => hostRef\.current\.submit\(text, options\)/);
});

test("the chat host carries the origin into the stream request", async () => {
  const chat = await read("components/chat/StudioChat.tsx");
  assert.match(chat, /submit: \(text, options\) => \{/);
  assert.match(chat, /sendRef\.current\(text, options\)/);
  assert.match(chat, /origin: options\?\.origin \?\? "text"/);
});

test("the service layer defaults to a typed turn", async () => {
  const service = await read("services/aiService.ts");
  assert.match(service, /origin\?: TurnOrigin;/);
  assert.match(service, /options\.origin \?\? "text"/);
});

test("the engine splices the notice into the system prompt it already builds", async () => {
  const engine = await read("services/frontierEngine.ts");
  assert.match(engine, /origin: TurnOrigin = "text",/);
  // The engine hands the origin to the one composition function; the notice
  // is a section of that assembly, not a second mechanism bolted on after.
  assert.match(engine, /composeSystemPrompt\(\{[\s\S]*?\borigin,[\s\S]*?\}\)/);
  const prompt = await read("services/systemPrompt.ts");
  assert.match(prompt, /const transcriptInstruction = transcriptNotice\(input\.origin\);/);
  // A required section, because a spoken turn read as typed is answered wrong.
  assert.match(prompt, /\{ name: "transcript", required: true, text: transcriptInstruction \}/);
  assert.equal(prompt.split("transcriptInstruction").length - 1, 2);
});
