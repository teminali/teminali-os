/**
 * Who owns a generation, and how long a barge-in lasts.
 *
 * `sendBargeIn()` is a LOCAL guard. Gemini Live has no "cancel this
 * generation" message, so when the shell answers a turn itself the model keeps
 * generating server-side and the engine simply stops forwarding what arrives.
 * One counter decides what is forwarded, which makes two questions load-bearing
 * and both of them were wrong in ways nothing on screen showed.
 *
 * WHEN A TURN GETS ITS NUMBER. Generations used to be minted by audio alone.
 * Nothing retires a suppression except the counter moving past it, so a
 * condemned turn that produced no audio never advanced it, and the suppression
 * stayed armed and silenced the NEXT turn: a question nobody had barged in on
 * came back mute. It was masked rather than prevented, because
 * `ask_the_assistant` requires a `spoken_note` and a condemned turn therefore
 * almost always had audio in it. The number is now minted by the first CONTENT
 * of a turn, her words, her voice or her hands alike.
 *
 * HOW LONG A BARGE-IN LASTS. `sendBargeIn()` used to clear `turnActive`, which
 * told the next chunk of the SAME turn that it was a new turn. It minted itself
 * a fresh generation, and a fresh generation is not the condemned one, so she
 * carried on speaking over the answer the shell had just given. That was
 * survivable only because every call site sits inside the stage's synchronous
 * handling of `final_user_request`, which the engine emits at her first word.
 * Minting on first content closed that window, since her first word now raises
 * the flag before the barge-in it triggers can read it.
 *
 * `handleServerMessage` is private to TypeScript and ordinary at runtime, so
 * the inbound behaviour is driven with the message shapes Gemini sends, no
 * socket and no mock of the SDK, exactly as `voice-live-resilience.test.mjs`
 * does it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { GeminiLiveEngine } from "../src/services/voice/geminiLiveEngine.ts";

/** An engine with its outbound messages collected. Never connected. */
function harness() {
  const engine = new GeminiLiveEngine();
  const messages = [];
  engine.onMessage = (msg) => messages.push(msg);
  engine.onNote = () => {};
  engine.onError = () => {};
  const seen = (type) => messages.filter((m) => m.type === type);
  return { engine, messages, seen };
}

/** One 24 kHz PCM frame, base64. Two silent samples is enough; the resampler
    is not what is under test here. */
const AUDIO = { data: Buffer.from(new Int16Array([0, 0]).buffer).toString("base64") };
const says = (text) => ({ serverContent: { outputTranscription: { text } } });
const hears = (text) => ({ serverContent: { inputTranscription: { text } } });
const TURN_END = { serverContent: { turnComplete: true } };
const delegates = (id = "call-1") => ({
  toolCall: {
    functionCalls: [{ id, name: "ask_the_assistant", args: { task: "Run the test suite.", spoken_note: "Let me look." } }],
  },
});

// ──────────────────────────────── a suppression that outlived its own turn

test("a condemned turn that only reached for a tool does not silence the next one", () => {
  // The leak in its sharpest form. The shell answered the turn and barged in;
  // the model's condemned turn produced a call and nothing else, so under
  // mint-on-audio the counter never moved and the suppression was still armed
  // when the operator asked their NEXT question. She answered it into a void.
  const { engine, seen } = harness();
  engine.sendBargeIn();
  engine.handleServerMessage(delegates());
  engine.handleServerMessage(TURN_END);
  assert.equal(seen("tool_call").length, 0, "the condemned turn's call was forwarded");

  engine.handleServerMessage(says("Thirty eight gigabytes."));
  engine.handleServerMessage(AUDIO);
  assert.equal(seen("partial_assistant_answer").length, 1, "the next turn's words were eaten by a stale suppression");
  assert.equal(seen("tts_audio").length, 1, "the next turn's voice was eaten by a stale suppression");
});

test("a condemned turn that only spoke words does not silence the next one", () => {
  // The same leak by the other silent route: a turn whose transcript arrived
  // but whose audio never did, a dropped frame or a turn cut off server-side.
  const { engine, seen } = harness();
  engine.sendBargeIn();
  engine.handleServerMessage(says("It is not something I keep an eye on"));
  engine.handleServerMessage(TURN_END);
  assert.equal(seen("partial_assistant_answer").length, 0, "the condemned turn reached the caption");

  engine.handleServerMessage(says("Thirty eight gigabytes."));
  assert.equal(seen("partial_assistant_answer").length, 1, "the next turn's words were eaten by a stale suppression");
});

test("the condemned turn is not committed to the router either", () => {
  // Suppression has to reach `final_assistant_answer`, not just the caption:
  // that is the message the router reads, and a superseded line in it is the
  // measured "It is not something I keep an eye on directly.38 gigabytes."
  const { engine, seen } = harness();
  engine.sendBargeIn();
  engine.handleServerMessage(says("It is not something I keep an eye on directly."));
  engine.handleServerMessage(TURN_END);
  assert.equal(seen("final_assistant_answer").length, 0);
});

// ──────────────────────────────────────── a barge-in that ends where it should

test("a barge-in after she has started speaking silences the REST of that turn", () => {
  // `sendBargeIn()` used to clear `turnActive`, so the very next chunk of the
  // turn it had just condemned minted itself a new generation and escaped the
  // gate. She talked straight over the answer the shell had given.
  const { engine, seen } = harness();
  engine.handleServerMessage(AUDIO);
  assert.equal(seen("tts_audio").length, 1, "the turn was not speaking to begin with");

  engine.sendBargeIn();
  engine.handleServerMessage(AUDIO);
  engine.handleServerMessage(says(" and that is why."));
  assert.equal(seen("tts_audio").length, 1, "the condemned turn kept talking after the barge-in");
  assert.equal(seen("partial_assistant_answer").length, 0, "the condemned turn kept captioning after the barge-in");

  engine.handleServerMessage(TURN_END);
  assert.equal(seen("final_assistant_answer").length, 0, "the condemned tail was committed to the router");
});

test("a mid-turn barge-in still expires at the turn boundary", () => {
  // The complement, and the thing not clearing `turnActive` must not break: a
  // suppression is one generation wide, not a switch that stays off. If the
  // flag were left standing past the end of the turn the operator would be
  // answered in silence from then on, which is far worse than the bug above.
  const { engine, seen } = harness();
  engine.handleServerMessage(AUDIO);
  engine.sendBargeIn();
  engine.handleServerMessage(TURN_END);

  engine.handleServerMessage(says("Next question, answered."));
  engine.handleServerMessage(AUDIO);
  engine.handleServerMessage(TURN_END);
  assert.equal(seen("partial_assistant_answer").length, 1);
  assert.equal(seen("final_assistant_answer").length, 1);
  assert.equal(seen("tts_audio").length, 2, "the turn after the condemned one is mute");
});

// ─────────────────────────────────────────────── the shipped path, unchanged

test("a barge-in before she has spoken still takes both halves of the turn", () => {
  // The common case and the one that ships: the shell decides to answer the
  // moment the transcript lands, which is before she has said a word.
  const { engine, seen } = harness();
  engine.sendBargeIn();
  engine.handleServerMessage(says("It is not something I keep an eye on"));
  engine.handleServerMessage(AUDIO);
  engine.handleServerMessage(delegates());
  assert.equal(seen("partial_assistant_answer").length, 0);
  assert.equal(seen("tts_audio").length, 0);
  assert.equal(seen("tool_call").length, 0);
  assert.equal(engine.pendingToolCalls.size, 0, "a dropped call left pending never closes its turn");
});

test("the stage's own re-entrant barge-in condemns the turn that triggered it", () => {
  // This is how every call site actually fires. `TemiVoiceStage` answers
  // `final_user_request` SYNCHRONOUSLY, and the engine emits that from inside
  // the transcript branch at her first word, so `sendBargeIn()` runs in the
  // middle of `handleServerMessage` for the very message it has to condemn.
  // The order of the mint and the emit inside that branch is what this pins.
  const { engine } = harness();
  const messages = [];
  engine.onMessage = (msg) => {
    messages.push(msg);
    if (msg.type === "final_user_request") engine.sendBargeIn();
  };
  const count = (type) => messages.filter((m) => m.type === type).length;

  engine.handleServerMessage(hears("how much disk have I got"));
  // Her first word finalises the operator's turn, the stage answers it itself,
  // and the barge-in lands before this same message is gated.
  engine.handleServerMessage({
    serverContent: { outputTranscription: { text: "It is not something I keep" } },
    data: AUDIO.data,
  });
  assert.equal(count("final_user_request"), 1, "the operator's turn never reached the router");
  assert.equal(count("partial_assistant_answer"), 0, "her words survived a barge-in fired on her first word");
  assert.equal(count("tts_audio"), 0, "her voice survived a barge-in fired on her first word");

  engine.handleServerMessage(TURN_END);
  engine.handleServerMessage(says("Thirty eight gigabytes."));
  assert.equal(count("partial_assistant_answer"), 1, "the turn after the barge-in is mute");
});

// ─────────────────────────────────────────────────────── one turn, one number

test("words then audio in one turn share one generation", () => {
  // The mint is idempotent within a turn. If it were not, the audio would land
  // on a second generation with `upsampleAnchor` back at zero and interpolate
  // its first sample up from silence in the middle of her sentence.
  const { engine } = harness();
  engine.handleServerMessage(says("Opening it now"));
  const minted = engine.generation;
  engine.handleServerMessage(AUDIO);
  engine.handleServerMessage(says(" for you."));
  engine.handleServerMessage(AUDIO);
  assert.equal(engine.generation, minted, "a single turn was split across two generations");
  engine.handleServerMessage(TURN_END);
  engine.handleServerMessage(AUDIO);
  assert.equal(engine.generation, minted + 1, "the next turn did not get a number of its own");
});

test("a tool call mints the turn it arrives in", () => {
  // The measured frame order puts `toolCall` ahead of the audio and the
  // transcript on a delegating turn, so the call is that turn's first content.
  const { engine } = harness();
  engine.handleServerMessage(delegates());
  const minted = engine.generation;
  assert.equal(minted, 1, "the delegating turn was never numbered");
  engine.handleServerMessage(AUDIO);
  assert.equal(engine.generation, minted, "the spoken note landed on a second generation");
});

// ──────────────────────────────── a transcript that outlived its own turn

test("an interrupted turn does not deliver its words as the next turn's answer", () => {
  /* One reply on screen twice, traced back to here. `interrupted` drops the
     queued audio and returns, and nothing but `turnComplete` clears the text,
     so the cut turn's words sat in the accumulator and came back as the NEXT
     turn's `final_assistant_answer`. The stage then held a pending it could
     not commit, and one turn later that stale pending committed the live turn
     twice. */
  const { engine, seen } = harness();
  engine.handleServerMessage(says("The build is broken and I think the"));
  engine.handleServerMessage(AUDIO);
  engine.handleServerMessage({ serverContent: { interrupted: true } });
  assert.equal(seen("tts_interrupt").length, 1, "the barge-in was not seen at all");

  engine.handleServerMessage(says("I like the sound of that."));
  engine.handleServerMessage(AUDIO);
  engine.handleServerMessage(TURN_END);

  const finals = seen("final_assistant_answer");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].content, "I like the sound of that.");
});

test("an interrupted turn with nothing after it answers nothing", () => {
  // The same clear, in the case where no second turn ever arrives: the cut
  // words must not surface later on their own.
  const { engine, seen } = harness();
  engine.handleServerMessage(says("Let me tell you about the"));
  engine.handleServerMessage(AUDIO);
  engine.handleServerMessage({ serverContent: { interrupted: true } });
  engine.handleServerMessage(TURN_END);
  assert.equal(seen("final_assistant_answer").length, 0, "a cut turn was answered after the fact");
});
