/*
  The exporter, in two halves.

  The first asserts the strings: argv and filtergraph are the part of this
  feature that fails without throwing — a wrong `adelay` moves narration half
  a second and ffmpeg still exits 0 — so they are compared as text.

  The second is a bridge test, modelled on `video-project-bridge.test.mjs` and
  there for the same reason: a complete and correct module that nothing
  required is exactly how the recorder shipped dead. It reads all three files
  and asserts they agree.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  encoderArgs, pitchShift, speedStages, envelopeExpression, mixArgsFor,
} from "../electron/exportFilters.cjs";

const here = dirname(fileURLToPath(import.meta.url));
const electron = (name) => readFileSync(join(here, "..", "electron", name), "utf8");

const clip = (over = {}) => ({
  mediaUrl: "/takes/a.mp4", startTimeMs: 0, durationMs: 1000, sourceStartMs: 0,
  volume: 1, fadeInMs: 0, fadeOutMs: 0, speed: 1, pitch: 0,
  voiceEffect: "none", noiseReduction: false, ducking: false, ...over,
});

const filterFor = (c) => {
  const args = mixArgsFor([c], "/tmp/out.m4a");
  return args[args.indexOf("-filter_complex") + 1].split(";")[0];
};

/* ── Encoder argv ───────────────────────────────────────────────── */

test("h264 without a bitrate encodes at CRF 18", () => {
  const args = encoderArgs({ codec: "h264", height: 1080 }, null);
  assert.deepEqual(args, ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p"]);
});

test("a bitrate replaces CRF rather than joining it", () => {
  const args = encoderArgs({ codec: "h264", height: 1080, bitrateMbps: 20 }, null);
  assert.ok(args.includes("-b:v") && args.includes("20M"));
  assert.ok(!args.includes("-crf"), "CRF and -b:v together let the last one silently win");
});

test("hevc is tagged hvc1, or QuickTime and Safari refuse the file", () => {
  assert.ok(encoderArgs({ codec: "hevc", height: 1080 }, null).join(" ").includes("-tag:v hvc1"));
  assert.ok(encoderArgs({ codec: "hevc", height: 1080 }, "hevc_videotoolbox").join(" ").includes("-tag:v hvc1"));
});

test("a hardware encoder gets a bitrate, because CRF means nothing to it", () => {
  const hd = encoderArgs({ codec: "h264", height: 1080, hardware: true }, "h264_videotoolbox");
  assert.deepEqual(hd, ["-c:v", "h264_videotoolbox", "-b:v", "12M", "-pix_fmt", "yuv420p"]);
  assert.ok(!hd.includes("-crf"));

  const uhd = encoderArgs({ codec: "h264", height: 2160, hardware: true }, "h264_videotoolbox");
  assert.ok(uhd.includes("40M"), "4K needs the higher default");
});

test("an explicit bitrate still beats the hardware default", () => {
  const args = encoderArgs({ codec: "h264", height: 2160, hardware: true, bitrateMbps: 8 }, "h264_nvenc");
  assert.ok(args.includes("8M") && !args.includes("40M"));
});

test("prores ignores hardware and bitrate alike", () => {
  const args = encoderArgs({ codec: "prores", height: 2160, hardware: true, bitrateMbps: 50 }, "h264_videotoolbox");
  assert.deepEqual(args, ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]);
});

/* ── Pitch and speed ────────────────────────────────────────────── */

test("pitch shift restores the original duration", () => {
  const stages = pitchShift(12);
  assert.equal(stages[0], "asetrate=48000*2.000000");
  const tempo = stages.filter((s) => s.startsWith("atempo="))
    .reduce((n, s) => n * Number(s.slice(7)), 1);
  assert.ok(Math.abs(tempo - 0.5) < 1e-4, "an octave up must be halved back in time");
});

test("a shift beyond atempo's range is chained, not clamped", () => {
  const stages = pitchShift(-24).filter((s) => s.startsWith("atempo="));
  assert.ok(stages.length > 1, "atempo only accepts 0.5-2.0 per instance");
  const product = stages.reduce((n, s) => n * Number(s.slice(7)), 1);
  assert.ok(Math.abs(product - 4) < 1e-3);
});

test("zero semitones is still a no-op chain", () => {
  const tempo = pitchShift(0).filter((s) => s.startsWith("atempo="))
    .reduce((n, s) => n * Number(s.slice(7)), 1);
  assert.ok(Math.abs(tempo - 1) < 1e-4);
});

test("speed stages multiply out to the requested rate", () => {
  for (const speed of [0.25, 0.5, 1, 2, 4]) {
    const product = speedStages(speed).reduce((n, s) => n * Number(s.slice(7)), 1);
    assert.ok(Math.abs(product - speed) < 1e-3, `${speed} did not multiply out`);
  }
});

/* ── Volume envelope ────────────────────────────────────────────── */

test("an envelope sums to one segment at a time", () => {
  const expr = envelopeExpression([{ tMs: 0, v: 0 }, { tMs: 1000, v: 1 }]);
  assert.ok(expr.startsWith("volume=volume='") && expr.endsWith(":eval=frame"));
  assert.ok(expr.includes("gte(t,0.0000)*lt(t,1.0000)"), "the segment gate is what keeps terms disjoint");
  assert.ok(!expr.includes("if("), "nesting is what this formulation exists to avoid");
});

test("two points on the same instant do not divide by zero", () => {
  const expr = envelopeExpression([{ tMs: 500, v: 1 }, { tMs: 500, v: 0 }, { tMs: 900, v: 1 }]);
  assert.ok(!/\/0\.0000/.test(expr));
  assert.ok(!expr.includes("Infinity") && !expr.includes("NaN"));
});

/* ── The filtergraph ────────────────────────────────────────────── */

test("a plain clip trims, resets its clock and delays onto the timeline", () => {
  const chain = filterFor(clip({ startTimeMs: 2500, durationMs: 4000 }));
  assert.ok(chain.includes("atrim=0:4.000"));
  assert.ok(chain.includes("asetpts=PTS-STARTPTS"));
  assert.ok(chain.includes("adelay=2500:all=1"));
});

test("the seek is on the input side, so ffmpeg seeks instead of decoding", () => {
  const args = mixArgsFor([clip({ sourceStartMs: 8000 })], "/tmp/o.m4a");
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "-ss after -i decodes and discards");
  assert.equal(args[args.indexOf("-ss") + 1], "8.000");
});

test("a speed change lengthens what is taken from the source", () => {
  assert.ok(filterFor(clip({ durationMs: 2000, speed: 2 })).includes("atrim=0:4.000"));
});

test("reverse is bounded before it buffers", () => {
  const chain = filterFor(clip({ reversed: true, speed: 2 }));
  const at = chain.indexOf("atrim="), rev = chain.indexOf("areverse"), tempo = chain.indexOf("atempo=");
  assert.ok(at < rev, "areverse buffers its whole input, so it must be trimmed first");
  assert.ok(rev < tempo);
});

test("the out-fade is placed on timeline duration, not source duration", () => {
  const chain = filterFor(clip({ durationMs: 4000, speed: 2, fadeOutMs: 500 }));
  assert.ok(chain.includes("afade=t=out:st=3.500:d=0.500"), "3.5s is 4000-500 on the sequence");
});

test("an envelope replaces the static volume instead of compounding it", () => {
  const chain = filterFor(clip({ volume: 0.5, volumeEnvelope: [{ tMs: 0, v: 0.5 }, { tMs: 900, v: 0.5 }] }));
  assert.ok(chain.includes("eval=frame"));
  assert.ok(!/,volume=0\.500/.test(chain), "applying both would square the fader");
});

test("unity gain emits nothing at all", () => {
  assert.ok(!filterFor(clip({ volume: 1 })).includes("volume="));
});

test("pitch runs before the voice effect, so the two stack", () => {
  const chain = filterFor(clip({ pitch: 3, voiceEffect: "telephone" }));
  assert.ok(chain.indexOf("asetrate=") < chain.indexOf("highpass=f=400"));
});

test("a remote source is given a browser user agent", () => {
  const args = mixArgsFor([clip({ mediaUrl: "https://cdn.example/music.mp3" })], "/tmp/o.m4a");
  assert.ok(args.includes("-user_agent"));
  assert.ok(args[args.indexOf("-user_agent") + 1].includes("Chrome/"));
});

test("a local source is not", () => {
  assert.ok(!mixArgsFor([clip()], "/tmp/o.m4a").includes("-user_agent"));
});

test("a single clip is not divided down by the mixer", () => {
  const graph = mixArgsFor([clip()], "/tmp/o.m4a").join(" ");
  assert.ok(graph.includes("normalize=0"), "amix otherwise divides by the input count");
});

test("ducking builds a sidechain and splits the key bus", () => {
  const args = mixArgsFor([clip({ ducking: true }), clip({ mediaUrl: "/takes/v.mp4" })], "/tmp/o.m4a");
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.ok(graph.includes("sidechaincompress="));
  assert.ok(graph.includes("[kbus]asplit=2[kmix][kside]"), "a filter output cannot feed two consumers");
  assert.ok(graph.trim().endsWith("[out]"));
});

test("ducking with nothing to duck against stays a flat mix", () => {
  const graph = mixArgsFor([clip({ ducking: true }), clip({ ducking: true })], "/tmp/o.m4a")
    .join(" ");
  assert.ok(!graph.includes("sidechaincompress="));
});

test("every clip is normalised to one sample format before the mix", () => {
  const graph = mixArgsFor([clip(), clip({ mediaUrl: "/b.wav" })], "/tmp/o.m4a").join(" ");
  assert.equal((graph.match(/aformat=sample_fmts=fltp:sample_rates=48000/g) || []).length, 2);
});

/* ── The bridge ─────────────────────────────────────────────────── */

const exportSource = electron("videoExport.cjs");
const preloadSource = electron("preload.cjs");
const mainSource = electron("main.cjs");

const CHANNELS = ["export:start", "export:frame", "export:finish", "export:cancel"];

test("every export channel is handled, exposed and invoked under one name", () => {
  for (const channel of CHANNELS) {
    assert.ok(exportSource.includes(`ipcMain.handle("${channel}"`), `${channel} has no handler`);
    assert.ok(preloadSource.includes(`ipcRenderer.invoke("${channel}"`), `${channel} is not on the bridge`);
  }
});

test("main requires the exporter and actually calls its init", () => {
  assert.ok(mainSource.includes('require("./videoExport.cjs")'));
  assert.ok(/\binitVideoExport\(\)/.test(mainSource), "a module nothing initialises ships dead");
});

test("main kills live exports on quit", () => {
  assert.ok(/\bshutdownVideoExport\(\)/.test(mainSource), "ffmpeg would outlive the app");
});

test("the bridge exposes the exporter under `exporter`", () => {
  assert.ok(/\n  exporter: \{/.test(preloadSource));
});

test("nothing muxes with -shortest", () => {
  // Quoted, so the comment explaining why it is never used does not match.
  assert.ok(!exportSource.includes('"-shortest"'),
    "a short music bed once truncated a 16s sequence to 5.5s");
});

test("a renderer-named extension cannot escape the session directory", () => {
  /* `materialiseSource` takes an extension the RENDERER chose, from a MIME
     type it read, and builds a path in the main process out of it. An
     extension of "../../../.zshrc" would be a path traversal with a file
     write behind it. */
  assert.match(exportSource, /replace\(\/\[\^a-z0-9\]\/gi, ""\)/);
  assert.match(exportSource, /path\.join\(session\.workDir, `source-/);
});

test("staged sources live and die with the session", () => {
  // They go in `workDir`, which finish and cancel both delete: no second
  // lifetime to get wrong, and nothing survives an export that failed.
  assert.ok(/materialiseSource[\s\S]*?session\.workDir/.test(exportSource));
});

test("the OS owns the overwrite question", () => {
  assert.match(exportSource, /dialog\.showSaveDialog/);
});

test("the frame count is taken before the write can fail", () => {
  const body = exportSource.slice(exportSource.indexOf("function writeFrame"));
  assert.ok(body.indexOf("framesWritten +=") < body.indexOf("stdin.write"),
    "under-counting frames truncates the finished file and its audio");
});

/*
  Background throttling, measured rather than reasoned about: a 1664x1080
  `canvas.toBlob` took 12ms with the window in front and 1023ms behind it,
  because Chromium clamps a background page to about one task per second and
  the encoded frame comes back through one of those tasks. 741 frames is the
  difference between a 100-second export and a 23-minute one, so these assert
  the lock is taken, released on BOTH endings, and taken against the window
  that actually asked.
*/

test("an export lifts background throttling for its duration", () => {
  assert.match(exportSource, /setBackgroundThrottling\(false\)/);
  assert.match(exportSource, /setBackgroundThrottling\(true\)/);
});

test("the render lock is released by finish and by cancel alike", () => {
  const finish = exportSource.slice(exportSource.indexOf("async function finishExport"));
  const cancel = exportSource.slice(exportSource.indexOf("function cancelExport"));
  assert.ok(finish.slice(0, finish.indexOf("session.proc.stdin.end")).includes("releaseRenderLock()"),
    "a finished export that never restores throttling leaves the app unthrottled for the session");
  assert.ok(cancel.slice(0, cancel.indexOf("fs.rmSync")).includes("releaseRenderLock()"),
    "a cancelled export leaks the lock exactly like a finished one would");
});

test("the render lock is refcounted, so one export cannot unthrottle another's window", () => {
  const release = exportSource.slice(exportSource.indexOf("function releaseRenderLock"));
  assert.ok(/sessions\.size > 0\) return/.test(release.slice(0, release.indexOf("}"))),
    "the first of two concurrent exports to finish would otherwise re-throttle the second");
});

test("the lock is taken against the webContents that asked, not a global window", () => {
  assert.match(exportSource, /ipcMain\.handle\("export:start", \(event, options\) =>[\s\S]{0,60}event\.sender\)/);
  assert.match(exportSource, /acquireRenderLock\(sender\)/);
});
