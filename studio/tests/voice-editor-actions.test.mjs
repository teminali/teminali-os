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

/* ── the four sentences the audit caught ──────────────────────────────────── */

test("a seek reads the object between the verb and its to", () => {
  // "Move the playhead to ten seconds" is how a person says it out loud, and
  // the verb is three words from its `to`. The object is a closed list rather
  // than a wildcard: "move the clip to track two" must stay a sentence for the
  // assistant, not become a jump.
  assert.deepEqual(parse("move the playhead to ten seconds")?.args, { command: "set_playhead", ms: 10000 });
  assert.deepEqual(parse("put the playhead to 1:20")?.args, { command: "set_playhead", ms: 80000 });
  assert.equal(parse("move the clip to track two"), null);
  assert.equal(parse("move that to the end"), null);
});

test("split takes the noun the operator says while looking at the clip", () => {
  // "Split this" was accepted and "split this clip" was not.
  assert.equal(command("split this clip"), "split");
  assert.equal(command("split that clip"), "split");
  assert.equal(command("split the clip"), "split");
  assert.equal(command("razor this clip"), "split");
  // And the end anchor is still what keeps the word safe.
  assert.equal(parse("split the work between us"), null);
  assert.equal(parse("split the difference"), null);
});

test("play carries a from-here tail, because that is where he is standing", () => {
  // The transport already starts from the playhead; `from here` adds nothing
  // to the command. It only had to stop being a refusal.
  assert.equal(command("play the timeline from here"), "play");
  assert.equal(command("play from here"), "play");
  assert.equal(command("start playback from the playhead"), "play");
  assert.equal(command("play it from this point"), "play");
  // "Play this backwards" is a different verb and must not be swallowed.
  assert.equal(command("play this backwards"), "reverse_clip");
});

test("zoom means the timeline, and never the picture", () => {
  assert.equal(command("zoom in"), "zoom_in");
  assert.equal(command("zoom in on the timeline"), "zoom_in");
  assert.equal(command("zoom out a bit"), "zoom_out");
  assert.equal(command("zoom to fit"), "zoom_fit");
  assert.equal(command("show me the whole timeline"), "zoom_fit");
  // A framing note about the shot belongs to the assistant. The two sentences
  // share their first two words and mean nothing like each other.
  assert.equal(parse("zoom in on her face"), null);
  assert.equal(parse("zoom in on the logo"), null);
});

/* ── the duration parser, where one letter was eating whole sentences ─────── */

test("a one-letter unit only ever follows a digit", () => {
  // `s` and `m` stood alone, and an English sentence is mostly words that end
  // in one or the other: "captions" parsed as caption + s, "from" as fro + m.
  // Each match handed `numberFrom` a word that is not a number, and null from
  // there means the whole sentence is unreadable.
  assert.equal(parseSpokenMs("nudge the captions forward half a second"), 500);
  assert.equal(parseSpokenMs("go to 30 seconds from the start"), 30000);
  assert.equal(parseSpokenMs("move them to 10 seconds"), 10000);
  // The written form a digit makes unambiguous is still read.
  assert.equal(parseSpokenMs("skip forward 30s"), 30000);
  assert.equal(parseSpokenMs("go to 2m"), 120000);
});

test("the filler word in half a second is not the number", () => {
  // The table said it covered these and it did not: the strict form skipped
  // "half" and read "a second" as one.
  assert.equal(parseSpokenMs("half a second"), 500);
  assert.equal(parseSpokenMs("a couple of seconds"), 2000);
  // And the filler pass must not take a word in front of the number it is
  // filling for: "go back a second" reads its `a`, not its `back`.
  assert.equal(parseSpokenMs("go back a second"), 1000);
});

/* ── captions, which are the whole point of the surface ──────────────────── */

test("captioning a cut is one sentence and takes no argument", () => {
  // Both tools have existed since P3 and neither had a spoken route: the chat
  // could caption a cut and the operator standing at the timeline could not.
  // With nothing passed they read the caption clips already on the timeline,
  // so the bare sentence is a real command rather than a stub.
  assert.equal(parse("add captions")?.tool, "generate_captions");
  assert.equal(parse("generate captions")?.tool, "generate_captions");
  assert.equal(parse("caption this")?.tool, "generate_captions");
  assert.equal(parse("put subtitles on this video")?.tool, "generate_captions");
  assert.deepEqual(parse("add captions")?.args, { action: "generate" });
});

test("fixing and checking the captions are different jobs", () => {
  // `verify` reads and reports; `perfect` rewrites the cues on the timeline.
  assert.deepEqual(parse("fix the captions")?.args, { action: "perfect" });
  assert.deepEqual(parse("clean up the subtitles")?.args, { action: "perfect" });
  assert.deepEqual(parse("check the captions")?.args, { action: "verify" });
  assert.equal(parse("check the captions")?.tool, "perfect_captions");
});

test("a caption shift names its direction and never guesses one", () => {
  // Forward is later, back is earlier — the same convention as the nudge, and
  // spelled out because a sync said the other way round is the failure the
  // operator only finds when the whole cut is out of step.
  assert.deepEqual(parse("shift the captions forward half a second")?.args, { action: "perfect", offsetMs: 500 });
  assert.deepEqual(parse("nudge the subtitles back 2 seconds")?.args, { action: "perfect", offsetMs: -2000 });
  // No duration, no shift.
  assert.equal(parse("shift the captions forward"), null);
  assert.equal(parse("move the captions a bit"), null);
});

test("a sentence about the captions never moves the playhead", () => {
  // "Nudge the captions forward half a second" carries `nudge`, `forward` and
  // a readable duration — every part the nudge needs — and the nudge sits
  // earlier in the parse, so without the guard it would take all three and
  // move the program instead of the subtitles.
  assert.equal(parse("nudge the captions forward half a second")?.tool, "perfect_captions");
  assert.equal(parse("go to 30 seconds")?.args.command, "set_playhead");
});

test("talking about captions is not asking for them", () => {
  assert.equal(parse("how do I add captions"), null);
  assert.equal(parse("don't caption this"), null);
  assert.equal(parse("should I add captions"), null);
  assert.equal(parse("the captions are wrong"), null);
  assert.equal(parse("what if we caption this"), null);
  // And a caption CARD is a title, not a caption run — one text clip with the
  // words he said, not a pass over every cue on the track.
  assert.equal(command("add a caption card saying hello"), "add_text");
});

/* ── cueing ──────────────────────────────────────────────────────────────── */

test("in and out are read before mark this, two words away", () => {
  // An in point filed as a marker leaves the range he was about to export
  // quietly unset, and he finds out at the export.
  assert.equal(command("mark in"), "set_in_point");
  assert.equal(command("set the in point here"), "set_in_point");
  assert.equal(command("mark out"), "set_out_point");
  assert.equal(command("set an out point at the playhead"), "set_out_point");
  assert.equal(command("clear the in and out points"), "clear_in_out");
  assert.equal(command("mark this"), "add_marker");
  assert.equal(command("drop a marker here"), "add_marker");
});

test("the other things mark and clear mean fall through", () => {
  assert.equal(parse("mark this as done"), null);
  assert.equal(parse("mark my words"), null);
  assert.equal(parse("clear the cache"), null);
  // And the selection is still the selection, not the in/out range.
  assert.equal(command("clear the selection"), "clear_selection");
});

/* ── the clip under the playhead ─────────────────────────────────────────── */

test("a trim must say where it trims to", () => {
  // The store CLAMPS a trim point outside the clip rather than refusing it, so
  // a loose match here does not fail loudly — it quietly resizes a clip to the
  // head of the program.
  assert.equal(command("trim the start here"), "trim_in");
  assert.equal(command("trim the head of this clip here"), "trim_in");
  assert.equal(command("trim the end to the playhead"), "trim_out");
  assert.equal(command("trim the tail here"), "trim_out");
});

test("everything else the operator asks to be trimmed is left alone", () => {
  assert.equal(parse("trim the budget"), null);
  assert.equal(parse("trim the scope"), null);
  assert.equal(parse("trim the intro down"), null);
  assert.equal(parse("we should trim that scene"), null);
});

test("duplicate carries a bare object and copy does not", () => {
  // "Copy that" is radio for "understood" and arrives on this lane about as
  // often as any edit does.
  assert.equal(command("duplicate this clip"), "duplicate_clip");
  assert.equal(command("duplicate that"), "duplicate_clip");
  assert.equal(command("clone this clip"), "duplicate_clip");
  assert.equal(command("copy this clip"), "duplicate_clip");
  assert.equal(parse("copy that"), null);
  assert.equal(parse("copy it"), null);
  assert.equal(parse("duplicate the effort"), null);
});

test("a speed needs a rate, because speed this up is about hurrying", () => {
  assert.deepEqual(parse("make this two times speed")?.args, { command: "set_speed", rate: 2 });
  assert.deepEqual(parse("slow this down to half speed")?.args, { command: "set_speed", rate: 0.5 });
  assert.deepEqual(parse("play this at double speed")?.args, { command: "set_speed", rate: 2 });
  assert.deepEqual(parse("set the clip speed to 0.5")?.args, { command: "set_speed", rate: 0.5 });
  assert.deepEqual(parse("make this 2x")?.args, { command: "set_speed", rate: 2 });
});

test("the other speed is never a clip", () => {
  assert.equal(parse("speed this up"), null);
  assert.equal(parse("we need to speed up the launch"), null);
  assert.equal(parse("make this two times bigger"), null);
  assert.equal(parse("slow down"), null);
});

test("detach, reverse, freeze and close gaps each name their object", () => {
  assert.equal(command("detach the audio"), "detach_audio");
  assert.equal(command("separate the audio from this clip"), "detach_audio");
  assert.equal(command("split off the audio"), "detach_audio");
  assert.equal(command("reverse this clip"), "reverse_clip");
  assert.equal(command("freeze this frame"), "freeze_frame");
  assert.equal(command("hold the frame here"), "freeze_frame");
  assert.equal(command("close the gaps"), "close_gaps");
  assert.equal(command("close the gaps on this track"), "close_gaps");
});

test("the same verbs in every other sentence do nothing", () => {
  assert.equal(parse("detach yourself"), null);
  assert.equal(parse("we should reverse that decision"), null);
  assert.equal(parse("freeze the budget"), null);
  assert.equal(parse("close the deal"), null);
  assert.equal(parse("mind the gaps in the plan"), null);
  // And a bare "hold it there" still pauses the transport, as it always did.
  assert.equal(command("hold it there"), "pause");
});

/* ── transitions and titles ──────────────────────────────────────────────── */

test("a transition names a type the renderer actually draws", () => {
  // A type the renderer does not know draws nothing and reports success — a
  // transition the operator finds missing at the export.
  assert.deepEqual(parse("add a crossfade")?.args, { command: "add_transition", transition: "crossfade", position: "out" });
  assert.deepEqual(parse("crossfade this clip")?.args, { command: "add_transition", transition: "crossfade", position: "out" });
  assert.deepEqual(parse("put a dip to black on the start")?.args, { command: "add_transition", transition: "dip_to_black", position: "in" });
  assert.deepEqual(parse("fade this in")?.args, { command: "add_transition", transition: "crossfade", position: "in" });
  assert.deepEqual(parse("add a whip pan")?.args, { command: "add_transition", transition: "whip_pan", position: "out" });
});

test("the name of a transition never stands on its own", () => {
  // "Flash", "spin" and "glitch" are things an operator says ABOUT a shot far
  // more often than he asks for one.
  assert.equal(parse("flash"), null);
  assert.equal(parse("spin"), null);
  assert.equal(parse("glitch"), null);
  assert.equal(parse("that was a nasty glitch"), null);
  assert.equal(parse("the whole thing dissolves"), null);
});

test("a title carries its own words, in the case they were said", () => {
  // `tidy` lowercases and strips a trailing "now" as a courtesy, and "now" is
  // the last word of half the titles anyone puts on a social cut.
  assert.deepEqual(parse("add a title saying Subscribe now")?.args, { command: "add_text", text: "Subscribe now" });
  assert.deepEqual(parse("put a lower third that says Dar es Salaam")?.args, { command: "add_text", text: "Dar es Salaam" });
  // And there is no form without the words: an empty text clip is a blank
  // frame in the export that looks like a command that worked.
  assert.equal(parse("add a title"), null);
  assert.equal(parse("add some text"), null);
});

/* ── what actually happened, for the new verbs ───────────────────────────── */

test("a caption run reports the count, not that it started", () => {
  // "Captioning." told the operator a job had begun and nothing about what
  // came back. The difference between a perfected set of cues and one that
  // reached the timeline is the whole failure mode.
  const cmd = parse("add captions");
  assert.equal(describeEditorResult(cmd, { success: true, data: { captionCount: 0 } }), "No captions were found to work with.");
  assert.equal(describeEditorResult(cmd, { success: true, data: { captionCount: 1, appliedToTimeline: true } }), "1 caption on the timeline.");
  assert.equal(describeEditorResult(cmd, { success: true, data: { captionCount: 24, appliedToTimeline: true } }), "24 captions on the timeline.");
  assert.equal(
    describeEditorResult(cmd, { success: true, data: { captionCount: 24, appliedToTimeline: false } }),
    "24 captions ready, but none reached the timeline.",
  );
});

test("a caption check reports the problems it found", () => {
  const cmd = parse("check the captions");
  assert.equal(describeEditorResult(cmd, { success: true, data: { captionCount: 12, verification: { issues: [] } } }), "12 captions, all clean.");
  assert.equal(describeEditorResult(cmd, { success: true, data: { captionCount: 12, verification: { issues: [{}, {}] } } }), "12 captions, 2 problems.");
});

test("a repack that moved nothing is not a repack", () => {
  const cmd = parse("close the gaps");
  assert.equal(
    describeEditorResult(cmd, { success: true, data: { gapsClosed: 0, clipsMoved: 0, changed: false, note: "There were no gaps on that track." } }),
    "There were no gaps on that track.",
  );
  assert.equal(describeEditorResult(cmd, { success: true, data: { gapsClosed: 1, clipsMoved: 2, changed: true } }), "Closed one gap.");
  assert.equal(describeEditorResult(cmd, { success: true, data: { gapsClosed: 3, clipsMoved: 5, changed: true } }), "Closed 3 gaps.");
});

test("a zoom that hit the stop says so instead of confirming", () => {
  const cmd = parse("zoom in");
  assert.equal(
    describeEditorResult(cmd, { success: true, data: { zoomLevel: 8, fromZoom: 8, changed: false, note: "Already as close as it goes." } }),
    "Already as close as it goes.",
  );
  assert.equal(describeEditorResult(cmd, { success: true, data: { zoomLevel: 12, fromZoom: 8, changed: true } }), "Zoomed in.");
});
