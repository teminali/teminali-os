/**
 * "Cut here" cuts, and almost nothing else does.
 *
 * `parseEditorCommand` is the voice lane's only route into the video editor, and
 * the verbs it reaches are destructive in a way the workspace ones are not: a
 * wrong `split` or `delete_selected` damages the program, and a wrong
 * `export_project` occupies the machine for minutes. So the bulk of this file is
 * refusals. Every accepted phrase below is one an operator actually says at a
 * timeline; every refused one is a sentence that contains the same verb and
 * means something else.
 *
 * The null answer is not a failure. It means the turn carries on to
 * `machineAction` and the assistant, which is exactly where all of these went
 * before this module existed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  describeEditorResult,
  parseEditorCommand,
  parseSpokenMs,
  spellMs,
} from "../src/services/voice/editorActions.ts";

const parse = (text) => parseEditorCommand(text);
const command = (text) => parse(text)?.args?.command ?? null;

/* ── transport ───────────────────────────────────────────────────────────── */

test("play and pause name the state they want, not a toggle", () => {
  // `togglePlay` flips, so "play" while playing would pause. The word means
  // one state, and the tool has to be told which.
  assert.equal(command("play"), "play");
  assert.equal(command("play it"), "play");
  assert.equal(command("hit play"), "play");
  assert.equal(command("start playback"), "play");
  assert.equal(command("resume"), "play");
  assert.equal(command("pause"), "pause");
  assert.equal(command("pause the video"), "pause");
  assert.equal(command("stop playback"), "pause");
  assert.equal(command("play pause"), "play_pause");
});

test("bare stop belongs to the router and is never claimed here", () => {
  // `voiceTurnRouter` reads it as cancel-the-run. That reading is the one the
  // operator needs under pressure, and pausing playback must name its object.
  assert.equal(parse("stop"), null);
  assert.equal(parse("stop it"), null);
  assert.equal(parse("stop that"), null);
});

/* ── the playhead ────────────────────────────────────────────────────────── */

test("a seek carries the time the operator said", () => {
  assert.deepEqual(parse("go to 30 seconds")?.args, { command: "set_playhead", ms: 30000 });
  assert.deepEqual(parse("jump to 1:20")?.args, { command: "set_playhead", ms: 80000 });
  assert.deepEqual(parse("take me to two minutes")?.args, { command: "set_playhead", ms: 120000 });
});

test("a nudge keeps its direction, and back is read before forward", () => {
  assert.deepEqual(parse("skip forward five seconds")?.args, { command: "nudge", ms: 5000 });
  assert.deepEqual(parse("go back ten seconds")?.args, { command: "nudge", ms: -10000 });
  assert.deepEqual(parse("rewind 2 seconds")?.args, { command: "nudge", ms: -2000 });
});

test("a seek with no readable time is not a seek to zero", () => {
  // The whole reason `parseSpokenMs` returns null rather than a default: a
  // missing number read as zero sends the playhead to the head of the program.
  assert.equal(parse("go to the good bit"), null);
  assert.equal(parse("skip forward a smidge"), null);
  assert.equal(parseSpokenMs("go to the start"), null);
});

/* ── the razor ───────────────────────────────────────────────────────────── */

test("cut becomes a razor only when the sentence says where", () => {
  assert.equal(command("cut here"), "split");
  assert.equal(command("cut it here"), "split");
  assert.equal(command("split here"), "split");
  assert.equal(command("cut at the playhead"), "split");
  assert.equal(command("razor here"), "split");
  assert.equal(command("make a cut"), "split");
});

test("the many other things cut means fall through", () => {
  assert.equal(parse("cut to the chase"), null);
  assert.equal(parse("cut the music budget"), null);
  assert.equal(parse("cut it out"), null);
  assert.equal(parse("we should cut that scene"), null);
  assert.equal(parse("cut the branch"), null);
});

/* ── the bin ─────────────────────────────────────────────────────────────── */

test("deletion always names a timeline object", () => {
  assert.equal(command("delete that clip"), "delete_selected");
  assert.equal(command("delete the selection"), "delete_selected");
  assert.equal(command("remove the selected clips"), "delete_selected");
  assert.equal(command("get rid of that clip"), "delete_selected");
});

test("everything else the operator asks to be deleted is left alone", () => {
  assert.equal(parse("delete that file"), null);
  assert.equal(parse("delete the branch"), null);
  assert.equal(parse("delete that"), null);
  assert.equal(parse("remove that line"), null);
});

test("undo, redo and deselect are their own commands", () => {
  assert.equal(command("undo that"), "undo");
  assert.equal(command("take that back"), "undo");
  assert.equal(command("redo"), "redo");
  assert.equal(command("deselect everything"), "clear_selection");
});

/* ── tracks ──────────────────────────────────────────────────────────────── */

test("a numbered track resolves to a zero-based index", () => {
  assert.deepEqual(parse("mute track 2")?.args, { index: 1, muted: true });
  assert.deepEqual(parse("unmute track 1")?.args, { index: 0, muted: false });
  assert.deepEqual(parse("solo track 3")?.args, { index: 2, solo: true });
  assert.deepEqual(parse("mute the second track")?.args, { index: 1, muted: true });
});

test("that track is the selected one, and the tool decides whether there is one", () => {
  // Voice cannot pronounce a track id, and guessing an index from context is
  // how a mute lands on the wrong stem.
  assert.deepEqual(parse("mute that track")?.args, { trackId: "selected", muted: true });
});

test("a volume needs a number, because turn it up is not a level", () => {
  assert.deepEqual(parse("set track 2 volume to 50")?.args, { index: 1, volume: 0.5 });
  assert.equal(parse("turn track 2 up"), null);
  assert.equal(parse("make track 2 louder"), null);
});

test("muting Temi herself never reaches a track", () => {
  // `voiceTurnRouter` owns these, ahead of this parser in the stage. A track
  // command without a track noun must not be invented here either.
  assert.equal(parse("mute yourself"), null);
  assert.equal(parse("go mute"), null);
  assert.equal(parse("mute"), null);
});

/* ── the pool ────────────────────────────────────────────────────────────── */

test("an insert names the asset, because an id cannot be spoken", () => {
  assert.deepEqual(parse("add the drone shot to the timeline")?.args, { name: "drone shot" });
  assert.deepEqual(parse("insert b roll onto the timeline")?.args, { name: "b roll" });
});

test("add that clip falls through to the assistant, which can read the pool", () => {
  assert.equal(parse("add that clip"), null);
  assert.equal(parse("add that clip to the timeline"), null);
  assert.equal(parse("add it to the timeline"), null);
});

/* ── export ──────────────────────────────────────────────────────────────── */

test("export is accepted plainly and refused in every other frame", () => {
  assert.equal(parse("export it")?.tool, "export_project");
  assert.equal(parse("render the video")?.tool, "export_project");
  assert.equal(parse("export")?.tool, "export_project");
  assert.equal(parse("how long would exporting take"), null);
  assert.equal(parse("don't export it yet"), null);
  assert.equal(parse("what if we export it now"), null);
});

/* ── the frames that mean the sentence is about the action ────────────────── */

test("questions, negations and hypotheticals never act", () => {
  assert.equal(parse("should I cut here"), null);
  assert.equal(parse("don't cut here"), null);
  assert.equal(parse("if you cut here it breaks"), null);
  assert.equal(parse("why did you delete that clip"), null);
  assert.equal(parse("I would undo that"), null);
});

test("a polite request is still a request", () => {
  // "Can you cut here" is a command on a voice call, not an enquiry. Refusing
  // it would refuse the politest form of every phrase in this file.
  assert.equal(command("can you cut here"), "split");
  assert.equal(command("temi, please pause the video"), "pause");
  assert.equal(command("okay, undo that please"), "undo");
});

/* ── what actually happened ──────────────────────────────────────────────── */

test("a razor that cut nothing does not get the confirmation line", () => {
  // The specific lie this function exists to stop: `splitAtPlayhead` succeeds
  // with `{ attempted: 0, cut: 0 }` when the playhead is over nothing, and
  // "Cut." there is an edit the operator only discovers is missing at export.
  const cmd = parse("cut here");
  assert.equal(describeEditorResult(cmd, { success: true, data: { attempted: 0, cut: 0 } }), "Nothing under the playhead to cut.");
  assert.equal(describeEditorResult(cmd, { success: true, data: { attempted: 1, cut: 1 } }), "Cut.");
  assert.equal(describeEditorResult(cmd, { success: true, data: { attempted: 3, cut: 2 } }), "Cut 2 clips.");
});

test("a delete reports what survived it", () => {
  const cmd = parse("delete that clip");
  assert.equal(describeEditorResult(cmd, { success: true, data: { deleted: [], refused: [] } }), "Nothing was selected.");
  assert.equal(describeEditorResult(cmd, { success: true, data: { deleted: [], refused: [{}] } }), "Nothing was deleted — those clips are locked.");
  assert.equal(describeEditorResult(cmd, { success: true, data: { deleted: ["a"], refused: [] } }), "Deleted.");
  assert.equal(describeEditorResult(cmd, { success: true, data: { deleted: ["a", "b"], refused: [{}] } }), "Deleted 2 clips. 1 refused.");
});

test("a failure is spoken with the tool's own reason", () => {
  const cmd = parse("export it");
  assert.equal(describeEditorResult(cmd, { success: false, error: "no timeline is open" }), "That didn't work: no timeline is open");
  assert.equal(describeEditorResult(cmd, { success: false }), "That didn't work.");
});

test("durations are spoken the way a person says them", () => {
  assert.equal(spellMs(1000), "1 second");
  assert.equal(spellMs(30000), "30 seconds");
  assert.equal(spellMs(-10000), "10 seconds");
  assert.equal(spellMs(60000), "1 minute");
  assert.equal(spellMs(90000), "1 minute 30");
});
