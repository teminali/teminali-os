/*
  Video export: the timeline's frames, encoded to a file.

  The renderer draws each frame to an off-DOM canvas and hands it over as one
  complete JPEG; this module keeps an ffmpeg alive with `image2pipe` on its
  stdin and feeds them in. Audio never goes down that pipe — it is mixed in a
  second ffmpeg pass from the source files directly, because re-encoding audio
  that already exists on disk through a canvas would be lossy for no reason.

  Split in two because the two halves fail differently: a dropped frame is a
  visible glitch the operator must be told about, while a missing audio source
  is a silent track. `finishExport` reports both, separately.

  Ported from teminaliCut, with the render farm and the WebCodecs elementary
  stream path deliberately left behind — teminaliCut's own worker count is
  hard-coded to 1, so serial was already its default, and the stream-copy path
  silently dropped samples when B-frames made the DTS non-monotonic.
*/

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { app, dialog, ipcMain, powerSaveBlocker } = require("electron");

const { findFfmpeg, ffmpegInstallHint } = require("./mediaAccess.cjs");
const { chooseEncoder } = require("./encoderProbe.cjs");
const { encoderArgs, mixArgsFor } = require("./exportFilters.cjs");

function getVideosPath() {
  try {
    return app.getPath("videos");
  } catch {
    try {
      return app.getPath("documents");
    } catch {
      return os.tmpdir();
    }
  }
}

function getTempPath() {
  try {
    return app.getPath("temp");
  } catch {
    return os.tmpdir();
  }
}

/* ── Sessions ───────────────────────────────────────────────────── */

const sessions = new Map();
let counter = 0;
let activePowerBlockerId = null;

/*
  The display may sleep during an export — nothing is watching it — but the
  app suspending mid-encode leaves a half-written file and a stalled pipe, so
  only suspension is blocked. Refcounted on `sessions.size` rather than a
  boolean so two concurrent exports cannot have the first one to finish
  release the lock out from under the second.
*/
function acquirePowerLock() {
  if (activePowerBlockerId !== null) return;
  try { activePowerBlockerId = powerSaveBlocker.start("prevent-app-suspension"); }
  catch { activePowerBlockerId = null; }
}

function releasePowerLock() {
  if (activePowerBlockerId === null || sessions.size > 0) return;
  try { powerSaveBlocker.stop(activePowerBlockerId); } catch { /* already gone */ }
  activePowerBlockerId = null;
}

/*
  The other thing an occluded window loses, and the expensive one.

  Chromium clamps a background page's timers to roughly one task per second,
  and `canvas.toBlob` delivers its encoded frame through one of those tasks.
  Measured on a 1664x1080 frame: 12ms with the window in front, 1023ms behind
  it — the render itself is unchanged, the callback is simply held. That turns
  a 25-second take from a 30-second export into a 23-minute one, and it is the
  ordinary case rather than the edge one, because the dialog tells the operator
  that hiding it leaves the export running.

  So throttling is lifted for the duration of the export and put back after,
  rather than disabled at window creation: an IDE that idles all afternoon
  should still be throttled when it is behind something. Refcounted on
  `sessions.size` like the power lock above, and every webContents that asked
  is restored, because two windows could each be exporting.
*/
const throttledContents = new Set();

function acquireRenderLock(contents) {
  if (!contents || contents.isDestroyed()) return;
  try { contents.setBackgroundThrottling(false); } catch { return; }
  throttledContents.add(contents);
}

function releaseRenderLock() {
  if (sessions.size > 0) return;
  for (const contents of throttledContents) {
    if (contents.isDestroyed()) continue;
    try { contents.setBackgroundThrottling(true); } catch { /* window went away */ }
  }
  throttledContents.clear();
}

function startExport(options, sender) {
  const ff = findFfmpeg();
  if (!ff) return { error: `ffmpeg was not found. ${ffmpegInstallHint()}` };

  /*
    A bare filename is not an error — it is what a renderer that never asked
    for a folder produces — so it lands in the user's Videos folder rather
    than the process working directory, which for a packaged app is `/`.
  */
  const opts = { ...options };
  if (!path.isAbsolute(opts.outputPath || "")) {
    opts.outputPath = path.join(
      getVideosPath(),
      path.basename(opts.outputPath || "") || "Teminali_Export.mp4",
    );
  }

  /*
    Which encoder, decided against what this ffmpeg actually has rather than
    assumed. ProRes is the one codec that does not ask: `prores_ks` is in every
    build, LGPL or not, and `encoderArgs` ignores the name for it.
  */
  const rendererEncoded = opts.frameFormat === "h264" || opts.frameFormat === "hevc";
  const encoder = rendererEncoded
    ? null
    : opts.codec === "prores"
      ? "prores_ks"
      : chooseEncoder(opts.codec === "hevc" ? "hevc" : "h264", ff, { allowHardware: opts.hardware });
  if (!encoder && !rendererEncoded) {
    return { error: "This ffmpeg build has no usable video encoder. Reinstall Teminali OS, or set FFMPEG_PATH to a full ffmpeg." };
  }

  const id = `exp_${Date.now().toString(36)}_${++counter}`;
  const workDir = fs.mkdtempSync(path.join(getTempPath(), "teminali-export-"));
  const videoPath = path.join(workDir, opts.codec === "prores" ? "video.mov" : "video.mp4");

  const speedFlags = opts.superSpeed
    ? ["-probesize", "32", "-analyzeduration", "0", "-threads", "0"]
    : [];

  /*
    Two input shapes, decided by the renderer.

    `jpeg` is the original: one complete JPEG per frame, which ffmpeg decodes
    and re-encodes. `h264`/`hevc` mean the renderer already encoded through
    WebCodecs and this is an Annex-B elementary stream — ffmpeg copies it and
    never touches a pixel, which is the whole of tier 2.

    Two things here are measured, not reasoned, and both were wrong first.

    **`-r` goes BEFORE `-i`.** An Annex-B stream carries no timestamps, so the
    frame rate is an INPUT property. Written as `-f h264 -framerate N -i` the
    flag does not take, the demuxer falls back to its own default, and 600
    frames land in the container as 1.74 seconds instead of 20 — a file that
    plays 11x too fast while `nb_frames` reads correct.

    **The colour tags are NOT forced.** A canvas is full-range sRGB, so forcing
    `-color_range pc` looks right; measured, the encoder emits limited range
    and tags the VUI `tv`/bt709 itself, and `-c:v copy` preserves that. Forcing
    `pc` makes the container contradict the bitstream, and a player — which
    reads the tag — renders it washed out. SSIM CANNOT SEE THIS: it compares
    decoded YUV, and scored an identical 0.994977 either way. That is how this
    shipped once before. Let the bitstream speak; assert it with ffprobe, not
    with a quality metric.
  */
  const preEncoded = opts.frameFormat === "h264" || opts.frameFormat === "hevc";
  const args = preEncoded
    ? [
        "-y", ...speedFlags,
        "-r", String(opts.fps), "-f", opts.frameFormat, "-i", "pipe:0",
        "-c:v", "copy",
        ...(opts.frameFormat === "hevc" ? ["-tag:v", "hvc1"] : []),
        videoPath,
      ]
    : [
        "-y", ...speedFlags, "-f", "image2pipe", "-framerate", String(opts.fps), "-i", "pipe:0",
        ...encoderArgs(opts, encoder),
        "-r", String(opts.fps), videoPath,
      ];

  const proc = spawn(ff, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });

  const session = {
    id, proc, workDir, videoPath, outputPath: opts.outputPath, options: opts,
    framesWritten: 0, materialised: 0, stderr: "", failed: null, closed: null,
  };

  /*
    Only the tail is kept. ffmpeg writes a line per frame at some verbosity
    levels and a 40-minute export would otherwise hold a hundred megabytes of
    progress chatter in memory to report a failure that happened at the end.
  */
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => { session.stderr = (session.stderr + chunk).slice(-4000); });

  // EPIPE, when ffmpeg has already died and the renderer is still writing.
  proc.stdin.on("error", (error) => { session.failed = session.failed || error; });
  proc.on("error", (error) => { session.failed = session.failed || error; });

  session.closed = new Promise((resolve) => {
    proc.on("close", (code) => {
      if (code !== 0 && !session.failed) {
        session.failed = new Error(session.stderr.trim().slice(-800) || `ffmpeg exited ${code}`);
      }
      resolve();
    });
  });

  sessions.set(id, session);
  acquirePowerLock();
  acquireRenderLock(sender);
  return { sessionId: id };
}

/**
 * One frame, one complete JPEG.
 *
 * `image2pipe` finds frame boundaries by scanning for JPEG markers, so a
 * partial write is not a short frame — it is a corrupt stream from that point
 * on. The renderer therefore sends whole encoded images and this never
 * concatenates.
 *
 * An Annex-B stream (tier 2) has the same property for the opposite reason:
 * start codes delimit NAL units, so concatenating whole access units is
 * exactly right and this function does not need to know which it is holding.
 */
function writeFrame(sessionId, jpeg, frames = 1) {
  const session = sessions.get(sessionId);
  if (!session) return Promise.resolve({ ok: false, error: "That export is no longer running." });
  if (session.failed) return Promise.resolve({ ok: false, error: String(session.failed.message || session.failed) });

  /*
    Counted BEFORE the write resolves, and kept even if the write later
    errors. This number becomes the mux's `-t`; under-counting it truncates
    the finished file and cuts the audio with it, which is a worse failure
    than a frame that did not make it — that one at least looks like a glitch.
  */
  session.framesWritten += frames;

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };

    const ok = session.proc.stdin.write(Buffer.from(jpeg), (error) => {
      if (error) done({ ok: false, error: String(error.message || error) });
    });

    // Only wait when the pipe is actually full; every other frame goes straight through.
    if (ok) done({ ok: true });
    else session.proc.stdin.once("drain", () => done({ ok: true }));
  });
}

/* ── The audio mix ──────────────────────────────────────────────── */

/*
  A source is probed before it is mixed, because ffmpeg's filtergraph fails as
  a whole: one unreadable URL among twenty clips produces no audio file at
  all, and the export then ships silent with nothing to say about why. Probing
  first turns that into a per-clip report the operator can act on.
*/
function probeSource(ff, source) {
  return new Promise((resolve) => {
    execFile(
      ff, ["-nostdin", "-v", "error", "-i", source, "-map", "0:a:0", "-t", "0.01", "-f", "null", "-"],
      { timeout: 30_000, maxBuffer: 512 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        const text = String(stderr || "").trim();
        if (!error && !text) return resolve({ ok: true, hasAudio: true });

        // An image or a silent screen capture. Not a fault — just nothing to mix.
        if (/matches no streams|Stream map '' matches no streams|does not contain any stream/i.test(text)) {
          return resolve({ ok: true, hasAudio: false });
        }

        if (error || /Error opening input|Invalid data|No such file|Protocol not found|Server returned/i.test(text)) {
          const line = text.split("\n").find((l) => /Error|Invalid|No such|Server/i.test(l));
          return resolve({ ok: false, error: (line || "unreadable").trim() });
        }

        resolve({ ok: true, hasAudio: false });
      },
    );
  });
}

async function buildAudioMix(clips, outPath) {
  const ff = findFfmpeg();
  if (!ff) return { path: null, included: 0, dropped: [], error: `ffmpeg was not found. ${ffmpegInstallHint()}` };

  // A silent timeline is a legitimate export, not a failure to report.
  if (!Array.isArray(clips) || clips.length === 0) return { path: null, included: 0, dropped: [] };

  const probes = await Promise.all(clips.map((c) => probeSource(ff, c.mediaUrl)));

  const usable = [];
  const dropped = [];
  clips.forEach((clip, i) => {
    const probe = probes[i];
    if (probe.ok && probe.hasAudio) usable.push(clip);
    else if (!probe.ok) dropped.push({ source: clip.mediaUrl, reason: probe.error });
    // readable but silent: excluded without comment, there is nothing wrong with it
  });

  if (usable.length === 0) return { path: null, included: 0, dropped };

  // `usable`, not `clips` — the filter input indices number the filtered array.
  const args = mixArgsFor(usable, outPath);
  const wrote = await new Promise((resolve) => {
    execFile(ff, args, { timeout: 900_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error) => {
      resolve(!error && fs.existsSync(outPath));
    });
  });

  if (!wrote) {
    return { path: null, included: 0, dropped, error: "The audio mix failed during FFmpeg filtergraph rendering." };
  }
  return { path: outPath, included: usable.length, dropped };
}

/* ── Finishing ──────────────────────────────────────────────────── */

async function finishExport(sessionId, audioClips) {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: "That export is no longer running." };

  const cleanup = () => {
    sessions.delete(sessionId);
    releasePowerLock();
    releaseRenderLock();
    try { fs.rmSync(session.workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  session.proc.stdin.end();
  await session.closed;

  if (session.failed) {
    const error = String(session.failed.message || session.failed);
    cleanup();
    return { ok: false, error };
  }

  /*
    A file under a kilobyte is a container header and nothing else — ffmpeg
    can exit 0 having written one when every frame it was given was rejected.
  */
  const stat = fs.existsSync(session.videoPath) ? fs.statSync(session.videoPath) : null;
  if (!stat || stat.size < 1024) {
    const stderr = session.stderr.trim().slice(-400);
    cleanup();
    return { ok: false, error: `Encoding produced no video. ${stderr}` };
  }

  const expectedSeconds = session.framesWritten / session.options.fps;
  const mix = await buildAudioMix(audioClips, path.join(session.workDir, "audio.m4a"));
  const report = {
    requested: Array.isArray(audioClips) ? audioClips.length : 0,
    included: mix.included,
    dropped: mix.dropped,
    ...(mix.error ? { note: mix.error } : {}),
  };

  fs.mkdirSync(path.dirname(session.outputPath), { recursive: true });

  const deliverSilent = (note) => {
    fs.copyFileSync(session.videoPath, session.outputPath);
    const bytes = fs.statSync(session.outputPath).size;
    cleanup();
    return {
      ok: true, outputPath: session.outputPath, frames: session.framesWritten,
      hasAudio: false, bytes, audio: note ? { ...report, note } : report,
    };
  };

  if (!mix.path) return deliverSilent();

  /*
    Stream copy both — the video is already encoded and the audio was just
    written by us, so the mux is a container operation.

    `-t` is capped at the VIDEO's own duration and `-shortest` is never used:
    a music bed shorter than the sequence once truncated a 16-second export to
    5.5 seconds, silently, because `-shortest` cuts to the shortest INPUT.
  */
  const muxed = await new Promise((resolve) => {
    execFile(
      findFfmpeg(),
      ["-y", "-i", session.videoPath, "-i", mix.path, "-c", "copy",
        "-map", "0:v:0", "-map", "1:a:0", "-t", expectedSeconds.toFixed(6), session.outputPath],
      { timeout: 600_000, windowsHide: true },
      (error) => resolve(!error && fs.existsSync(session.outputPath)),
    );
  });

  if (!muxed) return deliverSilent("The audio mixed but could not be muxed into the container.");

  const bytes = fs.statSync(session.outputPath).size;
  cleanup();
  return {
    ok: true, outputPath: session.outputPath, frames: session.framesWritten,
    hasAudio: true, bytes, audio: report,
  };
}

/*
  Cancel does not wait for `closed`. The operator has already decided the file
  is not wanted, and a SIGKILLed ffmpeg leaves only the temp directory this
  removes — waiting for a graceful close would hold the UI on a spinner for a
  file about to be deleted.
*/
/**
 * Name the file before the render starts.
 *
 * A bare name lands in the Videos folder, which is a reasonable default and a
 * poor only option: the operator who exports three versions of a cut wants to
 * say where each went. `showSaveDialog` also owns the overwrite confirmation,
 * so nothing here has to ask a question the OS asks better.
 */
async function chooseExportPath(suggestedName, codec) {
  const extension = codec === "prores" ? "mov" : "mp4";
  const result = await dialog.showSaveDialog({
    title: "Export Video",
    defaultPath: path.join(getVideosPath(), suggestedName || `Teminali_Export.${extension}`),
    filters: [{ name: codec === "prores" ? "QuickTime Movie" : "MPEG-4 Video", extensions: [extension] }],
    properties: ["createDirectory"],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  return { ok: true, path: result.filePath };
}

/**
 * Write bytes the renderer holds and the filesystem does not.
 *
 * A take assembled from a live recording is `blob:` URLs — bytes in the
 * renderer's memory with no path behind them — and ffmpeg cannot open one.
 * Rejecting them instead would refuse the exporter's most ordinary input,
 * because a recording opened straight on the timeline is the common case.
 *
 * The copies go in the session's own working directory, so `finishExport`
 * and `cancelExport` already delete them: there is no second lifetime to get
 * wrong, and nothing survives an export that failed.
 */
function materialiseSource(sessionId, bytes, extension) {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: "That export is no longer running." };
  if (!bytes || typeof bytes.byteLength !== "number" || bytes.byteLength === 0) {
    return { ok: false, error: "That source arrived empty." };
  }

  /*
    The renderer names the extension from a MIME type it read, so it is not
    hostile — but it is renderer input naming a path in the main process, and
    an extension of `../../../.zshrc` would be a path traversal with a file
    write behind it. Only the characters an extension can contain survive.
  */
  const safe = String(extension || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
  session.materialised += 1;
  const file = path.join(session.workDir, `source-${session.materialised}.${safe}`);

  try {
    fs.writeFileSync(file, Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength));
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, error: `Could not stage a source for the mix. ${error.message}` };
  }
}

function cancelExport(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return; // idempotent: a second cancel, or one racing `finish`

  try { session.proc.stdin.end(); } catch { /* pipe already gone */ }
  try { session.proc.kill("SIGKILL"); } catch { /* already dead */ }
  sessions.delete(sessionId);
  releasePowerLock();
  releaseRenderLock();
  try { fs.rmSync(session.workDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/* ── IPC ────────────────────────────────────────────────────────── */

function initVideoExport() {
  ipcMain.handle("export:start", (event, options) => startExport(options || {}, event.sender));
  ipcMain.handle("export:frame", (_event, sessionId, jpeg, frames) => writeFrame(sessionId, jpeg, frames));
  ipcMain.handle("export:finish", (_event, sessionId, audioClips) => finishExport(sessionId, audioClips));
  ipcMain.handle("export:choose", (_event, suggestedName, codec) => chooseExportPath(suggestedName, codec));
  ipcMain.handle("export:material", (_event, sessionId, bytes, extension) => materialiseSource(sessionId, bytes, extension));
  ipcMain.handle("export:cancel", (_event, sessionId) => { cancelExport(sessionId); });
}

/*
  Every live export is killed on quit. Without this the ffmpeg children
  outlive the app and keep writing into a temp directory nothing will ever
  clean up, one per abandoned export.
*/
function shutdownVideoExport() {
  for (const id of [...sessions.keys()]) cancelExport(id);
}

module.exports = {
  buildAudioMix, probeSource,
  startExport, writeFrame, finishExport, cancelExport, materialiseSource, chooseExportPath,
  initVideoExport, shutdownVideoExport, sessions,
};
