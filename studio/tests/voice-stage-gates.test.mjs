/**
 * The gates on the voice stage, pinned where they are fragile.
 *
 * The audit of 2026-09-12 traced eleven spoken sentences parse-to-executor and
 * found the same shape under most of them: the logic existed, was correct, was
 * tested, and was wired to nothing. `scoreAddressing`, `stripWakeWord` and
 * `selfAudio.audibleSince` had exactly one caller between them —
 * `services/voice/conversation.ts`, which nothing mounts — so the live stage
 * took every final transcript as an instruction. `GeminiLiveEngine` called
 * `this.onError?.()` from eight places and the handler was never assigned.
 * `useSpokenApproval` was mounted on two chat surfaces and not on the voice one.
 *
 * `TemiVoiceStage.tsx` is React and this suite cannot mount it, so what is
 * pinned here is the same thing `voice-editor-wiring.test.mjs` pins: order,
 * gating, and which line gets spoken. Where a gate is real logic rather than
 * arrangement — addressing, self-audio — the helper is tested directly.
 *
 * Each test names the spoken sentence that breaks if the arrangement regresses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { scoreAddressing, stripWakeWord, FOLLOW_UP_WINDOW_MS } from "../src/services/voice/addressing.ts";
import { SelfAudioMonitor, SELF_AUDIO_TAIL_MS } from "../src/services/voice/selfAudio.ts";

const stage = await readFile(new URL("../src/components/voice/TemiVoiceStage.tsx", import.meta.url), "utf8");

/** The context the stage actually builds: a hands-free screen, no enrolment. */
const stageContext = (over = {}) => ({
  assistantAskedQuestion: false,
  msSinceAssistantTurn: 60_000,
  speakerMatch: null,
  hasProfile: false,
  requireWakeWord: false,
  requireSpeakerMatch: false,
  wakeWords: ["temy", "temi", "teminali"],
  windowFocused: true,
  ...over,
});

const directed = (text, over) => scoreAddressing(text, stageContext(over)).verdict.directed;

/* ── The addressing blend, as the stage asks it ──────────────────────────── */

test('"tell him to run the tests" is the room, not a command', () => {
  // The headline defect: room speech carrying a machine verb reached the switch,
  // was classified as work, and delegated a real run to the assistant.
  assert.equal(directed("tell him to run the tests"), false);
  assert.equal(directed("hold on, I'll call you back"), false);
  assert.equal(directed("she said the build was fine"), false);
});

test('"open the terminal" still lands, because the session was opened on purpose', () => {
  // The gate must not become a wake-word prison. In a room where the assistant
  // is listening deliberately, an ordinary sentence is for it.
  for (const line of ["open the terminal", "what's in this repo", "can you hear me"]) {
    assert.equal(directed(line), true, line);
  }
});

test('"hold on" said to a person no longer cancels the run', () => {
  /*
    "hold on" is in STOP_PHRASES and in THIRD_PARTY_MARKERS both, and the
    unconditional stop fast path at addressing.ts ran first — so a sentence
    meant for somebody in the room came back DIRECTED at 0.99 and killed a run
    in flight. A phrase in both lists is ambiguous and the name settles it.
  */
  assert.equal(directed("hold on"), false);
  assert.equal(directed("one second"), false);
  assert.equal(directed("subiri"), false);
});

test('"stop" is still unconditional — nothing ambiguous was traded away', () => {
  for (const line of ["stop", "cancel that", "abort", "wait", "shut up"]) {
    assert.equal(directed(line), true, line);
  }
  // And the name is what settles the ambiguous ones the other way.
  assert.equal(directed("temy hold on"), true);
});

test('"yes" answers her question inside the window, and is praise outside it', () => {
  // She asked "should I run the tests?". Without the follow-up window this one
  // word is a stray utterance in a room and is dropped before anything sees it.
  assert.equal(directed("yes", { assistantAskedQuestion: true, msSinceAssistantTurn: 1_000 }), true);
  assert.equal(
    directed("yes", { assistantAskedQuestion: true, msSinceAssistantTurn: FOLLOW_UP_WINDOW_MS + 1_000 }),
    false,
    "a `yes` half a minute later is not the answer to anything",
  );
});

test('"Temy, open DukaBot" reaches the switch as a command, not as a greeting', () => {
  const { text, matched } = stripWakeWord("Temy, open DukaBot", ["temy", "teminali"]);
  assert.equal(matched, true);
  assert.equal(text, "open DukaBot");
});

/* ── The self-audio monitor, which decides what "the app is audible" means ── */

test("a film playing in the Files panel keeps the microphone suspect", () => {
  const monitor = new SelfAudioMonitor();
  const turnStart = 1_000_000;

  monitor.set("video", true, turnStart);
  assert.equal(monitor.audibleSince(turnStart, turnStart), true, "it is playing right now");

  // Paused half a second into the turn: part of this transcript IS the film.
  monitor.set("video", false, turnStart + 500);
  assert.equal(monitor.audibleSince(turnStart, turnStart + 600), true);

  // And the recogniser's own lag is covered after that.
  assert.equal(monitor.audibleSince(turnStart + 1_000, turnStart + 1_000), true);

  // A turn long after the room went quiet is an ordinary turn again.
  const later = turnStart + 500 + SELF_AUDIO_TAIL_MS + 1_000;
  assert.equal(monitor.audibleSince(later, later), false);
});

/* ── The arrangement in the stage ────────────────────────────────────────── */

test("the spoken gate runs on the final transcript, before anything acts on it", () => {
  const gate = stage.indexOf("gateSpokenTurnRef.current(clean, turnStartedAt)");
  const transcribe = stage.indexOf("// Update last user bubble if from this same turn");
  const routed = stage.indexOf('performTurnRef.current?.(routed, "spoken")');
  assert.ok(gate > 0 && transcribe > 0 && routed > 0, "all three must exist");
  assert.ok(gate < transcribe, "a stranger's sentence is not part of this conversation and is not transcribed");
  assert.ok(gate < routed, "gating after routing is not gating");
});

test("a turn that was not ours cuts the model off instead of letting her answer it", () => {
  /*
    "OpenAI has blessed us" — a line of video dialogue, committed as a turn and
    answered. Gemini's VAD closes the turn and begins generating the moment the
    room stops talking, so rejecting the transcript and doing nothing else
    leaves her replying to a film.
  */
  const block = stage.slice(
    stage.indexOf("const routed = gateSpokenTurnRef.current"),
    stage.indexOf("// Update last user bubble if from this same turn"),
  );
  assert.ok(/if \(routed === null\)/.test(block));
  assert.ok(/protocol\.sendBargeIn\(\)/.test(block));
  assert.ok(/audio\.stopTTSPlayback\(\)/.test(block));
  assert.ok(/\breturn;/.test(block), "a rejected turn must not fall through to the switch");
});

test("the gate asks provenance before it asks addressing", () => {
  const gate = stage.slice(stage.indexOf("const gateSpokenTurn ="), stage.indexOf("const gateSpokenTurnRef ="));
  const self = gate.indexOf("selfAudio.audibleSince(turnStartedAt)");
  const score = gate.indexOf("scoreAddressing(heard,");
  assert.ok(self > 0 && score > 0 && self < score, "no gate that asks who a sentence was for can tell a film from a person");
  assert.ok(
    /if \(!wakeWord\)/.test(gate.slice(self)),
    '"Temy, pause the video" is the turn most needed while something is playing, and it must still land',
  );
  assert.ok(/requireWakeWord: false/.test(gate), "the operator opened a hands-free screen; the name is not the price of using it");
  assert.ok(/hasProfile: false/.test(gate), "there is no enrolment on this surface and none must be claimed");
});

test('"pause" pauses the video instead of cancelling the agent run', () => {
  /*
    CONTRACT P. "pause" is in STOP_PHRASES, so with a video playing and a run in
    flight the router classified it as a stop: the run died and the video kept
    playing. The ordering is the whole fix.
  */
  const player = stage.indexOf("handleSpokenPlayerCommand(clean)");
  const approval = stage.indexOf("spokenApproval.consume(clean)");
  const workspace = stage.indexOf("parseWorkspaceCommand(clean");
  const editor = stage.indexOf("parseEditorCommand(clean)");
  const router = stage.indexOf("const decision = routeVoiceTurn");
  assert.ok(player > 0, "the transport must be asked");
  for (const [name, at] of [["approval", approval], ["workspace", workspace], ["editor", editor], ["router", router]]) {
    assert.ok(at > 0 && player < at, `the transport must be asked before ${name}`);
  }
});

test("a handled transport command speaks its own line and stops there", () => {
  const block = stage.slice(
    stage.indexOf("const player = handleSpokenPlayerCommand(clean)"),
    stage.indexOf("spokenApproval.consume(clean)"),
  );
  assert.ok(/if \(player\.handled\)/.test(block));
  assert.ok(/speakLineRef\.current\(player\.reply, "verbatim"\)/.test(block));
  assert.ok(/\breturn;/.test(block), "falling through would then also stop the run");
});

test('"yes go ahead" answers the standing permission prompt', () => {
  /*
    `useSpokenApproval` was mounted in StudioChat and AgentPane and never here,
    so on the one screen that is driven by voice both "approve that" and "yes go
    ahead" routed as conversation and the prompt went on standing.
  */
  assert.ok(/useSpokenApproval\(approvalVoiceRef\)/.test(stage), "the hook must be mounted on this surface");
  const consume = stage.indexOf("spokenApproval.consume(clean)");
  const router = stage.indexOf("const decision = routeVoiceTurn");
  assert.ok(consume > 0 && consume < router, "the model must not be asked to do something about the word `yes`");
  // And the prompt has to reach the store the hook reads, or `consume` has
  // nothing to consume.
  assert.ok(/store\.offer\(\{/.test(stage) && /useApprovalStore\.getState\(\)/.test(stage));
  assert.ok(/describeApprovalRequest\(\{/.test(stage), "this stage's voice is the socket, so it does its own asking");
});

test('"ask Claude Code to run the tests" carries the operator\'s hand on the gate', () => {
  /*
    CONTRACT B. With no `approveCommand` in the delegate options, aiService
    answers every permission event `deny` in about a millisecond: the run is
    over before anyone is asked anything, and reports a refusal nobody made.
  */
  const passes = stage.match(/approveCommand: approveRef\.current\.approveCommand/g) ?? [];
  assert.equal(passes.length, 2, "both delegate paths — the switch and her own tool call — must pass it");
  assert.ok(/useCommandApproval\(\)/.test(stage), "the same hook the chat uses, so the allowlist is one list");
  assert.ok(
    /onClick=\{\(\) => commandApproval\.approve\(false\)\}/.test(stage),
    "a prompt that can only be answered out loud hangs the run when the microphone is muted",
  );
});

test('"mhm" while she is mid-sentence does not kill her sentence', () => {
  /*
    `acknowledge` fired `suppressPipelineAnswer`, which barged in, and then
    `case "acknowledge"` was a bare `break` — so the operator agreed with her
    and she stopped mid-word with nothing to replace it.
  */
  assert.ok(
    /const backchannel = decision\.action\.kind === "acknowledge" && isSpeakingRef\.current;/.test(stage),
  );
  assert.ok(
    /if \(source === "spoken" && decision\.suppressPipelineAnswer && !answeringHerQuestion && !backchannel\)/.test(stage),
    "a backchannel is how a person shows they are still listening, not an interruption",
  );
});

test('"yes" to "should I run the tests?" is an answer, not praise', () => {
  const block = stage.slice(stage.indexOf("const answeringHerQuestion ="), stage.indexOf("switch (action.kind)"));
  assert.ok(/assistantAskedQuestionRef\.current/.test(block), "only the model knows what it offered to do");
  assert.ok(
    new RegExp(`Date\\.now\\(\\) - assistantTurnEndedAtRef\\.current < FOLLOW_UP_WINDOW_MS`).test(block),
    "the same window the addressing gate uses, or a `yes` it admits is then filed as praise",
  );
  assert.ok(
    /const action = answeringHerQuestion \? \(\{ kind: "converse" \} as const\) : decision\.action;/.test(stage),
    "`converse` on a spoken turn is exactly `let her own answer through`",
  );
  // The flag is a latch, not a mood: a second "yeah" must not re-answer it.
  assert.ok(/if \(answeringHerQuestion\) assistantAskedQuestionRef\.current = false;/.test(stage));
});

test("the question flag is set from her turns and nowhere else", () => {
  assert.ok(
    /assistantAskedQuestionRef\.current = content\.trim\(\)\.endsWith\("\?"\);/.test(stage),
    "her generated turn",
  );
  assert.ok(
    /assistantAskedQuestionRef\.current = line\.endsWith\("\?"\);/.test(stage),
    "a line the shell put in her mouth — and a line that is NOT a question closes the window",
  );
  assert.ok(
    /assistantTurnEndedAtRef\.current = Date\.now\(\);/.test(stage),
    "measured from when she stopped talking, not from when generation ended",
  );
});

test("tapping the orb to talk over her hushes, and does not stop the run", () => {
  const orb = stage.slice(stage.indexOf("const handleOrbClick ="), stage.indexOf("// ── The mode switch"));
  assert.ok(/audio\.isTTSPlaying/.test(orb) && /audio\.stopTTSPlayback\(\)/.test(orb));
  assert.ok(
    !/TeminaliAgentBridge\.stopCurrentTask\(\)/.test(orb),
    "the gesture that means `I have heard enough, carry on` threw the work away — the conflation DESIGN.md 6.8 forbids",
  );
});

test('"go mute", then tapping the orb, brings her back', () => {
  const orb = stage.slice(stage.indexOf("const handleOrbClick ="), stage.indexOf("// ── The mode switch"));
  assert.ok(
    /if \(audio\.isMuted\) \{\s*\n\s*const muted = audio\.toggleMute\(\);/.test(orb),
    "the mute line promises `tap the orb when you want me back`, and that door did not exist",
  );
  assert.ok(/setIsMicMuted\(muted\)/.test(orb));
  // Order matters: mid-sentence the tap is still an interrupt.
  assert.ok(orb.indexOf("audio.isTTSPlaying") < orb.indexOf("audio.isMuted"));
});

test("an engine error is heard by something", () => {
  /*
    `geminiLiveEngine` calls `this.onError?.()` from eight places — a refused
    token, a socket error event, a throw out of connect, a throw out of message
    handling, four send paths. None of them was assigned, so a dead voice lane
    was completely silent.
  */
  assert.ok(/protocol\.onError = \(error\) => \{/.test(stage));
  assert.ok(/setVoiceNote\(`Temi's voice hit an error: \$\{describeVoiceError\(error\)\}`\)/.test(stage));
  const connected = stage.indexOf("protocol.onConnected =");
  const errored = stage.indexOf("protocol.onError =");
  const message = stage.indexOf("protocol.onMessage =");
  assert.ok(connected < errored && errored < message, "assigned with the other handlers, before connect() is called");
  assert.ok(errored < stage.indexOf("void protocol.connect()"));
});

test("a voice failure is written out, not hidden in the tooltip of a 2.5px dot", () => {
  assert.ok(/\{voiceNote\}<\/span>/.test(stage), "the note must render as text a screen recording can show");
  assert.ok(/aria-live="polite"/.test(stage));
  assert.ok(/onClick=\{\(\) => setVoiceNote\(""\)\}/.test(stage), "persistent, but dismissible");
  // The dot keeps it too — it is the summary now, not the record.
  assert.ok(/title=\{statusTitle\}/.test(stage));
});

test('"undo that" survives a failed projects fetch on mount', () => {
  /*
    `isVideoProjectRef` is one boolean with three meanings. Set only from
    `WorkspaceService.listProjects`, whose failure path is a deliberate silent
    catch — so one failed fetch left it `false`, and `false` gated the entire
    editor lane off for the whole session with no error anywhere.
  */
  const lane = stage.slice(stage.indexOf("const editorLaneOpen ="), stage.indexOf("/* Fetched once, on mount"));
  assert.ok(/if \(projectKindKnownRef\.current\) return isVideoProjectRef\.current;/.test(lane));
  assert.ok(
    /tracks\.some\(\(track\) => track\.clips\.length > 0\)/.test(lane),
    "when the kind is unknown, a timeline with clips on it is a weaker signal but a true one",
  );
  assert.ok(/projectKindKnownRef\.current = true;/.test(stage), "and the gateway's answer sets it known");
  assert.ok(
    /import\("\.\.\/\.\.\/video\/store\/timelineStore"\)/.test(stage),
    "loaded lazily and only when needed — this screen usually never touches the editor",
  );
});

test("leaving the voice screen does not orphan a run started from it", () => {
  const cleanup = stage.slice(stage.indexOf("      audio.cleanup();"), stage.indexOf("  }, [logAction]);"));
  assert.ok(/if \(delegationsInFlightRef\.current > 0\)/.test(cleanup));
  assert.ok(
    /TeminaliAgentBridge\.stopCurrentTask\(\);/.test(cleanup),
    "onProgress toasts and onCompleted speaks, both into a component that no longer exists",
  );
  assert.ok(
    cleanup.indexOf("if (delegationsInFlightRef.current > 0)") <
      cleanup.indexOf("TeminaliAgentBridge.stopCurrentTask();"),
    "unconditional would abort a run the chat started every time the operator glanced at this screen",
  );
  // The counter has to be kept by both delegate paths or the guard is a lie.
  assert.equal((stage.match(/delegationsInFlightRef\.current \+= 1/g) ?? []).length, 2);
});
