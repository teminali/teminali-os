import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  ENGINE_PROPERTIES,
  MpvView,
  canEmbedSpawned,
  embedArgs,
  nativeHandle,
  screenRect,
  shouldShow,
  trackId,
} from "../electron/mpvView.cjs";
import { OBSERVED_PROPERTIES, mpvArgs } from "../electron/mpvProcess.cjs";
import { embeddedPictureBounds, subtitleFileToLoad, subtitleToRestore } from "../src/services/mpvView.ts";

/**
 * Embedding, at the four places it fails without saying so.
 *
 * A handle read at the wrong width is a plausible number that addresses no
 * window; an argument list built on the wrong platform embeds into nothing; a
 * rectangle missing the window's origin puts the video somewhere else on the
 * desktop; and an option mpv already had a default for is a second set of
 * controls drawn over the pane's. None of those throw, and the machine this is
 * written on cannot run any of them — darwin is the one platform where the
 * whole path is refused — so the decisions are separated from the window and
 * tested here.
 */

/* ── Which platforms can do it at all ─────────────────────────────────────── */

test("a spawned mpv embeds on Windows and Linux, and never on darwin", () => {
  assert.equal(canEmbedSpawned("win32"), true);
  assert.equal(canEmbedSpawned("linux"), true);
  /*
    Not an omission. `--wid` on the Mac is an `NSView` pointer, which means
    nothing outside its own process, so B3 there is a linked libmpv — the fact
    that decided B0's licence. See docs/MEDIA_LICENSING.md.
  */
  assert.equal(canEmbedSpawned("darwin"), false);
});

test("an unsupported platform refuses before a window is ever made", () => {
  const view = new MpvView({ window: null, platform: "darwin" });
  assert.equal(view.supported, false);
  const answer = view.attach();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /libmpv/);
});

/* ── The handle ───────────────────────────────────────────────────────────── */

test("a pointer-width handle is read at both widths", () => {
  const wide = Buffer.alloc(8);
  wide.writeBigUInt64LE(918_273n);
  assert.equal(nativeHandle(wide), "918273");

  const narrow = Buffer.alloc(4);
  narrow.writeUInt32LE(4_294_967_295);
  assert.equal(nativeHandle(narrow), "4294967295");
});

test("a handle wider than a JavaScript number survives intact", () => {
  /*
    The reason the answer is a string. Read as a number this would round, and
    mpv would be handed a window id one or two off the real one — which is not
    an error anywhere, just a video output that never appears.
  */
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(9_007_199_254_740_993n);
  assert.equal(nativeHandle(buffer), "9007199254740993");
  assert.notEqual(Number(nativeHandle(buffer)).toString(), "9007199254740993");
});

test("nothing that is not a handle is treated as one", () => {
  assert.equal(nativeHandle(null), null);
  assert.equal(nativeHandle(Buffer.alloc(0)), null);
  assert.equal(nativeHandle(Buffer.alloc(2)), null);
});

/* ── The arguments ────────────────────────────────────────────────────────── */

const HANDLE = "4720198";

test("the embed arguments carry the window and silence mpv's own interface", () => {
  const args = embedArgs({ handle: HANDLE, platform: "win32" });
  assert.ok(args.includes(`--wid=${HANDLE}`));
  // Started --idle with no file, mpv makes no video output without this.
  assert.ok(args.includes("--force-window=yes"));
  // Each of these is a default that would draw or answer over the pane.
  assert.ok(args.includes("--osc=no"));
  assert.ok(args.includes("--osd-level=0"));
  assert.ok(args.includes("--input-cursor=no"));
  assert.ok(args.includes("--input-vo-keyboard=no"));
  assert.ok(args.includes("--cursor-autohide=no"));
});

test("the video output is left to mpv to choose", () => {
  /*
    Naming `--vo=gpu` would turn a machine where gpu fails into a black
    rectangle instead of letting mpv fall back. mpv's default already resolves
    to gpu on both embedding platforms.
  */
  const args = embedArgs({ handle: HANDLE, platform: "linux" });
  assert.equal(args.some((arg) => arg.startsWith("--vo")), false);
});

test("no embed argument overrides one the transport already set", () => {
  /*
    The two lists are concatenated at spawn, and mpv takes the last of a
    repeated option. A collision would mean this file quietly deciding
    something mpvProcess.cjs believes it owns.
  */
  const optionOf = (arg) => String(arg).split("=")[0];
  const transport = new Set(mpvArgs({ socket: "/tmp/socket" }).map(optionOf));
  for (const arg of embedArgs({ handle: HANDLE, platform: "linux" })) {
    assert.equal(transport.has(optionOf(arg)), false, `${optionOf(arg)} is set by both lists`);
  }
});

test("there are no arguments to embed with where a spawned mpv cannot be embedded", () => {
  assert.equal(embedArgs({ handle: HANDLE, platform: "darwin" }), null);
});

test("a handle that did not decode is refused rather than passed on", () => {
  /*
    The shape this guards is handing `getNativeWindowHandle()` straight to
    `embedArgs`: a Buffer stringifies into `--wid=<Buffer 12 34 ...>`, which
    mpv rejects at startup with a message nobody is reading.
  */
  assert.equal(embedArgs({ handle: Buffer.alloc(8), platform: "win32" }), null);
  assert.equal(embedArgs({ handle: "0x47", platform: "win32" }), null);
  assert.equal(embedArgs({ handle: null, platform: "win32" }), null);
  assert.equal(embedArgs({ platform: "win32" }), null);
});

/* ── The rectangle ────────────────────────────────────────────────────────── */

test("a rectangle in the window becomes one on the screen", () => {
  const rect = screenRect({
    content: { x: 120, y: 64, width: 1440, height: 900 },
    bounds: { x: 300, y: 48, width: 800, height: 450 },
  });
  assert.deepEqual(rect, { x: 420, y: 112, width: 800, height: 450 });
});

test("a window at the origin is not a window with no origin", () => {
  const rect = screenRect({ content: { x: 0, y: 0 }, bounds: { x: 10, y: 20, width: 5, height: 6 } });
  assert.deepEqual(rect, { x: 10, y: 20, width: 5, height: 6 });
});

test("a collapsed rectangle is still a legal window", () => {
  /*
    A BrowserWindow cannot be zero-sized. The collapsed case is meant to be
    hidden, which is `shouldShow`'s answer — this one only has to stay legal.
  */
  const rect = screenRect({ content: { x: 10, y: 10 }, bounds: { x: 0, y: 0, width: 0, height: 0 } });
  assert.equal(rect.width, 1);
  assert.equal(rect.height, 1);
});

/* ── When it is on screen ─────────────────────────────────────────────────── */

test("the video is on screen only when the pane says so and has room for it", () => {
  const bounds = { x: 0, y: 0, width: 800, height: 450 };
  assert.equal(shouldShow({ visible: true, bounds }), true);
  // The renderer's own decision: another tab is on top, or an overlay is open.
  assert.equal(shouldShow({ visible: false, bounds }), false);
  // Mid-animation or scrolled out of the window; a sliver of video is worse than none.
  assert.equal(shouldShow({ visible: true, bounds: { x: 0, y: 0, width: 0, height: 450 } }), false);
  assert.equal(shouldShow({ visible: true, bounds: { x: 0, y: 0, width: 800, height: 0 } }), false);
  assert.equal(shouldShow({ visible: true, bounds: null }), false);
  assert.equal(shouldShow({}), false);
});

/* ── The band the picture gets ────────────────────────────────────────────── */

/*
  The renderer's half of the same rectangle, and the one thing the browser
  panel never had to solve. Its page is a view *above* the document, and the
  panel's chrome is beside it rather than over it. The player's chrome floats
  on the picture — which works for an element and cannot work for an OS window,
  because a control drawn over one is drawn behind it. So the picture is the
  pane less the bars, and these are the sums that decide it.
*/

const paneWindow = { innerWidth: 1440, innerHeight: 900 };
const el = (rect) => ({ getBoundingClientRect: () => rect });
const measure = (surface, chrome) => {
  const saved = globalThis.window;
  globalThis.window = paneWindow;
  try {
    return embeddedPictureBounds(surface, chrome);
  } finally {
    globalThis.window = saved;
  }
};

test("the picture is the pane less the chrome drawn over it", () => {
  const surface = el({ left: 200, top: 100, right: 1240, bottom: 800 });
  assert.deepEqual(
    measure(surface, { top: el({ top: 100, bottom: 160 }), bottom: el({ top: 720, bottom: 800 }) }),
    { x: 200, y: 160, width: 1040, height: 560 },
  );
  // A bar that is not there insets nothing — the picture keeps that edge.
  assert.deepEqual(
    measure(surface, { top: el({ top: 100, bottom: 160 }) }),
    { x: 200, y: 160, width: 1040, height: 640 },
  );
  assert.deepEqual(measure(surface, {}), { x: 200, y: 100, width: 1040, height: 700 });
  assert.deepEqual(measure(surface, { top: null, bottom: null }), { x: 200, y: 100, width: 1040, height: 700 });
});

test("chrome taller than the pane leaves no picture rather than an inverted one", () => {
  // A negative height reaches mpv as a window with a negative size; the pane
  // is allowed to be smaller than its own controls, and the answer to that is
  // to draw nothing, which `shouldShow` already reads as hide.
  const surface = el({ left: 0, top: 0, right: 400, bottom: 200 });
  const squeezed = measure(surface, { top: el({ top: 0, bottom: 190 }), bottom: el({ top: 40, bottom: 200 }) });
  assert.equal(squeezed.height, 0);
  assert.equal(shouldShow({ visible: true, bounds: squeezed }), false);
  // Either bar alone, past the far edge of the pane.
  assert.equal(measure(surface, { top: el({ top: 0, bottom: 900 }) }).height, 0);
  assert.equal(measure(surface, { bottom: el({ top: -50, bottom: 200 }) }).height, 0);
});

test("an unmeasurable pane is not inset into existence", () => {
  // No pane, or one scrolled out of the window: zero stays zero rather than
  // becoming a rectangle a bar's edge invented.
  assert.deepEqual(measure(null, { top: el({ top: 0, bottom: 60 }) }), { x: 0, y: 0, width: 0, height: 0 });
  const offscreen = el({ left: 1500, top: 100, right: 1900, bottom: 400 });
  assert.equal(measure(offscreen, { top: el({ top: 100, bottom: 160 }) }).width, 0);
});

/* ── What the engine says about its tracks ────────────────────────────────── */

test("a selected track is a number, and everything else is nothing selected", () => {
  /*
    mpv answers `sid` with `false` when subtitles are off and with `"auto"`
    before it has chosen. Both are plausible-looking values that a menu
    comparing ids would draw as a selected track, so both become null — which
    is what the pane already means by no active track.
  */
  assert.equal(trackId(2), 2);
  assert.equal(trackId("3"), 3);
  assert.equal(trackId(false), null);
  assert.equal(trackId("auto"), null);
  assert.equal(trackId("no"), null);
  assert.equal(trackId(null), null);
  assert.equal(trackId(undefined), null);
  // mpv numbers tracks from 1; a 0 is not a track it could ever have meant.
  assert.equal(trackId(0), null);
});

test("the engine's own properties are not the transport's snapshot fields", () => {
  /*
    These two are observed by `initMpvView` after the owner is set, not by
    `observeAll`, and they carry the pane's menu rather than the contract's
    state. A name landing in both maps would be sent twice under two different
    field names — the pane would see `tracks` and a snapshot field fighting.
  */
  for (const name of Object.keys(ENGINE_PROPERTIES)) {
    assert.ok(!(name in OBSERVED_PROPERTIES), `${name} is claimed by both maps`);
  }
  assert.equal(ENGINE_PROPERTIES["track-list"], "tracks");
  assert.equal(ENGINE_PROPERTIES.sid, "subtitleId");
  // `aid` is deliberately absent: no snapshot field and no menu row wants it.
  assert.ok(!("aid" in ENGINE_PROPERTIES));
});

test("every channel the preload invokes has a handler in main, the frame included", () => {
  /*
    A source assertion, and the same bug `tests/player-frame.test.mjs` guards
    at the other boundary: three files each correct alone, disagreeing about a
    string. `ipcRenderer.invoke` on a channel nobody handles does not throw
    here — it rejects in the renderer, which the pane catches and turns into a
    fallback — so a mistyped channel is a feature that quietly never works.

    The bridge and the handler are also owned by different threads
    (`preload.cjs` is `teminalicode-9c`'s), which is exactly the arrangement in
    which one half gets renamed without the other.
  */
  const preload = fs.readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const main = fs.readFileSync(new URL("../electron/mpvView.cjs", import.meta.url), "utf8");
  const channels = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\("(mpv-view:[a-z-]+)"/g)].map(([, name]) => name);
  assert.ok(channels.includes("mpv-view:frame"), "the pane has no way to ask mpv for a picture");
  for (const channel of new Set(channels)) {
    assert.match(main, new RegExp(`ipcMain\\.(?:handle|on)\\("${channel}"`), `${channel} is invoked but never handled`);
  }
});

test("the frame is asked for and answered in one word — `image`, the same one the agent reads", () => {
  /*
    `MpvFrameAnswer.image` is `PlayerFrameCapture.image` is the POST body's
    `image` is `resolvePlayerFrame`'s. The camera path renames it once on that
    journey and has been broken for four releases because of it.
  */
  const bridge = fs.readFileSync(new URL("../src/services/mpvView.ts", import.meta.url), "utf8");
  assert.match(bridge, /image\?: string/, "the engine's picture is `image`, singular");
  const main = fs.readFileSync(new URL("../electron/mpvView.cjs", import.meta.url), "utf8");
  assert.match(main, /ok: true, image:/, "main answers with the same word the bridge declares");
});

test("the remembered language is re-asked for, once, and never over a deliberate off", () => {
  /*
    mpv opens a file in its own choice of subtitle — `--sub-auto` plus whatever
    the file marks default — and only then reports the tracks. The pane's
    preference is a label; mpv's selection is an id; they can only be compared
    after the fact, so the pane re-asks. This is the whole of when it should,
    and each `null` below is a bug rather than a no-op if it were not one.
  */
  const tracks = [
    { id: 1, label: "English", language: "eng", selected: true, external: false },
    { id: 2, label: "Swahili", language: "swa", selected: false, external: true },
  ];
  assert.equal(subtitleToRestore("Swahili", tracks, 1).id, 2, "the remembered language is asked for");
  // Already on: the answer to this command is a new `sid` arriving back here,
  // so a re-send at that point is the loop rather than the end of it.
  assert.equal(subtitleToRestore("Swahili", tracks, 2), null);
  // Turning subtitles off stores null. Re-applying anything over it would turn
  // them back on at the top of every episode.
  assert.equal(subtitleToRestore(null, tracks, 1), null);
  // A language this file does not have: mpv's own choice beats none, and "the
  // first track" is how a Swahili preference becomes silent French.
  assert.equal(subtitleToRestore("Klingon", tracks, 1), null);
  // Before the engine has said anything there is nothing to match against.
  assert.equal(subtitleToRestore("Swahili", undefined, null), null);
  assert.equal(subtitleToRestore("Swahili", [], null), null);
  // Nothing selected at all is still a reason to ask, not a reason to wait.
  assert.equal(subtitleToRestore("English", tracks, null).id, 1);
});

test("a dropped subtitle reaches mpv by the path the gesture produced", () => {
  /*
    The pane's own path reads the `File`'s bytes into a WebVTT blob, which mpv
    cannot take: it opens files by path, and the renderer is told a dropped
    file's path by exactly one thing — `webUtils.getPathForFile`, the same
    bridge the media gate is built on. So the drop is a gesture that produces a
    path, and this is where the two meet.
  */
  const outcome = subtitleFileToLoad({ name: "Arrival.2016.srt" }, () => "/Users/t/Films/Arrival.2016.srt");
  assert.deepEqual(outcome.command, {
    action: "subtitle_file",
    value: { path: "/Users/t/Films/Arrival.2016.srt", title: "Arrival.2016" },
  });
  // The label the pane remembers and the title mpv is given are one string, not
  // two rules that agree until somebody edits one of them: `subtitleToRestore`
  // above compares exactly these on the next file.
  assert.equal(outcome.label, "Arrival.2016");
  assert.equal(outcome.label, outcome.command.value.title);
});

test("a subtitle that cannot be located says which of the two things went wrong", () => {
  // No bridge — a browser build, or an Electron without `webUtils`. Nothing was
  // ever going to work, so the sentence names the one thing that would: mpv
  // loads sidecars itself, by `--sub-auto=exact`.
  const noBridge = subtitleFileToLoad({ name: "Arrival.srt" }, null);
  assert.ok(noBridge.refusal.includes("beside the video"), noBridge.refusal);
  assert.ok(!("command" in noBridge));

  // A bridge that answers nothing — the drop carried no file on this disk. A
  // different failure, so a different sentence: this one names the file, which
  // is how an operator tells the two apart without reading the log.
  for (const answer of [null, "", "   "]) {
    const lost = subtitleFileToLoad({ name: "Arrival.srt" }, () => answer);
    assert.ok(lost.refusal.includes("Arrival.srt"), lost.refusal);
    assert.ok(!("command" in lost));
  }
});

test("a subtitle file with no extension keeps the whole of its name", () => {
  // The label rule strips one extension; a name with none is not a name with an
  // empty one. `"subs"` must not become `""`, which mpv would take as no title
  // at all and `subtitleToRestore` could never match again.
  const outcome = subtitleFileToLoad({ name: "subs" }, () => "/tmp/subs");
  assert.equal(outcome.label, "subs");
});
