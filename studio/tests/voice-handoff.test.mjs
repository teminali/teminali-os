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

/* ── When she must NOT reach for it ───────────────────────────────────────── */

test("the declaration does not make plain doubt a reason to delegate", async () => {
  /* Reported off a three-way conversation: she reached for the assistant when
     she simply had not understood, and the assistant cannot hear the room. The
     old closing line was "When in any doubt, call this", which reads as one.
     The anti-fabrication rules above it stay; only the unbounded doubt goes. */
  const engine = await readSource("../src/services/voice/geminiLiveEngine.ts");
  assert.doesNotMatch(engine, /in any doubt, call this/i);
  assert.match(engine, /doubt[\s\S]{0,40}about what the operator MEANT is not what this is for/);
  assert.match(engine, /If you did not follow something, ask them/);
  assert.match(engine, /Never guess a number, a path, a version or a date/, "the fabrication rule was dropped with it");
});

test("the persona keeps talk with the voice and facts with the hands", async () => {
  const persona = await readSource("../src/services/voice/temiPersona.ts");
  assert.match(persona, /Not understanding is never a reason to ask it/);
  assert.match(persona, /When the turn is talk rather than a task, it is yours/);
  assert.match(persona, /the moment you are about to say something specific nobody told you, ask it instead/);
});

/* ── What the system instruction is allowed to cost ───────────────────────── */

test("a full store cannot quietly double the system instruction", async () => {
  /* `buildTemiPersona` splices a recall block into the persona at session
     setup (DESIGN.md 6.48, recall tier). Every character of it is processed on
     every session, so the block's size is a real cost and not a detail, and
     there was no ceiling on it anywhere until this test.

     Three stores, all at the policy cap of 320. Anchors are the axis that
     matters, because `selectForRecall` takes every one of them before anything
     else can compete for the budget: an anchor-heavy store crowds the other
     kinds out and a lean one leaves room for all four sections, which is the
     more expensive shape. The third is the worst RENDER, many very short atoms,
     because line count is the thing a character budget cannot see from
     outside. The numbers below are measured, not chosen: 18,478 characters of
     persona, and a block that peaks at 2,940. The ceiling sits a little above
     the peak and a long way below a doubling. */
  const { TEMI_PERSONA, buildTemiPersona } = await import("../src/services/voice/temiPersona.ts");
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  const build = (shares, text) => {
    const atoms = [];
    let n = 0;
    for (const [kind, count] of Object.entries(shares)) {
      for (let i = 0; i < count; i += 1) {
        n += 1;
        atoms.push({
          id: `a${String(n).padStart(3, "0")}`,
          kind,
          text: text(kind, n),
          gist: `${kind} ${n}`,
          axes: { weight: (n % 9) / 10, warmth: (n % 7) / 8, surprise: (n % 5) / 6, firstness: (n % 3) / 4 },
          bornAt: NOW - n * 3 * DAY,
          lastTouchedAt: NOW - (n % 300) * DAY,
          rehearsals: n % 4,
          faded: n % 11 === 0,
        });
      }
    }
    return atoms;
  };

  const sentence = (kind, n) => `A ${kind} about him, number ${n}, written at the length one of these really runs to.`;
  const stores = {
    "a long relationship": build({ anchor: 40, fact: 120, keepsake: 110, thread: 50 }, sentence),
    "room for all four sections": build({ anchor: 12, fact: 140, keepsake: 118, thread: 50 }, sentence),
    "the shape that renders worst": build({ anchor: 320, fact: 0, keepsake: 0, thread: 0 }, (_, n) => `a${n}`),
  };

  for (const [label, atoms] of Object.entries(stores)) {
    assert.equal(atoms.length, 320, label);
    const composed = buildTemiPersona(atoms, NOW, { random: () => 0.42 });
    const block = composed.length - TEMI_PERSONA.length;
    assert.ok(block > 0, `${label}: nothing was recalled at all`);
    assert.ok(block <= 3200, `${label}: the recall block grew to ${block} characters`);
    assert.ok(composed.length <= 22_000, `${label}: the system instruction grew to ${composed.length}`);
  }

  // And the other half of the same guarantee: no store, no cost.
  assert.equal(buildTemiPersona([], NOW), TEMI_PERSONA);
});
