/**
 * She speaks while the assistant works, and each line she is given lands once.
 *
 * Both of these were seen on a live call on 2026-09-12, and both were on the
 * delegate path rather than the tool path that had just been proven.
 *
 * The silence first. `ask_the_assistant` is a BLOCKING call, so the model stops
 * and waits for the function response, and the response used to be the agent's
 * finished report. For the length of an agent run she therefore said nothing
 * at all. The `spoken_note` argument existed precisely to cover that, and the
 * app rendered it as a toast: measured across five delegating turns, four
 * emitted no audio and no `outputTranscription` whatsoever before the
 * `toolCall`, while her own thought text read "I'll begin by saying 'One
 * moment.'" She believed she had spoken. On a voice call the operator got a
 * toast and thirty seconds of nothing.
 *
 * Then the double. One answer arrived on screen twice, because `onCompleted`
 * appended the report to the transcript AND sent it to be spoken, and the
 * spoken copy committed as its own bubble underneath the written one. This is
 * a different defect from the caption duplicate closed in DESIGN.md 6.0.19,
 * which was about a closed turn handing its caption back.
 *
 * The framing functions are tested for what they tell the model, because that
 * is the whole of their job. The component is React and cannot be mounted by
 * this suite, so what is pinned there is an arrangement: which call happens
 * before which, and how many places in the file may write an assistant bubble.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  frameAssistantReport,
  handoffAcknowledgement,
  isAssistantReportEcho,
} from "../src/services/voice/assistantHandoff.ts";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

/* ── What she is told while the assistant works ───────────────────────────── */

test("the handoff hands her own note back to be said", () => {
  const ack = handoffAcknowledgement("Let me look.");
  assert.match(ack, /Say exactly this to the user, then stop: "Let me look\."/);
});

test("the handoff says the answer is not here yet, and forbids inventing it", () => {
  const ack = handoffAcknowledgement("One second.");
  // The whole reason the call was left BLOCKING is that she must not build an
  // answer on facts that have not arrived. Ending the block early gives that
  // back to her as a floor she holds with the question still open, so the
  // response has to say both halves out loud.
  assert.match(ack, /has not reported back/i, "she must be told she has no answer yet");
  assert.match(ack, /Do not answer the question yourself/i, "the gap must be named as a gap");
  assert.match(ack, /do not guess/i);
  // And it must not invite her to narrate work she cannot see, which is the
  // failure that put invented accounts of unstarted work into her mouth.
  assert.match(ack, /do not describe what the assistant is doing/i);
});

test("a missing note still leaves her something to say", () => {
  // `spoken_note` is required on the declaration, so an empty one means the
  // model skipped it. Silence is the one outcome this path exists to prevent.
  for (const empty of ["", "   "]) {
    assert.match(handoffAcknowledgement(empty), /then stop: "One moment\."/);
  }
});

/* ── What she is told when the report lands ───────────────────────────────── */

test("a report is answered from, not read out", () => {
  const framed = frameAssistantReport("The Desktop folder is 38 gigabytes.");
  // Not "say this". The tool path was proven by her turning a report into a
  // sentence of her own, and reciting it instead is how the shell command
  // ended up spoken aloud.
  assert.doesNotMatch(framed, /Say this to the user now/i);
  assert.match(framed, /reported back: "The Desktop folder is 38 gigabytes\."/);
  assert.match(framed, /using only what is in that report/i);
  assert.match(framed, /Do not add any number, name, date, path or version/i);
});

test("a framed report is recognised if it ever comes back as speech", () => {
  // It should not: a text turn produces no `inputTranscription` on this lane.
  // The guard is here because the cost is a regex and the failure is a loop
  // that classifies our own framing as work and delegates it again.
  assert.equal(isAssistantReportEcho(frameAssistantReport("38 gigabytes.")), true);
  assert.equal(isAssistantReportEcho("  [The assistant has reported back: x"), true);
  assert.equal(isAssistantReportEcho("The assistant has reported back"), false);
  assert.equal(isAssistantReportEcho("How big is my Desktop folder?"), false);
  assert.equal(isAssistantReportEcho(""), false);
});

/* ── The arrangement in the stage ─────────────────────────────────────────── */

test("the tool call is answered before the agent is awaited, not after", async () => {
  const stage = await readSource("../src/components/voice/TemiVoiceStage.tsx");
  const answered = stage.indexOf("sendToolResponse(msg.id, msg.name, handoffAcknowledgement(note))");
  const awaited = stage.indexOf("await TeminaliAgentBridge.delegateTask(task");
  assert.ok(answered > 0, "the handoff response is not sent at all");
  assert.ok(awaited > 0, "the agent is not delegated to");
  assert.ok(
    answered < awaited,
    "the blocking call must be released before the run starts, or she is silent for all of it",
  );
});

test("the report reaches her as a turn of its own, never as the function response", async () => {
  const stage = await readSource("../src/components/voice/TemiVoiceStage.tsx");
  const branch = stage.slice(stage.indexOf("await TeminaliAgentBridge.delegateTask(task"));
  const body = branch.slice(0, branch.indexOf("})();"));
  assert.doesNotMatch(
    body,
    /sendToolResponse/,
    "the report went back as the function response, which is the blocking wait this fix removed",
  );
  assert.match(body, /speakLineRef\.current\(capped[\s\S]{0,80}"report"\)/);
});

test("only one place in the stage writes an assistant bubble that is not spoken", async () => {
  const stage = await readSource("../src/components/voice/TemiVoiceStage.tsx");
  // Four sites, and the count is the test. The rule is that no site may write a
  // bubble ALONGSIDE the speaker; each of these writes instead of it.
  //
  // Two are in `commitSpokenTurn`, the turn she was cut off in and the turn she
  // finished, and both record words that were actually said. The third is the
  // timeout fallback in `speakLine`, for a line the voice never took. The
  // fourth is the muted branch of `speakLine`, added when `mute` arrived: a
  // muted assistant has the transcript and nothing else, so there the written
  // surface is the only surface rather than the last resort.
  //
  // A fifth means something is writing a bubble next to a line she is also
  // saying, which is the defect this file exists for.
  const appends = stage.match(/id: `asst-\$\{Date\.now\(\)\}`/g) ?? [];
  assert.equal(appends.length, 4, `expected 4 assistant append sites, found ${appends.length}`);
});

test("the delegate path no longer writes the report and speaks it too", async () => {
  const stage = await readSource("../src/components/voice/TemiVoiceStage.tsx");
  const handler = stage.slice(stage.indexOf("onCompleted: (finalReport) =>"));
  const body = handler.slice(0, handler.indexOf("},"));
  assert.doesNotMatch(body, /setDialogueHistory/, "the written copy is back, and so is the double bubble");
  assert.match(body, /speakLineRef\.current\(finalReport, "report"\)/);
});
