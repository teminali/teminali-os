/**
 * "Pause" pauses the video, and almost nothing else does.
 *
 * `parsePlayerCommand` is the FIRST fast path of a spoken turn — ahead of the
 * workspace parse, the editor parse and the router — so a false positive here
 * does not merely do the wrong thing, it steals the sentence from every other
 * lane before they are asked. That is why most of this file is refusals: every
 * accepted phrase below is one an operator actually says at a video, and every
 * refused one is a sentence carrying the same verb that means something else.
 *
 * A null answer is not a failure. It means the turn carries on to the workspace
 * parse, the editor parse and the router, which is exactly where all of these
 * went before this module existed.
 *
 * The pane is the second guard and the one the words cannot supply: bare
 * "pause" is claimed here, and `handleSpokenPlayerCommand` still answers
 * `{ handled: false }` for it when no player is mounted, so the stop reading
 * that `turnIntent` has always given the word survives untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  handleSpokenPlayerCommand,
  parsePlayerCommand,
  parseSpokenSeconds,
  spellSeconds,
} from "../src/services/voice/playerActions.ts";
import { PLAYER_ACTIONS, subscribePlayerCommands } from "../src/services/playerControl.ts";
import { classifyMachineAction } from "../src/services/voice/machineAction.ts";

/** A player that is open, at half volume and normal speed. */
const live = { volume: 0.5, rate: 1, playing: true, muted: false, fullscreen: false };

const parse = (text, snapshot = live) => parsePlayerCommand(text, snapshot);
const action = (text, snapshot = live) => parse(text, snapshot)?.command.action ?? null;
const command = (text, snapshot = live) => parse(text, snapshot)?.command ?? null;

/* ── the ceiling ─────────────────────────────────────────────────────────── */

test("every action this parse can emit is one the executor runs", () => {
  // `PLAYER_ACTIONS` is the contract the pane and the gateway are both checked
  // against. An action invented here would be a confirmation spoken over
  // nothing happening.
  const spoken = [
    "play", "pause", "play pause", "start it over", "next episode", "previous episode",
    "go to 1:20", "skip forward thirty seconds", "set the volume to 40", "volume up",
    "mute the video", "unmute it", "full screen", "exit full screen", "double speed",
    "turn on subtitles", "subtitles off",
  ];
  for (const text of spoken) {
    const emitted = action(text);
    assert.ok(emitted, `"${text}" should be a player command`);
    assert.ok(PLAYER_ACTIONS.includes(emitted), `"${text}" emitted ${emitted}, which the executor has no case for`);
  }
});

/* ── play and pause ──────────────────────────────────────────────────────── */

test("play and pause name the state they want, not a toggle", () => {
  // `toggle` exists and flips, so "play" while playing would pause.
  assert.equal(action("play"), "play");
  assert.equal(action("play it"), "play");
  assert.equal(action("hit play"), "play");
  assert.equal(action("resume"), "play");
  assert.equal(action("start playback"), "play");
  assert.equal(action("keep playing"), "play");
  assert.equal(action("unpause"), "play");
  assert.equal(action("play the video"), "play");
  assert.equal(action("start the movie"), "play");
  assert.equal(action("pause"), "pause");
  assert.equal(action("pause it"), "pause");
  assert.equal(action("pause the video"), "pause");
  assert.equal(action("stop playing"), "pause");
  assert.equal(action("stop the video"), "pause");
  assert.equal(action("stop playback"), "pause");
  assert.equal(action("stop it there"), "pause");
  assert.equal(action("play pause"), "toggle");
  assert.equal(action("toggle playback"), "toggle");
});

test("bare stop is never claimed, and neither is anything else being stopped", () => {
  // `turnIntent` reads a bare stop as cancel-the-run, and that reading is the
  // one the operator needs under pressure. Pausing playback names its object —
  // except for the single word "pause", which the pane guard settles instead.
  assert.equal(parse("stop"), null);
  assert.equal(parse("stop it"), null);
  assert.equal(parse("stop that"), null);
  assert.equal(parse("stop the tests"), null);
  assert.equal(parse("stop the server"), null);
  assert.equal(parse("stop the build"), null);
  assert.equal(parse("stop the deployment"), null);
  assert.equal(parse("pause the build"), null);
  assert.equal(parse("pause the deployment"), null);
  assert.equal(parse("pause the agent"), null);
});

test("play in every sense that is not playback", () => {
  assert.equal(parse("play devil's advocate"), null);
  assert.equal(parse("play it safe"), null);
  assert.equal(parse("play it by ear"), null);
  assert.equal(parse("play along"), null);
  assert.equal(parse("play around with it"), null);
});

/* ── back to the top ─────────────────────────────────────────────────────── */

test("a restart names the film or the beginning", () => {
  assert.equal(action("start it over"), "restart");
  assert.equal(action("start the video over"), "restart");
  assert.equal(action("from the top"), "restart");
  assert.equal(action("play it from the beginning"), "restart");
  assert.equal(action("back to the start"), "restart");
  assert.equal(action("replay it"), "restart");
  assert.equal(action("play it again"), "restart");
  assert.equal(action("restart the video"), "restart");
});

test("restart on its own belongs to whatever is running", () => {
  // "Restart it" is what an operator says at a dev server all day. Reading it
  // as a rewind would take the film to zero and leave the server up.
  assert.equal(parse("restart"), null);
  assert.equal(parse("restart it"), null);
  assert.equal(parse("restart the server"), null);
  assert.equal(parse("start over"), null);
});

/* ── the next item ───────────────────────────────────────────────────────── */

test("next and previous name what they are the next of", () => {
  assert.equal(action("next episode"), "next");
  assert.equal(action("play the next one"), "next");
  assert.equal(action("skip to the next episode"), "next");
  assert.equal(action("the next one"), "next");
  assert.equal(action("previous episode"), "previous");
  assert.equal(action("go back to the previous episode"), "previous");
  assert.equal(action("play the previous track"), "previous");
  assert.equal(action("the last one"), "previous");
});

test("bare next is the next task, not the next episode", () => {
  assert.equal(parse("next"), null);
  assert.equal(parse("next up"), null);
  assert.equal(parse("what's next"), null);
  assert.equal(parse("next steps"), null);
  assert.equal(parse("move on to the next task"), null);
  assert.equal(parse("the next file"), null);
  assert.equal(parse("previous"), null);
  assert.equal(parse("the last commit"), null);
  assert.equal(parse("the last file"), null);
});

/* ── the playhead ────────────────────────────────────────────────────────── */

test("a seek carries the time the operator said, in seconds", () => {
  assert.deepEqual(command("go to 1:20"), { action: "seek", value: 80 });
  assert.deepEqual(command("jump to 30 seconds"), { action: "seek", value: 30 });
  assert.deepEqual(command("skip to two minutes"), { action: "seek", value: 120 });
  assert.deepEqual(command("seek to 1:05:30"), { action: "seek", value: 3930 });
  assert.deepEqual(command("take me to the 5 minute mark"), { action: "seek", value: 300 });
});

test("a nudge keeps its direction, and back is read before forward", () => {
  assert.deepEqual(command("skip forward thirty seconds"), { action: "seek_by", value: 30 });
  assert.deepEqual(command("go back ten seconds"), { action: "seek_by", value: -10 });
  assert.deepEqual(command("rewind 5 seconds"), { action: "seek_by", value: -5 });
  assert.deepEqual(command("forward a minute"), { action: "seek_by", value: 60 });
  assert.deepEqual(command("go back forty five seconds"), { action: "seek_by", value: -45 });
  assert.deepEqual(command("skip ahead two minutes"), { action: "seek_by", value: 120 });
});

test("a nudge with no number takes the player's own step", () => {
  // The same ten seconds the arrow keys move, from `PLAYER_LIMITS.seekStep`.
  assert.deepEqual(command("skip forward"), { action: "seek_by", value: 10 });
  assert.deepEqual(command("skip back"), { action: "seek_by", value: -10 });
  assert.deepEqual(command("rewind"), { action: "seek_by", value: -10 });
  assert.deepEqual(command("fast forward"), { action: "seek_by", value: 10 });
  assert.deepEqual(command("skip forward a bit"), { action: "seek_by", value: 10 });
});

test("go back on its own is navigation and is left alone", () => {
  // "Skip back" is about the film. "Go back" is how an operator returns to a
  // panel, a folder, or the point in the conversation he came from.
  assert.equal(parse("go back"), null);
  assert.equal(parse("go back to the dukabot folder"), null);
  assert.equal(parse("go back to the chat"), null);
  assert.equal(parse("take me back to the editor"), null);
  assert.equal(parse("go to the settings"), null);
});

test("a seek with no readable time is not a seek to zero", () => {
  assert.equal(parse("go to the good bit"), null);
  assert.equal(parse("skip forward a smidge"), null);
  assert.equal(parse("jump to the end"), null);
  assert.equal(parse("skip"), null);
  assert.equal(parse("skip it"), null);
  assert.equal(parse("skip that"), null);
  assert.equal(parseSpokenSeconds("go to the start"), null);
});

/* ── sound ───────────────────────────────────────────────────────────────── */

test("a volume step is read off the level the player reports", () => {
  // `volume` takes an ABSOLUTE value at the executor, so a delta needs the
  // snapshot. `PLAYER_LIMITS.volumeStep` is the same tenth the arrow keys move.
  assert.deepEqual(command("turn the volume up"), { action: "volume", value: 0.6 });
  assert.deepEqual(command("turn the volume down"), { action: "volume", value: 0.4 });
  assert.deepEqual(command("volume up"), { action: "volume", value: 0.6 });
  assert.deepEqual(command("volume down"), { action: "volume", value: 0.4 });
  assert.deepEqual(command("lower the volume"), { action: "volume", value: 0.4 });
  assert.deepEqual(command("make it louder"), { action: "volume", value: 0.6 });
  assert.deepEqual(command("turn the sound down"), { action: "volume", value: 0.4 });
});

test("a volume step with nothing to step from is not a guessed level", () => {
  // Half volume would be an invention, and the operator would hear it happen.
  assert.equal(parse("turn the volume up", null), null);
  assert.equal(parse("volume down", null), null);
  // A level the sentence states needs no snapshot at all.
  assert.deepEqual(parse("set the volume to 50", null)?.command, { action: "volume", value: 0.5 });
});

test("a stated level is read as a percentage and clamped by the executor's own helper", () => {
  assert.deepEqual(command("set the volume to 50"), { action: "volume", value: 0.5 });
  assert.deepEqual(command("turn the volume to 30 percent"), { action: "volume", value: 0.3 });
  assert.deepEqual(command("set the volume to 100"), { action: "volume", value: 1 });
});

test("turn it up is how you ask Temi to speak up, and is never the film", () => {
  // The single ambiguity the pane guard cannot settle: she is talking AND the
  // film is playing, and the words are identical. Under-matching is the answer.
  assert.equal(parse("turn it up"), null);
  assert.equal(parse("turn it down"), null);
  assert.equal(parse("louder"), null);
  assert.equal(parse("quieter"), null);
  assert.equal(parse("speak up"), null);
});

test("mute always names the thing being silenced", () => {
  assert.equal(action("mute the video"), "mute");
  assert.equal(action("mute it"), "mute");
  assert.equal(action("turn the sound off"), "mute");
  assert.equal(action("unmute it"), "unmute");
  assert.equal(action("turn the sound back on"), "unmute");
  assert.equal(action("sound on"), "unmute");
});

test("muting Temi herself never reaches the player", () => {
  // These are `turnIntent`'s hush phrases. Claimed here, they would silence the
  // film and leave the narration running — the request exactly inverted.
  assert.equal(parse("mute"), null);
  assert.equal(parse("mute yourself"), null);
  assert.equal(parse("go mute"), null);
  assert.equal(parse("be quiet"), null);
  assert.equal(parse("mute the narration"), null);
  assert.equal(parse("unmute"), null);
  assert.equal(parse("unmute yourself"), null);
});

/* ── the window ──────────────────────────────────────────────────────────── */

test("fullscreen is a verb-less sentence and still a command", () => {
  assert.deepEqual(command("full screen"), { action: "fullscreen", value: true });
  assert.deepEqual(command("fullscreen"), { action: "fullscreen", value: true });
  assert.deepEqual(command("go full screen"), { action: "fullscreen", value: true });
  assert.deepEqual(command("make it full screen"), { action: "fullscreen", value: true });
  assert.deepEqual(command("fullscreen it"), { action: "fullscreen", value: true });
  // `value` is explicit in both directions: the pane's own default is a toggle,
  // and "exit fullscreen" said while already windowed must not enter it.
  assert.deepEqual(command("exit full screen"), { action: "fullscreen", value: false });
  assert.deepEqual(command("leave fullscreen"), { action: "fullscreen", value: false });
  assert.deepEqual(command("get out of fullscreen"), { action: "fullscreen", value: false });
});

/* ── speed ───────────────────────────────────────────────────────────────── */

test("a speed the sentence states is used as said", () => {
  assert.deepEqual(command("double speed"), { action: "rate", value: 2 });
  assert.deepEqual(command("half speed"), { action: "rate", value: 0.5 });
  assert.deepEqual(command("normal speed"), { action: "rate", value: 1 });
  assert.deepEqual(command("play it at 1.5 speed"), { action: "rate", value: 1.5 });
  assert.deepEqual(command("play it at 2x"), { action: "rate", value: 2 });
});

test("a speed outside the executor's range is a misheard sentence, not a clamp", () => {
  // `clampRate` would turn "ten times speed" into 3× and report it done.
  assert.equal(parse("play it at ten times speed"), null);
  assert.equal(parse("play it at 10x"), null);
});

test("a speed step names the playback, because speed it up does not", () => {
  assert.deepEqual(command("play it faster"), { action: "rate", value: 1.25 });
  assert.deepEqual(command("slow the video down"), { action: "rate", value: 0.75 });
  assert.deepEqual(command("speed up the playback"), { action: "rate", value: 1.25 });
  assert.equal(parse("faster"), null);
  assert.equal(parse("slow down"), null);
  assert.equal(parse("speed it up"), null);
  assert.equal(parse("slow it down"), null);
  assert.equal(parse("hurry up"), null);
});

/* ── subtitles ───────────────────────────────────────────────────────────── */

test("subtitles go on and off by name", () => {
  assert.deepEqual(command("turn on subtitles"), { action: "subtitles", value: "on" });
  assert.deepEqual(command("show me the captions"), { action: "subtitles", value: "on" });
  assert.deepEqual(command("subtitles"), { action: "subtitles", value: "on" });
  assert.deepEqual(command("subtitles off"), { action: "subtitles", value: "off" });
  assert.deepEqual(command("hide the subtitles"), { action: "subtitles", value: "off" });
});

/* ── the frames that mean the sentence is about the action ───────────────── */

test("questions, negations and hypotheticals never act", () => {
  assert.equal(parse("don't pause it"), null);
  assert.equal(parse("should I pause it"), null);
  assert.equal(parse("why did you pause it"), null);
  assert.equal(parse("what if we pause it"), null);
  assert.equal(parse("if you pause it now it buffers"), null);
  assert.equal(parse("I would skip forward thirty seconds"), null);
});

test("a polite request is still a request", () => {
  // "Can you pause it" is a command on a voice call, not an enquiry.
  assert.equal(action("can you pause it"), "pause");
  assert.equal(action("temi, please pause the video"), "pause");
  assert.equal(action("okay skip forward thirty seconds please"), "seek_by");
  assert.equal(action("could you turn the volume down a bit"), "volume");
});

/* ── what she says ───────────────────────────────────────────────────────── */

test("the confirmation is one short sentence with the number in it", () => {
  assert.equal(parse("pause").spoken, "Paused.");
  assert.equal(parse("skip forward thirty seconds").spoken, "Forward 30 seconds.");
  assert.equal(parse("go back ten seconds").spoken, "Back 10 seconds.");
  assert.equal(parse("go to 1:20").spoken, "Jumping to 1 minute 20.");
  assert.equal(parse("turn the volume up").spoken, "Volume at 60 percent.");
  for (const text of ["pause", "skip forward thirty seconds", "go to 1:20", "double speed"]) {
    const line = parse(text).spoken;
    assert.ok(!/[*_`#\[\]]/.test(line), `"${line}" is not markdown-free`);
    assert.ok(line.split(/[.!?]/).filter(Boolean).length === 1, `"${line}" is more than one sentence`);
  }
});

test("durations are spoken the way a person says them, and a film has hours", () => {
  assert.equal(spellSeconds(1), "1 second");
  assert.equal(spellSeconds(30), "30 seconds");
  assert.equal(spellSeconds(-10), "10 seconds");
  assert.equal(spellSeconds(60), "1 minute");
  assert.equal(spellSeconds(90), "1 minute 30");
  assert.equal(spellSeconds(3930), "1 hour 5 minutes");
  assert.equal(spellSeconds(3600), "1 hour");
});

/* ── the pane guard ──────────────────────────────────────────────────────── */

test("with no player mounted, nothing is handled and the turn carries on", () => {
  // The whole reason `handled: false` and not an apology: every one of these
  // sentences has another reading downstream, and the operator gets it.
  for (const text of ["pause", "play", "stop playing", "skip forward thirty seconds", "full screen"]) {
    assert.deepEqual(handleSpokenPlayerCommand(text), { handled: false }, `"${text}" with no pane`);
  }
});

test("with a player mounted, the command reaches it and comes back described", () => {
  const seen = [];
  const stop = subscribePlayerCommands((command) => seen.push(command));
  try {
    assert.deepEqual(handleSpokenPlayerCommand("pause the video"), {
      handled: true, reply: "Paused.", action: "pause",
    });
    assert.deepEqual(handleSpokenPlayerCommand("skip forward thirty seconds"), {
      handled: true, reply: "Forward 30 seconds.", action: "seek_by",
    });
    // Still not a transport command, pane or no pane.
    assert.deepEqual(handleSpokenPlayerCommand("stop the tests"), { handled: false });
  } finally {
    stop();
  }
  assert.deepEqual(seen, [{ action: "pause" }, { action: "seek_by", value: 30 }]);
});

/* ── the same sentence with no player on screen ──────────────────────────── */

test("machineAction sees a media sentence the player parse declined", () => {
  // The second half of the fix. With no pane mounted these fall past
  // `handleSpokenPlayerCommand` into the gate, and before this change every one
  // of them read as conversation — which for a media sentence is the
  // fabrication case: the persona has no hands and says it turned the volume
  // down anyway.
  for (const text of [
    "skip forward thirty seconds", "go back ten seconds", "rewind two minutes",
    "turn the volume down", "turn the volume up", "volume up", "set the volume to 50",
    "full screen", "exit full screen", "double speed", "slow the video down",
    "turn on subtitles", "subtitles off", "skip to the next episode",
  ]) {
    assert.equal(classifyMachineAction(text)?.kind, "media", `"${text}" should be work`);
  }
});

test("the gate's new duration object belongs to playback and to nothing else", () => {
  // A span of time behind any other verb is a length of time the sentence
  // happens to mention. Reading those as work is the fabrication bug inverted.
  assert.equal(classifyMachineAction("pause for a second"), null);
  assert.equal(classifyMachineAction("wait a second"), null);
  assert.equal(classifyMachineAction("give me a second"), null);
  assert.equal(classifyMachineAction("check in a second"), null);
  // And navigation stays navigation, which is why "go back" is not a media verb.
  assert.equal(classifyMachineAction("go back to the landing project")?.kind, "workspace");
  assert.equal(classifyMachineAction("take me back to the editor")?.kind, "open");
  assert.equal(classifyMachineAction("stop the tests")?.kind, "shell");
  assert.equal(classifyMachineAction("don't turn the volume down"), null);
});
