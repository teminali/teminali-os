/*
  The renderer half of the exporter.

  Two kinds of test, and the split is deliberate.

  The first kind RUNS the planning module. `exportPlan.ts` is pure and imports
  nothing but types, so `node --test` loads it directly and the windowing, the
  solo gate and the envelope are measured rather than described. These are the
  decisions that fail silently: a clip windowed a frame early still exports,
  still plays, and is simply wrong.

  The second kind reads source text, because the driver and the dialog cannot
  be loaded here — they need a canvas, a bridge and React. What they can be
  held to is the wiring, which is exactly how a feature ships dead: the video
  project transport shipped with all four files individually correct and
  nothing requiring the module. See `video-project-bridge.test.mjs`.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  classifyMediaUrl,
  collectAudioClips,
  extensionFor,
  ffmpegSource,
  formatEta,
  outputDimensions,
  renderPercent,
  renderRate,
  renderWindow,
  suggestedFileName,
  volumeEnvelopeFor,
  windowEnvelope,
} from "../src/video/engine/exportPlan.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, "..", ...parts), "utf8");

/* ── Fixtures ───────────────────────────────────────────────────── */

const clip = (over = {}) => ({
  id: "c1",
  trackId: "t1",
  type: "video",
  name: "Clip",
  mediaUrl: "/media/a.mp4",
  color: "#fff",
  startTimeMs: 0,
  durationMs: 4000,
  sourceStartMs: 0,
  sourceDurationMs: 4000,
  fitMode: "contain",
  blendMode: "normal",
  transform: {},
  mask: {},
  speed: { multiplier: 1, curvePreset: "linear", preservePitch: true, reversed: false },
  keyframes: [],
  filters: {},
  chromaKey: {},
  effects: [],
  motionBlur: { enabled: false, shutterAngle: 180, samples: 2 },
  audio: {
    volume: 1, fadeInMs: 0, fadeOutMs: 0, pitch: 0,
    voiceEffect: "none", noiseReduction: false, ducking: false, detached: false,
  },
  locked: false,
  hidden: false,
  ...over,
});

const track = (over = {}) => ({
  id: "t1",
  type: "video",
  name: "V1",
  index: 0,
  muted: false,
  locked: false,
  solo: false,
  volume: 1,
  heightPx: 60,
  collapsed: false,
  clips: [],
  ...over,
});

const whole = { startMs: 0, renderMs: 60_000 };

/* ── Output geometry ────────────────────────────────────────────── */

test("a preset names the short edge, not the height", () => {
  assert.deepEqual(outputDimensions({ width: 1920, height: 1080 }, "1080p"), { width: 1920, height: 1080 });
  assert.deepEqual(outputDimensions({ width: 1920, height: 1080 }, "720p"), { width: 1280, height: 720 });
  /* The one that used to letterbox a phone-shaped sequence into a landscape
     frame: 1080p vertical is 1080 WIDE. */
  assert.deepEqual(outputDimensions({ width: 1080, height: 1920 }, "1080p"), { width: 1080, height: 1920 });
  assert.deepEqual(outputDimensions({ width: 1080, height: 1920 }, "4k"), { width: 2160, height: 3840 });
});

test("no axis is ever odd, because h264 and hevc reject one", () => {
  const out = outputDimensions({ width: 1001, height: 563 }, "720p");
  assert.equal(out.width % 2, 0);
  assert.equal(out.height % 2, 0);
  assert.ok(out.width >= 2 && out.height >= 2);
});

test("a degenerate project still produces a legal frame", () => {
  const out = outputDimensions({ width: 0, height: 0 }, "1080p");
  assert.ok(out.width >= 2 && out.height >= 2);
});

test("the container follows the codec", () => {
  assert.equal(extensionFor("prores"), "mov");
  assert.equal(extensionFor("h264"), "mp4");
  assert.equal(suggestedFileName("Ep 3: The Fix", "prores"), "Ep 3- The Fix.mov");
  assert.equal(suggestedFileName("", "h264"), "Untitled.mp4");
});

/* ── The render window ──────────────────────────────────────────── */

test("the whole sequence is the default window", () => {
  const w = renderWindow({ durationMs: 10_000, fps: 30 });
  assert.equal(w.startMs, 0);
  assert.equal(w.renderMs, 10_000);
  assert.equal(w.totalFrames, 300);
});

test("a range starts where it says and runs as long as it says", () => {
  const w = renderWindow({ durationMs: 10_000, fps: 30 }, { startMs: 2000, durationMs: 3000 });
  assert.equal(w.startMs, 2000);
  assert.equal(w.totalFrames, 90);
});

test("an empty range still renders one frame rather than an empty stream", () => {
  // ffmpeg reports an empty pipe as "no video" seconds later, and only after
  // the session has been opened and the power lock taken.
  assert.equal(renderWindow({ durationMs: 0, fps: 30 }).totalFrames, 1);
});

/* ── Media sources ──────────────────────────────────────────────── */

test("blob and data URLs are the ones that need writing to disk", () => {
  assert.equal(classifyMediaUrl("blob:http://localhost/abc"), "inline");
  assert.equal(classifyMediaUrl("data:video/mp4;base64,AA"), "inline");
  assert.equal(classifyMediaUrl("https://cdn.example/a.mp4"), "remote");
  assert.equal(classifyMediaUrl("file:///Users/x/a.mp4"), "path");
  assert.equal(classifyMediaUrl("/Users/x/a.mp4"), "path");
});

test("a file URL becomes a path ffmpeg can open", () => {
  // The real case: "Kerf Recordings" arrives percent-encoded, and ffmpeg
  // looks for a directory with a literal %20 in its name.
  assert.equal(
    ffmpegSource("file:///Users/x/Movies/Kerf%20Recordings/screen.mp4"),
    "/Users/x/Movies/Kerf Recordings/screen.mp4",
  );
  assert.equal(ffmpegSource("file:///C:/Users/x/a.mp4"), "C:/Users/x/a.mp4");
  assert.equal(ffmpegSource("https://cdn.example/a.mp4"), "https://cdn.example/a.mp4");
  assert.equal(ffmpegSource("/already/a/path.mp4"), "/already/a/path.mp4");
});

/* ── The audio collection ───────────────────────────────────────── */

test("a video clip carries its own audio and a graphic carries none", () => {
  const tracks = [
    track({ clips: [clip()] }),
    track({ id: "t2", type: "video", index: 1, clips: [clip({ id: "c2", type: "image", mediaUrl: "/m/a.png" })] }),
  ];
  const out = collectAudioClips(tracks, whole);
  assert.equal(out.length, 1);
  assert.equal(out[0].mediaUrl, "/media/a.mp4");
});

test("a sticker on an audio track is still not a sound", () => {
  const tracks = [track({ type: "audio", clips: [clip({ type: "sticker", mediaUrl: "/m/x.webm" })] })];
  assert.deepEqual(collectAudioClips(tracks, whole), []);
});

test("muting a track removes it from the mix", () => {
  assert.deepEqual(collectAudioClips([track({ muted: true, clips: [clip()] })], whole), []);
});

test("soloing an AUDIO track silences a video clip's own audio", () => {
  /* The gate audioEngine.gainFor applies, mirrored exactly. Counting solo
     over every track type — which is what the PICTURE does — would leave the
     screen recording's audio under a soloed narration and make the export
     sound nothing like the preview of it. */
  const tracks = [
    track({ clips: [clip()] }),
    track({ id: "t2", type: "audio", index: 1, solo: true, clips: [clip({ id: "c2", type: "audio", mediaUrl: "/m/vo.wav" })] }),
  ];
  const out = collectAudioClips(tracks, whole);
  assert.deepEqual(out.map((c) => c.mediaUrl), ["/m/vo.wav"]);
});

test("soloing a VIDEO track does not silence the audio tracks", () => {
  const tracks = [
    track({ solo: true, clips: [clip()] }),
    track({ id: "t2", type: "audio", index: 1, clips: [clip({ id: "c2", type: "audio", mediaUrl: "/m/vo.wav" })] }),
  ];
  assert.equal(collectAudioClips(tracks, whole).length, 2);
});

test("the detached half of a split clip does not sound twice", () => {
  // `detachAudio` leaves the video clip at volume 0 AND keeps its keyframes,
  // so the volume test alone would let an automated clip back into the mix.
  const source = clip({
    audio: { ...clip().audio, volume: 0, detached: true },
    keyframes: [
      { id: "k1", property: "volume", timeOffsetMs: 0, value: 1, easing: "linear" },
      { id: "k2", property: "volume", timeOffsetMs: 1000, value: 0.5, easing: "linear" },
    ],
  });
  const tracks = [
    track({ clips: [source] }),
    track({ id: "t2", type: "audio", index: 1, clips: [clip({ id: "c2", type: "audio", mediaUrl: "/m/split.wav" })] }),
  ];
  assert.deepEqual(collectAudioClips(tracks, whole).map((c) => c.mediaUrl), ["/m/split.wav"]);
});

test("track and clip faders multiply", () => {
  const tracks = [track({ volume: 0.5, clips: [clip({ audio: { ...clip().audio, volume: 0.5 } })] })];
  assert.equal(collectAudioClips(tracks, whole)[0].volume, 0.25);
});

test("a clip outside the range is not in the mix", () => {
  const tracks = [track({ clips: [clip({ startTimeMs: 0, durationMs: 1000 })] })];
  assert.deepEqual(collectAudioClips(tracks, { startMs: 2000, renderMs: 1000 }), []);
});

test("a range cuts the head off a clip and moves the source in with it", () => {
  const tracks = [track({ clips: [clip({ startTimeMs: 0, durationMs: 4000, sourceStartMs: 1000 })] })];
  const [only] = collectAudioClips(tracks, { startMs: 1000, renderMs: 2000 });
  assert.equal(only.startTimeMs, 0, "the clip starts at the top of the exported file");
  assert.equal(only.durationMs, 2000, "head and tail both cut");
  assert.equal(only.sourceStartMs, 2000, "one second of source consumed by the head cut");
});

test("source time advances at playback speed", () => {
  const tracks = [track({
    clips: [clip({ startTimeMs: 0, durationMs: 4000, speed: { ...clip().speed, multiplier: 2 } })],
  })];
  const [only] = collectAudioClips(tracks, { startMs: 1000, renderMs: 3000 });
  assert.equal(only.sourceStartMs, 2000, "a second cut at 2x consumes two seconds of file");
});

test("reversal flips which cut moves the source", () => {
  const tracks = [track({
    clips: [clip({ startTimeMs: 0, durationMs: 4000, speed: { ...clip().speed, reversed: true } })],
  })];
  // Head cut 1000, tail cut 1000: reversed, the TAIL is what the source seeks past.
  const [only] = collectAudioClips(tracks, { startMs: 1000, renderMs: 2000 });
  assert.equal(only.reversed, true);
  assert.equal(only.sourceStartMs, 1000);
});

test("a fade whose own end was cut away does not survive", () => {
  const tracks = [track({
    clips: [clip({ startTimeMs: 0, durationMs: 4000, audio: { ...clip().audio, fadeInMs: 500, fadeOutMs: 500 } })],
  })];
  const [cut] = collectAudioClips(tracks, { startMs: 1000, renderMs: 2000 });
  assert.equal(cut.fadeInMs, 0, "a fade-in cut through would ramp from silence mid-word");
  assert.equal(cut.fadeOutMs, 0);

  const [kept] = collectAudioClips(tracks, whole);
  assert.equal(kept.fadeInMs, 500);
  assert.equal(kept.fadeOutMs, 500);
});

/* ── The envelope ───────────────────────────────────────────────── */

test("volume keyframes become an envelope with the fader multiplied in", () => {
  const withKeys = clip({
    keyframes: [
      { id: "k1", property: "volume", timeOffsetMs: 1000, value: 1, easing: "linear" },
      { id: "k2", property: "volume", timeOffsetMs: 0, value: 0, easing: "linear" },
      { id: "k3", property: "opacity", timeOffsetMs: 0, value: 1, easing: "linear" },
    ],
  });
  const points = volumeEnvelopeFor(withKeys, 0.5);
  // Sorted by time, opacity ignored, and the fader applied ONCE — the
  // envelope replaces the static volume downstream, so applying both would
  // square a 0.5 fader into 0.25.
  assert.deepEqual(points, [{ tMs: 0, v: 0 }, { tMs: 1000, v: 0.5 }]);
});

test("one keyframe is not an envelope", () => {
  const one = clip({ keyframes: [{ id: "k1", property: "volume", timeOffsetMs: 0, value: 0.5, easing: "linear" }] });
  assert.equal(volumeEnvelopeFor(one, 1), undefined);
});

test("a windowed envelope is interpolated at the cut, not truncated to it", () => {
  // A ramp 0 -> 1 over 2s, cut at 1s, must start at 0.5. Dropping the points
  // outside instead would start the export at the next surviving keyframe
  // and jump the level.
  const points = [{ tMs: 0, v: 0 }, { tMs: 2000, v: 1 }];
  const windowed = windowEnvelope(points, 1000, 500);
  assert.equal(windowed[0].tMs, 0);
  assert.equal(windowed[0].v, 0.5);
  assert.equal(windowed[windowed.length - 1].tMs, 500);
  assert.equal(windowed[windowed.length - 1].v, 0.75);
});

/* ── Progress ───────────────────────────────────────────────────── */

test("the frame band stops at 90, so the audio mix has somewhere to live", () => {
  assert.equal(renderPercent(0, 100), 2);
  assert.equal(renderPercent(50, 100), 46);
  assert.equal(renderPercent(100, 100), 90);
  // "Finished but nothing happened" is what a bar that sits at 100% through
  // a two-minute mix reports.
  assert.ok(renderPercent(100, 100) < 100);
});

test("rate and ETA come off the clock, not the frame count", () => {
  const { fps, etaMs } = renderRate(30, 90, 1000);
  assert.equal(fps, 30);
  assert.equal(etaMs, 2000);
  assert.deepEqual(renderRate(0, 90, 0), { fps: 0, etaMs: null });
});

test("an unknown ETA says so rather than claiming zero", () => {
  assert.equal(formatEta(null), "—");
  assert.equal(formatEta(12_000), "12s");
  assert.equal(formatEta(64_000), "1:04");
});

/* ── The wiring ─────────────────────────────────────────────────── */

const pipeline = read("src", "video", "engine", "exportPipeline.ts");
const dialog = read("src", "video", "components", "preview", "ExportDialog.tsx");
const previewPlayer = read("src", "video", "components", "preview", "PreviewPlayer.tsx");
const videoPane = read("src", "components", "workspace", "panels", "VideoPane.tsx");
const app = read("src", "App.tsx");
const mainSource = read("electron", "main.cjs");
const preloadSource = read("electron", "preload.cjs");
const uiStore = read("src", "video", "store", "uiStore.ts");
const overlays = read("src", "video", "components", "ui", "Overlays.tsx");
const videoProjects = read("electron", "videoProjects.cjs");

test("the export dialog is mounted, or nothing can open it", () => {
  assert.match(videoPane, /import \{ ExportDialog \}/);
  assert.match(videoPane, /<ExportDialog \/>/);
});

test("the program monitor offers the export", () => {
  assert.match(previewPlayer, /setExportModalOpen\(true\)/);
});

test("the preview yields the video elements to a running export", () => {
  /* `seekVideosForFrame` drives the same <video> cache the monitor draws
     from. Two callers and the file holds whichever wrote last. */
  assert.match(previewPlayer, /active: !isPlayerOpen && !isExporting/);
});

test("the export loop gives the thread back to the app", () => {
  // The ported loop yields once every 80ms, which freezes a window and would
  // freeze this whole IDE — the editor is a panel in it.
  assert.match(pipeline, /requestAnimationFrame/);
  assert.match(pipeline, /PAINT_BUDGET_MS/);
  assert.match(pipeline, /await nextPaint\(\)/);
});

test("a hidden window cannot stall the export forever", () => {
  // rAF stops in a minimised or occluded window; the timer is what keeps a
  // backgrounded export moving.
  assert.match(pipeline, /setTimeout\(finish, PAINT_TIMEOUT_MS\)/);
});

test("the timestamp is computed from the frame index every time", () => {
  // Accumulating an interval drifts, and a drifted timestamp lands a frame on
  // the wrong side of a cut.
  assert.match(pipeline, /startMs \+ frame \* frameIntervalMs/);
});

test("the export refuses what would encode as a placeholder", () => {
  assert.match(pipeline, /undecodableSources\(tracks\)/);
  // teminaliCut has this helper and never calls it on the export path; a
  // tainted canvas throws thousands of frames in.
  assert.match(pipeline, /hasTaintedMedia\(\)/);
});

test("a failed or cancelled export does not leave ffmpeg running", () => {
  assert.match(pipeline, /if \(sessionId\) void exporter\.cancel\(sessionId\)/);
});

test("blob sources are written to disk rather than handed to ffmpeg", () => {
  /* Not the desktop app's ordinary path, and the comment that said so was
     wrong. In Electron the recorder writes each track to disk and hands back
     a `file://` URL (`screenRecorder.cjs`), the import gate refuses a file it
     cannot name a path for (`MediaPanel.tsx`), and `isWeb` — the only thing
     that mints blob tracks — needs either no bridge or a `web:` source id
     that only the bridgeless build offers. So this covers the browser build
     and any `data:` source, and it is proven rather than assumed: a blob
     round-trip of a real take exported audio identical to the same take's
     `file://` export, to a tenth of a dB. */
  assert.match(pipeline, /materialiseSources/);
  assert.match(preloadSource, /export:material/);
  assert.match(mainSource, /initVideoExport\(\)/);
});

test("the menu can open the export, and every side of that channel exists", () => {
  assert.match(mainSource, /menu:export-video/);
  assert.match(mainSource, /accelerator: "Alt\+CmdOrCtrl\+E"/);
  assert.match(preloadSource, /"menu:export-video"/);
  assert.match(app, /bridge\.menu\.on\("menu:export-video"/);
});

test("the dialog cancels through the store, so an agent's export cancels too", () => {
  assert.match(dialog, /cancelActiveExport/);
  assert.match(pipeline, /setActiveExportCancelHandler\(\(\) => controller\.abort\(\)\)/);
});

test("a finished export says where the file went", () => {
  /* Dropping back into the settings pane with nothing but a toast is how a
     rendered file gets lost: the operator never chose the destination and
     has no idea what "your Videos folder" resolves to. */
  assert.match(dialog, /phase === 'done' && lastExportPath/);
  assert.match(dialog, /\) : finished \? \(/);
  assert.match(dialog, /Export finished/);
});

test("the reveal is one channel, and it exists on both sides", () => {
  assert.match(dialog, /const revealExport = \(path: string\): void =>/);
  assert.match(dialog, /window\.teminali\?\.videoProjects\?\.reveal\(path\)/);
  assert.match(preloadSource, /videoProject:reveal/);
  assert.match(videoProjects, /shell\.showItemInFolder/);
});

test("the reveal button is named what the platform names it", () => {
  // "Show in Finder" on a Windows machine is a button nobody presses.
  assert.match(dialog, /'darwin'\s*\n?\s*\? 'Show in Finder'/);
  assert.match(dialog, /'win32'\s*\n?\s*\? 'Show in Explorer'/);
  assert.match(dialog, /: 'Show in folder'/);
});

test("the finish toast can reveal too, because the dialog may be hidden", () => {
  // The dialog says in as many words that hiding it leaves the export
  // running, so the toast is the only surface some exports ever get.
  assert.match(uiStore, /export interface ToastAction/);
  assert.match(uiStore, /action\?: ToastAction;/);
  assert.match(overlays, /t\.action\.label/);
  assert.match(dialog, /action: \{ label: REVEAL_LABEL, onSelect: \(\) => revealExport\(written\) \}/);
  // 3.2s is the default and is not long enough to decide to press a button.
  assert.match(dialog, /ttl: 9000/);
});

test("taking a toast's offer dismisses it", () => {
  assert.match(overlays, /t\.action\?\.onSelect\(\);\s*\n\s*dismiss\(t\.id\);/);
});
