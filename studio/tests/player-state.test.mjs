/*
  The player, from the two sides that are not the DOM.

  The gateway holds no handle on a `<video>`: it keeps the last snapshot the
  window published and forwards a checked command down the run's stream. So
  what is worth testing is the seam — that the action list the gateway accepts
  is the action list the pane implements, that a malformed value is refused
  with a sentence a model can act on rather than "bad request", and that a
  snapshot from the window cannot become an unbounded payload sitting in the
  gateway's memory.
*/
import test from "node:test";
import assert from "node:assert/strict";

import {
  createPlayerRegistry, describePlayer, parsePlayerCommand, sanitisePlayerSnapshot, unsupportedReason,
  PLAYER_ACTIONS, PLAYER_RATE, PlayerCommandError,
} from "../server/player-state.js";
import { PLAYER_ACTIONS as PANE_ACTIONS } from "../src/services/playerControl.ts";

test("the gateway and the pane know the same actions", () => {
  // An action one side accepts and the other ignores is a tool call that
  // reports success and does nothing.
  assert.deepEqual([...PLAYER_ACTIONS], [...PANE_ACTIONS]);
});

test("an unknown action is refused with the list, not a code", () => {
  assert.throws(() => parsePlayerCommand({ action: "eject" }), (error) => {
    assert.ok(error instanceof PlayerCommandError);
    assert.match(error.message, /is not a player action/);
    assert.match(error.message, /seek_by/);
    return true;
  });
});

test("the actions that take nothing take nothing", () => {
  for (const action of ["play", "pause", "toggle", "restart", "mute", "unmute", "frame_step", "frame_back", "next", "previous", "episodes"]) {
    assert.deepEqual(parsePlayerCommand({ action, value: 42 }), { action }, action);
  }
});

test("a seek is seconds, and a backwards one is `seek_by`", () => {
  assert.deepEqual(parsePlayerCommand({ action: "seek", value: 90 }), { action: "seek", value: 90 });
  assert.deepEqual(parsePlayerCommand({ action: "seek", value: "90" }), { action: "seek", value: 90 }, "a model often sends a string");
  assert.deepEqual(parsePlayerCommand({ action: "seek_by", value: -30 }), { action: "seek_by", value: -30 });
  assert.throws(() => parsePlayerCommand({ action: "seek" }), /number of seconds/);
  assert.throws(() => parsePlayerCommand({ action: "seek", value: -5 }), /use `seek_by`/);
});

test("a chapter is numbered from 1, like an episode and unlike mpv", () => {
  assert.deepEqual(parsePlayerCommand({ action: "chapter", value: 4 }), { action: "chapter", value: 4 });
  assert.deepEqual(parsePlayerCommand({ action: "chapter", value: "4" }), { action: "chapter", value: 4 });
  // The refusal has to say which chapter is chapter one, because mpv's own answer is 0.
  assert.throws(() => parsePlayerCommand({ action: "chapter", value: 0 }), /counting from 1/);
  assert.throws(() => parsePlayerCommand({ action: "chapter", value: 1.5 }), /counting from 1/);
  assert.throws(() => parsePlayerCommand({ action: "chapter" }), /chapter/);
  // `episode` still names the list the agent read the number off, not just the rule.
  assert.throws(() => parsePlayerCommand({ action: "episode", value: 0 }), /`player` lists/);
});

test("an audio track is a number or a name, and either survives the parser", () => {
  assert.deepEqual(parsePlayerCommand({ action: "audio_track", value: 2 }), { action: "audio_track", value: 2 });
  assert.deepEqual(parsePlayerCommand({ action: "audio_track", value: "2" }), { action: "audio_track", value: 2 }, "a model often sends a string");
  assert.deepEqual(parsePlayerCommand({ action: "audio_track", value: "Japanese" }), { action: "audio_track", value: "Japanese" });
  // Resolving a name against the file's real tracks is the engine's job; refusing an empty one is this one's.
  assert.throws(() => parsePlayerCommand({ action: "audio_track" }), /track number counting from 1/);
  assert.throws(() => parsePlayerCommand({ action: "audio_track", value: "  " }), /track number counting from 1/);
  assert.throws(() => parsePlayerCommand({ action: "audio_track", value: 0 }), /counting from 1/);
});

test("volume is a fraction and rate is bounded, both said in the refusal", () => {
  assert.deepEqual(parsePlayerCommand({ action: "volume", value: 0.4 }), { action: "volume", value: 0.4 });
  assert.throws(() => parsePlayerCommand({ action: "volume", value: 40 }), /between 0 and 1/);
  assert.deepEqual(parsePlayerCommand({ action: "rate", value: 2 }), { action: "rate", value: 2 });
  assert.throws(() => parsePlayerCommand({ action: "rate", value: 9 }), new RegExp(`${PLAYER_RATE.max}`));
});

test("subtitles takes a label, a bare on/off, or a boolean", () => {
  assert.deepEqual(parsePlayerCommand({ action: "subtitles", value: "English" }), { action: "subtitles", value: "English" });
  assert.deepEqual(parsePlayerCommand({ action: "subtitles" }), { action: "subtitles", value: "on" });
  assert.deepEqual(parsePlayerCommand({ action: "subtitles", value: false }), { action: "subtitles", value: "off" });
  assert.deepEqual(parsePlayerCommand({ action: "subtitles", value: true }), { action: "subtitles", value: "on" });
});

test("fullscreen with no value is a toggle, and a word is not a boolean by accident", () => {
  assert.deepEqual(parsePlayerCommand({ action: "fullscreen" }), { action: "fullscreen" });
  assert.deepEqual(parsePlayerCommand({ action: "fullscreen", value: "off" }), { action: "fullscreen", value: false });
  assert.throws(() => parsePlayerCommand({ action: "fullscreen", value: 3 }), /true or false/);
});

test("an episode is counted from 1, the way `player` lists them", () => {
  assert.deepEqual(parsePlayerCommand({ action: "episode", value: 3 }), { action: "episode", value: 3 });
  assert.throws(() => parsePlayerCommand({ action: "episode", value: 0 }), /counting from 1/);
  assert.throws(() => parsePlayerCommand({ action: "episode", value: 2.5 }), /counting from 1/);
});

test("a snapshot is bounded: no unbounded strings, no unbounded episode list", () => {
  const snapshot = sanitisePlayerSnapshot({
    view: "player",
    path: "x".repeat(5000),
    title: "Ep",
    kind: "video",
    playing: "yes",
    time: -4,
    duration: "nonsense",
    volume: 12,
    rate: 1.5,
    subtitles: { available: Array.from({ length: 200 }, (_, index) => `t${index}`), active: "t1" },
    series: { folder: "S", title: "S", index: 2, count: 3, episodes: Array.from({ length: 900 }, (_, index) => ({ index, path: `p${index}`, title: "t", watched: 4 })) },
  });
  assert.equal(snapshot.path.length, 512);
  assert.equal(snapshot.playing, false, "a truthy string is not a boolean");
  assert.equal(snapshot.time, 0);
  assert.equal(snapshot.duration, null);
  assert.equal(snapshot.volume, 1);
  assert.equal(snapshot.subtitles.available.length, 32);
  assert.equal(snapshot.series.episodes.length, 500);
  assert.equal(snapshot.series.episodes[0].watched, 1);
  assert.equal(sanitisePlayerSnapshot(null), null);
  assert.equal(sanitisePlayerSnapshot("playing"), null);
});

test("the engine's own limits are data, not a second action list", () => {
  /*
    One list, two engines: a `<video>` cannot switch audio tracks and mpv can.
    The pane says so per file, the gateway refuses those before forwarding —
    without which the tool call reports success and moves nothing, the exact
    failure the mirrored-list test above exists to prevent.
  */
  const snapshot = sanitisePlayerSnapshot({
    view: "player",
    unsupported: [
      { action: "audio_track", reason: "Chromium plays the file's first audio track and offers no way to choose another." },
      { action: "eject", reason: "not an action at all" },
      { action: "chapter", reason: "y".repeat(5000) },
    ],
  });
  assert.deepEqual(snapshot.unsupported.map((item) => item.action), ["audio_track", "chapter"]);
  assert.equal(snapshot.unsupported[1].reason.length, 512, "a reason is a sentence, not a payload");
  assert.match(unsupportedReason(snapshot, "audio_track"), /first audio track/);
  assert.equal(unsupportedReason(snapshot, "seek"), null);
  // The normal case, and the one mpv will publish: nothing is out of reach.
  assert.deepEqual(sanitisePlayerSnapshot({ view: "player" }).unsupported, []);
  assert.equal(unsupportedReason(null, "chapter"), null);
});

test("the registry holds one player, and an unmount clears it", () => {
  const registry = createPlayerRegistry({ now: () => 1000 });
  assert.equal(registry.current(), null);
  registry.report({ view: "player", path: "a.mkv", playing: true });
  assert.equal(registry.current().path, "a.mkv");
  assert.equal(registry.current().reportedAt, 1000);
  registry.report(null);
  assert.equal(registry.current(), null);
});

test("the summary is a sentence, so the model need not parse the object", () => {
  assert.match(describePlayer(null), /No video or audio is open/);

  const gallery = sanitisePlayerSnapshot({
    view: "episodes",
    series: { folder: "S", title: "Planet Earth", index: null, count: 11, episodes: [] },
  });
  assert.match(describePlayer(gallery), /Planet Earth/);
  assert.match(describePlayer(gallery), /11 episodes/);

  const playing = sanitisePlayerSnapshot({
    view: "player",
    title: "Ep 2",
    playing: true,
    time: 3661,
    duration: 5400,
    rate: 1.5,
    muted: true,
    subtitles: { available: ["English"], active: "English" },
    series: { folder: "S", title: "Show", index: 2, count: 6, episodes: [] },
  });
  const sentence = describePlayer(playing);
  assert.match(sentence, /episode 2 of 6/);
  assert.match(sentence, /playing at 1:01:01 of 1:30:00/);
  assert.match(sentence, /subtitles English/);
  assert.match(sentence, /muted/);
  assert.match(sentence, /1\.5×/);

  const broken = sanitisePlayerSnapshot({ view: "player", title: "Ep", error: "ffmpeg is not installed" });
  assert.match(describePlayer(broken), /cannot play \(ffmpeg is not installed\)/);
});
