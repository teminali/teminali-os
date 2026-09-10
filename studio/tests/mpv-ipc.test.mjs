import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  MpvIpc,
  endpointFile,
  endpointRecord,
  findMpv,
  frameRequest,
  ipcSocketPath,
  mpvArgs,
  mpvCommand,
  packBitmap,
  parseIpcChunk,
  playerTracks,
  runningMpv,
  trackFor,
  trackLabel,
  volumePercent,
} from "../electron/mpvProcess.cjs";
import { PLAYER_ACTIONS, PLAYER_RATE } from "../server/player-state.js";

/**
 * The player's engine, at the two places it can silently do nothing: the table
 * that turns a `PlayerCommand` into mpv commands, and the newline framing that
 * carries them. Both fail quietly rather than loudly — an unmapped action
 * reports success and moves nothing, a mis-framed line hangs a request forever
 * — so neither is left to be noticed by hand.
 */

/* ── Every action is answered ─────────────────────────────────────────────── */

/**
 * The list mpv is *expected* to decline, and why. Series navigation is the
 * pane's folder scan, not mpv's playlist; see `mpvCommand`'s header.
 */
const NOT_MPV = new Set(["next", "previous", "episode", "episodes"]);

test("every action in the contract is answered, or declined on purpose", () => {
  for (const action of PLAYER_ACTIONS) {
    const commands = mpvCommand({ action, value: sampleValue(action) });
    if (NOT_MPV.has(action)) {
      assert.equal(commands, null, `${action} should be the pane's, not mpv's`);
      continue;
    }
    assert.ok(Array.isArray(commands) && commands.length > 0, `${action} maps to nothing`);
    for (const command of commands) {
      assert.ok(Array.isArray(command) && typeof command[0] === "string", `${action} produced a malformed mpv command`);
    }
  }
});

function sampleValue(action) {
  switch (action) {
    case "seek": return 30;
    case "seek_by": return -10;
    case "volume": return 0.5;
    case "rate": return 1.5;
    case "subtitles": return "on";
    case "audio_track": return 2;
    case "chapter": return 3;
    case "episode": return 2;
    default: return undefined;
  }
}

test("an action nobody has heard of is declined, not guessed at", () => {
  assert.equal(mpvCommand({ action: "eject" }), null);
  assert.equal(mpvCommand({}), null);
  assert.equal(mpvCommand(null), null);
});

/* ── What each one actually says ──────────────────────────────────────────── */

test("play, pause and toggle are three different things", () => {
  assert.deepEqual(mpvCommand({ action: "play" }), [["set_property", "pause", false]]);
  assert.deepEqual(mpvCommand({ action: "pause" }), [["set_property", "pause", true]]);
  // `cycle`, not a read-then-write: the state could move between the two.
  assert.deepEqual(mpvCommand({ action: "toggle" }), [["cycle", "pause"]]);
});

test("restart is a seek and an unpause, in that order", () => {
  assert.deepEqual(mpvCommand({ action: "restart" }), [
    ["seek", 0, "absolute+exact"],
    ["set_property", "pause", false],
  ]);
});

/* ── The one action that is not in the contract ───────────────────────────── */

/**
 * `subtitle_file` carries a path, and the whole of its design is that no model
 * can name one. The test above walks the contract and finds every action
 * answered; this one walks the other way, and would fail the moment somebody
 * "completed" the contract by adding this to it — which is the only way the
 * pane's private door could become the assistant's.
 */
test("the action that carries a path is not an action the contract can ask for", () => {
  assert.ok(
    !PLAYER_ACTIONS.includes("subtitle_file"),
    "subtitle_file in PLAYER_ACTIONS would hand a model sub-add against any file on the disk",
  );
});

test("a dropped subtitle becomes a sub-add that selects it and names it", () => {
  assert.deepEqual(
    mpvCommand({ action: "subtitle_file", value: { path: "/Users/t/Films/Arrival.srt", title: "Arrival" } }),
    [["sub-add", "/Users/t/Films/Arrival.srt", "select", "Arrival"]],
  );
});

test("a subtitle file with no title is still added, and mpv names it", () => {
  // `trackLabel`'s own fallback takes over. Worse than the pane's label, but a
  // track that is there and badly named beats no track at all.
  assert.deepEqual(
    mpvCommand({ action: "subtitle_file", value: { path: "/tmp/x.srt" } }),
    [["sub-add", "/tmp/x.srt", "select"]],
  );
});

test("a subtitle file with no path is refused rather than sent as an empty sub-add", () => {
  // Every one of these is a shape the renderer could send if `getPathForFile`
  // came back empty. `sub-add ""` is a command mpv accepts and does nothing
  // with, which is exactly the silent no-op this table exists to prevent.
  for (const value of [undefined, null, "", "   ", 7, { path: "" }, { path: "  ", title: "x" }]) {
    assert.equal(mpvCommand({ action: "subtitle_file", value }), null, `${JSON.stringify(value) ?? "undefined"} should be refused`);
  }
});

test("seek is absolute and seek_by is relative", () => {
  assert.deepEqual(mpvCommand({ action: "seek", value: 90 }), [["seek", 90, "absolute+exact"]]);
  assert.deepEqual(mpvCommand({ action: "seek_by", value: -15 }), [["seek", -15, "relative+exact"]]);
  // A missing number is 0, not NaN — `["seek", NaN]` is a command mpv accepts and ignores.
  assert.deepEqual(mpvCommand({ action: "seek" }), [["seek", 0, "absolute+exact"]]);
});

test("every seek is exact, because a keyframe seek misses by a whole GOP", () => {
  /*
    Measured against mpv 0.41 and an x265 clip with a 10s GOP: without `exact`,
    `seek_by -3` from 8s landed at 0 and `+5` from there at 10. The contract is
    in seconds, so the flag is not optional.
  */
  for (const command of [{ action: "seek", value: 90 }, { action: "seek_by", value: -15 }, { action: "restart" }]) {
    const [seek] = mpvCommand(command);
    assert.ok(String(seek[2]).endsWith("+exact"), `${command.action} seeks to the nearest keyframe, not the second asked for`);
  }
});

test("the contract's 0-1 volume becomes mpv's percentage", () => {
  assert.deepEqual(mpvCommand({ action: "volume", value: 0.5 }), [
    ["set_property", "volume", 50],
    ["set_property", "mute", false],
  ]);
  // Volume 0 reads as muted in the pane, so it must read as muted here too.
  assert.deepEqual(mpvCommand({ action: "volume", value: 0 }), [
    ["set_property", "volume", 0],
    ["set_property", "mute", true],
  ]);
  assert.equal(volumePercent(0.333), 33.3);
  assert.equal(volumePercent(2), 100, "out of range clamps rather than shouting past mpv's maximum");
  assert.equal(volumePercent(-1), 0);
  assert.equal(volumePercent("nonsense"), 0);
});

test("mute and unmute are not a cycle", () => {
  assert.deepEqual(mpvCommand({ action: "mute" }), [["set_property", "mute", true]]);
  assert.deepEqual(mpvCommand({ action: "unmute" }), [["set_property", "mute", false]]);
});

test("rate clamps to the same bounds the gateway enforces", () => {
  assert.deepEqual(mpvCommand({ action: "rate", value: 1.5 }), [["set_property", "speed", 1.5]]);
  assert.deepEqual(mpvCommand({ action: "rate", value: 99 }), [["set_property", "speed", PLAYER_RATE.max]]);
  assert.deepEqual(mpvCommand({ action: "rate", value: 0.01 }), [["set_property", "speed", PLAYER_RATE.min]]);
  assert.deepEqual(mpvCommand({ action: "rate" }), [["set_property", "speed", 1]]);
});

test("subtitles resolve against the file's own tracks", () => {
  const subtitles = [{ id: 1, label: "English (SDH)" }, { id: 2, label: "Swahili" }];
  assert.deepEqual(mpvCommand({ action: "subtitles", value: "off" }, { subtitles }), [["set_property", "sid", "no"]]);
  assert.deepEqual(mpvCommand({ action: "subtitles", value: "on" }, { subtitles }), [["set_property", "sid", 1]]);
  assert.deepEqual(mpvCommand({ action: "subtitles", value: "Swahili" }, { subtitles }), [["set_property", "sid", 2]]);
  // Substring and case, the same two-step MediaPlayer.tsx does.
  assert.deepEqual(mpvCommand({ action: "subtitles", value: "english" }, { subtitles }), [["set_property", "sid", 1]]);
  // A label nothing matches is a refusal, not a silent fallback to the first track.
  assert.equal(mpvCommand({ action: "subtitles", value: "Klingon" }, { subtitles }), null);
  // With no tracks listed, "on" leaves the choice to mpv rather than inventing an id.
  assert.deepEqual(mpvCommand({ action: "subtitles", value: "on" }), [["set_property", "sid", "auto"]]);
});

test("a frame step is mpv's, in both directions", () => {
  /*
    The whole reason these two actions exist. mpv decodes exactly one frame
    and stops; a `<video>` told to advance by 1/fps lands on whatever frame
    the decoder presents next, which on a variable-frame-rate file is not one
    frame. Neither takes a value — "step two frames" is two calls.
  */
  assert.deepEqual(mpvCommand({ action: "frame_step" }), [["frame-step"]]);
  assert.deepEqual(mpvCommand({ action: "frame_back" }), [["frame-back-step"]]);
  assert.deepEqual(mpvCommand({ action: "frame_step", value: 5 }), [["frame-step"]]);
});

test("the contract counts chapters from 1 and mpv from 0", () => {
  assert.deepEqual(mpvCommand({ action: "chapter", value: 1 }), [["set_property", "chapter", 0]]);
  assert.deepEqual(mpvCommand({ action: "chapter", value: 7 }), [["set_property", "chapter", 6]]);
  // The gateway refuses 0 and below; if one arrives anyway it is the first chapter, never -1.
  assert.deepEqual(mpvCommand({ action: "chapter", value: 0 }), [["set_property", "chapter", 0]]);
  assert.deepEqual(mpvCommand({ action: "chapter" }), [["set_property", "chapter", 0]]);
});

test("an audio track is named or numbered, and a name nothing matches is refused", () => {
  const audio = [{ id: 1, label: "English" }, { id: 2, label: "Japanese (5.1)" }];
  // A number is mpv's own `aid`, which counts from 1 as the contract does.
  assert.deepEqual(mpvCommand({ action: "audio_track", value: 2 }, { audio }), [["set_property", "aid", 2]]);
  assert.deepEqual(mpvCommand({ action: "audio_track", value: "Japanese" }, { audio }), [["set_property", "aid", 2]]);
  assert.deepEqual(mpvCommand({ action: "audio_track", value: "english" }, { audio }), [["set_property", "aid", 1]]);
  // The same refusal subtitles give: "Japanese" quietly meaning English is worse than being told.
  assert.equal(mpvCommand({ action: "audio_track", value: "Klingon" }, { audio }), null);
  assert.equal(mpvCommand({ action: "audio_track", value: "English" }), null, "no track list, no invented id");
  assert.equal(mpvCommand({ action: "audio_track", value: 0 }, { audio }), null);
});

test("trackFor prefers an exact label to a substring", () => {
  const tracks = [{ id: 1, label: "English (Forced)" }, { id: 2, label: "English" }];
  assert.equal(trackFor("English", tracks).id, 2);
  assert.equal(trackFor("forced", tracks).id, 1);
  assert.equal(trackFor("   ", tracks), null);
});

test("fullscreen takes a boolean, or cycles when it is not given one", () => {
  assert.deepEqual(mpvCommand({ action: "fullscreen", value: true }), [["set_property", "fullscreen", true]]);
  assert.deepEqual(mpvCommand({ action: "fullscreen", value: false }), [["set_property", "fullscreen", false]]);
  assert.deepEqual(mpvCommand({ action: "fullscreen" }), [["cycle", "fullscreen"]]);
});

/* ── Spawn arguments ──────────────────────────────────────────────────────── */

test("mpv is spawned idle, silent, and with nobody else's keyboard bindings", () => {
  const args = mpvArgs({ socket: "/tmp/socket" });
  assert.ok(args.includes("--idle=yes"));
  assert.ok(args.includes("--no-terminal"));
  assert.ok(args.includes("--no-input-default-bindings"), "the pane owns the shortcuts");
  assert.ok(args.includes("--input-ipc-server=/tmp/socket"));
  // B3's job, not B1's: no video output is chosen here.
  assert.ok(!args.some((arg) => arg.startsWith("--vo=")));
});

test("mpv is told to find the same sidecar subtitles the pane's own scan finds", () => {
  /*
    `subtitleTracksFor` takes the siblings whose base name is the video's,
    optionally followed by a dot and a language, and `exact` is mpv's word for
    that rule. Written down rather than left to the default: if mpv's default
    moved, the engine's menu would stop matching the folder and nothing would
    say so.
  */
  assert.ok(mpvArgs({ socket: "/tmp/socket" }).includes("--sub-auto=exact"));
});

test("mpv's track list becomes the two lists the contract asks about", () => {
  const { subtitles, audio } = playerTracks([
    { id: 1, type: "video", title: "H.264" },
    { id: 1, type: "audio", lang: "eng", selected: true },
    { id: 2, type: "audio", title: "Commentary" },
    { id: 1, type: "sub", title: "English (SDH)", lang: "eng", selected: true },
    { id: 2, type: "sub", lang: "swa", external: true, "external-filename": "/films/Episode 1.swa.srt" },
  ]);
  // Video is dropped: nothing in the contract chooses one.
  assert.deepEqual(subtitles.map((track) => track.id), [1, 2]);
  assert.deepEqual(audio.map((track) => track.label), ["ENG", "Commentary"]);
  assert.equal(subtitles[0].selected, true);
  assert.equal(subtitles[1].external, true, "a sidecar is marked as one, so the menu can say `file`");
  assert.equal(subtitles[1].language, "swa");
});

test("a track with no title is named by its language, its file, then its number", () => {
  assert.equal(trackLabel({ id: 3, title: "Forced", lang: "eng" }), "Forced");
  assert.equal(trackLabel({ id: 3, lang: "swa" }), "SWA");
  // The operator knows the file by name; "Track 3" tells them nothing at all.
  assert.equal(trackLabel({ id: 3, "external-filename": "/films/Episode 1.srt" }), "Episode 1.srt");
  assert.equal(trackLabel({ id: 3, "external-filename": "C:\\films\\Episode 1.srt" }), "Episode 1.srt");
  assert.equal(trackLabel({ id: 3 }), "Track 3");
});

test("a track list that is not a list is empty, not a throw", () => {
  // mpv answers `track-list` with null while nothing is loaded, and the pane
  // reads an empty list as "this file has no subtitles to turn on".
  for (const value of [null, undefined, "no", 7]) {
    assert.deepEqual(playerTracks(value), { subtitles: [], audio: [] });
  }
  // An entry with no usable id cannot be selected, so it is not offered.
  assert.deepEqual(playerTracks([{ type: "sub", title: "Broken" }]).subtitles, []);
});

test("the socket is a named pipe on Windows and a file everywhere else", () => {
  assert.equal(ipcSocketPath({ platform: "win32", pid: 42 }), "\\\\.\\pipe\\teminali-os-mpv-42");
  assert.equal(ipcSocketPath({ platform: "darwin", tmpdir: "/tmp", pid: 42 }), "/tmp/teminali-os-mpv-42.sock");
  // The pid is in the name so two windows do not fight over one endpoint.
  assert.notEqual(ipcSocketPath({ platform: "linux", tmpdir: "/tmp", pid: 1 }), ipcSocketPath({ platform: "linux", tmpdir: "/tmp", pid: 2 }));
});

/* ── Finding the binary ───────────────────────────────────────────────────── */

test("the override wins, then a bundled copy, then the fixed dirs, then PATH", () => {
  const env = { MPV_PATH: "/custom/mpv", PATH: "/somewhere/else" };
  assert.equal(findMpv({ env, resourcesPath: null, exists: () => true }), "/custom/mpv");

  const noOverride = { PATH: "/somewhere/else" };
  const bundled = path.join("/Resources", "mpv", process.platform === "win32" ? "mpv.exe" : "mpv");
  assert.equal(findMpv({ env: noOverride, resourcesPath: "/Resources", exists: () => true }), bundled);

  // PATH is searched last, so an arbitrary earlier entry cannot beat a known install.
  const onlyPath = path.join("/somewhere/else", process.platform === "win32" ? "mpv.exe" : "mpv");
  assert.equal(findMpv({ env: noOverride, resourcesPath: null, exists: (c) => c === onlyPath }), onlyPath);
});

test("no mpv anywhere is a real answer, not a throw", () => {
  assert.equal(findMpv({ env: { PATH: "" }, resourcesPath: null, exists: () => false }), null);
});

/* ── The wire ─────────────────────────────────────────────────────────────── */

test("a request is one line, newline included", () => {
  const framed = frameRequest({ command: ["get_property", "time-pos"], request_id: 7 });
  assert.ok(framed.endsWith("\n"), "mpv acts on nothing until the newline arrives");
  assert.equal(framed.split("\n").length, 2);
  assert.deepEqual(JSON.parse(framed), { command: ["get_property", "time-pos"], request_id: 7 });
});

test("a chunk that splits an object mid-way keeps the remainder", () => {
  const first = parseIpcChunk('{"error":"success","data":1,"request_id":1}\n{"eve');
  assert.equal(first.messages.length, 1);
  assert.equal(first.rest, '{"eve');
  const second = parseIpcChunk(`${first.rest}nt":"seek"}\n`);
  assert.deepEqual(second.messages, [{ event: "seek" }]);
  assert.equal(second.rest, "");
});

test("one unparseable line does not poison the stream behind it", () => {
  const { messages } = parseIpcChunk('not json\n{"event":"pause"}\n\n');
  assert.deepEqual(messages, [{ event: "pause" }]);
});

/* ── The endpoint file ────────────────────────────────────────────────────── */

test("a stale endpoint file is not believed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpv-endpoint-"));
  try {
    fs.writeFileSync(endpointFile(dir), JSON.stringify(endpointRecord({ socket: "/tmp/s.sock", pid: 424242, binary: "/usr/bin/mpv" })));
    assert.equal(runningMpv({ tmpdir: dir, alive: () => false }), null, "the process that wrote it is gone");
    assert.equal(runningMpv({ tmpdir: dir, alive: () => true }).socket, "/tmp/s.sock");

    fs.writeFileSync(endpointFile(dir), "{ not json");
    assert.equal(runningMpv({ tmpdir: dir, alive: () => true }), null);

    fs.writeFileSync(endpointFile(dir), JSON.stringify({ socket: "/tmp/s.sock" }));
    assert.equal(runningMpv({ tmpdir: dir, alive: () => true }), null, "a record with no pid cannot be checked");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no endpoint file at all is null, not a throw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpv-endpoint-"));
  try {
    assert.equal(runningMpv({ tmpdir: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── The client, against an mpv that is not mpv ───────────────────────────── */

/**
 * A socket that answers the way mpv's does. It is not a mock of the client —
 * the client is the thing under test — it is the far end of the protocol, so
 * that request correlation, the error path and property events are exercised
 * on a real socket rather than asserted about.
 */
function fakeMpv(handle) {
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mpv-fake-")), "s.sock");
  const server = net.createServer((connection) => {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      const { messages, rest } = parseIpcChunk(buffer + chunk);
      buffer = rest;
      for (const message of messages) {
        for (const reply of handle(message)) connection.write(`${JSON.stringify(reply)}\n`);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({
      socketPath,
      close: () => { server.close(); fs.rmSync(path.dirname(socketPath), { recursive: true, force: true }); },
    }));
  });
}

test("replies are matched to their own request, not to the order they arrive in", async () => {
  const fake = await fakeMpv((message) => {
    // Answer the second request first, which is exactly what request_id is for.
    if (message.command[1] === "duration") return [{ error: "success", data: 120, request_id: message.request_id }];
    return [{ error: "success", data: 12.5, request_id: message.request_id }];
  });
  const ipc = new MpvIpc(fake.socketPath);
  try {
    await ipc.connect();
    const [time, duration] = await Promise.all([ipc.getProperty("time-pos"), ipc.getProperty("duration")]);
    assert.equal(time, 12.5);
    assert.equal(duration, 120);
  } finally {
    ipc.close();
    fake.close();
  }
});

test("mpv's own error string is what the caller is told", async () => {
  const fake = await fakeMpv((message) => [{ error: "property not found", request_id: message.request_id }]);
  const ipc = new MpvIpc(fake.socketPath);
  try {
    await ipc.connect();
    await assert.rejects(() => ipc.getProperty("nonsense"), (error) => {
      assert.equal(error.code, "MPV_COMMAND_FAILED");
      assert.match(error.message, /property not found/);
      return true;
    });
  } finally {
    ipc.close();
    fake.close();
  }
});

test("a property change is named back with the snapshot field it feeds", async () => {
  const fake = await fakeMpv((message) => {
    if (message.command[0] === "observe_property") {
      return [
        { error: "success", request_id: message.request_id },
        { event: "property-change", id: message.command[1], name: message.command[2], data: true },
      ];
    }
    return [{ error: "success", request_id: message.request_id }];
  });
  const ipc = new MpvIpc(fake.socketPath);
  try {
    await ipc.connect();
    const seen = new Promise((resolve) => ipc.once("property", resolve));
    await ipc.observeProperty("pause");
    assert.deepEqual(await seen, { name: "pause", field: "playing", value: true });
  } finally {
    ipc.close();
    fake.close();
  }
});

test("a whole PlayerCommand goes down the socket as its mpv commands", async () => {
  const sent = [];
  const fake = await fakeMpv((message) => {
    sent.push(message.command);
    return [{ error: "success", request_id: message.request_id }];
  });
  const ipc = new MpvIpc(fake.socketPath);
  try {
    await ipc.connect();
    await ipc.run({ action: "restart" });
    assert.deepEqual(sent, [["seek", 0, "absolute+exact"], ["set_property", "pause", false]]);
    // An action mpv does not answer sends nothing at all.
    assert.equal(await ipc.run({ action: "episodes" }), null);
    assert.equal(sent.length, 2);
  } finally {
    ipc.close();
    fake.close();
  }
});

test("a command on a closed socket fails instead of hanging", async () => {
  const ipc = new MpvIpc(path.join(os.tmpdir(), "teminali-os-mpv-nothing-here.sock"));
  await assert.rejects(() => ipc.command("get_property", "pause"), (error) => error.code === "MPV_CLOSED");
  await assert.rejects(() => ipc.connect({ timeoutMs: 120 }), (error) => error.code === "MPV_NO_SOCKET");
});

test("the socket closing fails every request outstanding on it", async () => {
  const fake = await fakeMpv(() => []); // Never answers.
  const ipc = new MpvIpc(fake.socketPath);
  await ipc.connect();
  const pending = ipc.command("get_property", "pause");
  ipc.close();
  await assert.rejects(() => pending, (error) => error.code === "MPV_CLOSED");
  fake.close();
});

/* ── The screenshot ───────────────────────────────────────────────────────── */

/*
  `screenshot-raw` is the only way the agent sees the film while mpv owns the
  picture, and every way it can go wrong produces an *image* rather than an
  error: a padded row shears the frame diagonally, a zero alpha byte encodes as
  black, and a swapped channel order turns a blue sky orange. All three look
  like a working feature in a log, so all three are arithmetic here.
*/

/** One reply from mpv, with `stride` bytes per row of which `w * 4` are the picture. */
function rawReply({ w, h, stride = w * 4, format = "bgr0", fill = (x, y) => [x, y, x + y, 0] }) {
  const data = Buffer.alloc(stride * h, 0x7f); // The padding is not zero, so copying it would show.
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) data.set(fill(x, y), y * stride + x * 4);
  }
  return { w, h, stride, format, data: data.toString("base64") };
}

test("a row padded past its width is copied out, not sheared into the next one", () => {
  const packed = packBitmap(rawReply({ w: 3, h: 2, stride: 20 }));
  assert.equal(packed.width, 3);
  assert.equal(packed.height, 2);
  assert.equal(packed.pixels.length, 3 * 2 * 4, "the packed bitmap is tight; Electron is given no stride");
  // Row 1 begins with row 1's first pixel — with the padding copied it would
  // begin eight bytes early, which is what a diagonal tear looks like.
  assert.deepEqual([...packed.pixels.subarray(12, 15)], [0, 1, 1]);
  assert.equal(packed.pixels.includes(0x7f), false, "no padding byte survived into the picture");
});

test("bgr0's zero fourth byte is made opaque, because transparent encodes as black", () => {
  const packed = packBitmap(rawReply({ w: 2, h: 2 }));
  for (let byte = 3; byte < packed.pixels.length; byte += 4) {
    assert.equal(packed.pixels[byte], 255, "every alpha byte is opaque");
  }
  // The colour bytes are untouched: only the alpha is ours to decide.
  assert.deepEqual([...packed.pixels.subarray(0, 3)], [0, 0, 0]);
  assert.deepEqual([...packed.pixels.subarray(4, 7)], [1, 0, 1]);
});

test("only a BGRA byte order is accepted; a swap would be a lie about the colours", () => {
  assert.ok(packBitmap(rawReply({ w: 2, h: 1, format: "bgra" })), "bgra is the same order under another name");
  assert.equal(packBitmap(rawReply({ w: 2, h: 1, format: "rgba" })), null, "rgba is refused rather than reversed");
  assert.equal(packBitmap(rawReply({ w: 2, h: 1, format: "rgba64" })), null);
});

test("a reply that cannot be a picture is nothing, not a smaller picture", () => {
  assert.equal(packBitmap(null), null);
  assert.equal(packBitmap({ w: 2, h: 2, stride: 8 }), null, "no data at all");
  assert.equal(packBitmap({ ...rawReply({ w: 2, h: 2 }), w: 0 }), null, "a zero-width frame is not a frame");
  assert.equal(packBitmap({ ...rawReply({ w: 2, h: 2 }), stride: 4 }), null, "a stride narrower than the row");
  // Truncated in transit: reading past the end would pad the last rows with
  // whatever the allocator held, which is a picture with garbage at the bottom.
  const short = rawReply({ w: 4, h: 4 });
  const bytes = Buffer.from(short.data, "base64").subarray(0, 40);
  assert.equal(packBitmap({ ...short, data: bytes.toString("base64") }), null);
});
