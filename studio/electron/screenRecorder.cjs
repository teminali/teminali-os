/* ═══════════════════════════════════════════════════════════════════
   Screen recording — the half that only the main process can do.

   Four things live here because a renderer cannot reach any of them:

     1. `desktopCapturer.getSources` enumerates displays and windows.
        The renderer is handed ids and thumbnails and turns one into a
        MediaStream itself; it can never ask for a source that was not
        offered here.

     2. **Chunks go to disk as they arrive.** A MediaRecorder blob held
        in renderer memory for a twenty-minute take is a gigabyte of
        heap that gets copied again the moment anyone reads it. Each
        stream owns an append-only file and each `ondataavailable`
        becomes one `write`, so memory stays flat however long the
        recording runs.

     3. **The cursor track.** `screen.getCursorScreenPoint()` is the
        only cursor position available anywhere in Electron, and it is
        main-only. Sampled at 30Hz against the captured display's
        bounds, it is what an auto-zoom is built from.

        Say plainly what this is NOT: it is not a click stream. Nothing
        in Electron reports a mouse button pressed in another
        application. `inputEvents.cjs` can see real clicks when its
        optional native binding is installed; without it the recorder
        infers moments of ATTENTION from the track — travel, then
        stillness — and the operator can mark one by hand with a global
        shortcut. Both are real. Neither is called a click anywhere the
        operator can read it.

     4. The floating control bar, which is its own window because the
        main window is hidden while a take is running — and which is
        marked `setContentProtection(true)` so it does not appear in the
        recording it is controlling.

   Files land in the operator's Videos folder, not in a temp directory.
   A recording is the most expensive thing this app produces; losing one
   to a reboot because it was written to /tmp would be indefensible.
   ═══════════════════════════════════════════════════════════════════ */

const {
  app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain,
  screen, shell, systemPreferences,
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { execFile, spawn } = require("child_process");

const { findFfmpeg, ffmpegInstallHint } = require("./mediaAccess.cjs");
const { writeSealed, readMaybeSealed, makePrivateDir } = require("./recorderVault.cjs");
const { canStreamCopy, videoCodecFromFfmpeg } = require("./remuxPlan.cjs");
const { readProgress, aggregatePercent } = require("./convertProgress.cjs");
const {
  startInputCapture, probeInputCapture, shutdownInputCapture,
} = require("./inputEvents.cjs");
const { createLiveStream, testLiveConnection } = require("./liveStreamer.cjs");

/* ── Shapes shared with the renderer ─────────────────────────────────

   @typedef {'screen'|'camera'} StreamName

   @typedef {object} CursorSample
   @property {number} tMs  Milliseconds into the RECORDING, paused time removed.
   @property {number} x    Normalised against the captured display's bounds.
   @property {number} y

   `x` and `y` are deliberately NOT clamped: a value outside 0..1 means
   the pointer was on another display and is not in frame, and an
   analyser needs to tell that from "parked against the left edge".

   @typedef {object} OutStream
   @property {StreamName} name
   @property {string} filePath
   @property {fs.WriteStream} handle
   @property {number} bytes        Bytes handed to the stream, not bytes on disk.
   @property {boolean} closed
   @property {string|null} writeError

   `writeError` is the first write that failed, if one did. An
   `fs.WriteStream` with no `error` listener does not fail quietly: Node
   re-raises the event as an uncaught exception, which on a disk that
   filled up or a volume ejected mid-take would take the whole main
   process down — window, bar, recording and all. A take that cannot be
   written is a warning on the take, so it is caught, kept, and reported
   by `recorder:finish`.                                              */

/** @type {Map<string, any>} */
const sessions = new Map();

/** 30Hz. A zoom target needs the pointer's resting place, not its path. */
const CURSOR_HZ = 30;

let getMainWindow = () => null;
let barWindow = null;

/* ── Where recordings go ────────────────────────────────────────── */

function stamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

/**
 * `app.getPath('videos')` throws on a Linux box with no XDG user-dirs
 * configured, which is a normal server-ish install rather than an exotic
 * one. Fall back rather than fail the whole feature.
 */
function recordingsRoot() {
  for (const name of ["videos", "documents"]) {
    try {
      return path.join(app.getPath(name), "Teminali OS Recordings");
    } catch {
      /* try the next one */
    }
  }
  return path.join(os.tmpdir(), "teminali-os-recordings");
}

/* ── The cursor track ───────────────────────────────────────────── */

function startSampling(session) {
  if (!session.bounds) return;
  const bounds = session.bounds;

  session.sampler = setInterval(() => {
    if (session.paused) return;
    const point = screen.getCursorScreenPoint();
    session.cursor.push({
      tMs: Date.now() - session.startedAtMs - session.pausedTotalMs,
      x: (point.x - bounds.x) / bounds.width,
      y: (point.y - bounds.y) / bounds.height,
    });
  }, Math.round(1000 / CURSOR_HZ));
}

function elapsedMs(session) {
  const paused = session.paused ? Date.now() - session.pausedAtMs : 0;
  return Date.now() - session.startedAtMs - session.pausedTotalMs - paused;
}

/* ── Global shortcuts ───────────────────────────────────────────── */

/*
  Alt+Shift, because the bar is the real control and these are the
  fallback for a full-screen app that covers it. A combination somebody
  presses in another application by accident would be worse than not
  having them at all: globalShortcut takes the key away from every app
  on the machine for as long as a recording runs.
*/
const SHORTCUTS = [
  ["Alt+Shift+R", "stop"],
  ["Alt+Shift+P", "pause"],
  ["Alt+Shift+Z", "mark"],
];

function registerShortcuts(sessionId) {
  const registered = [];
  for (const [accelerator, action] of SHORTCUTS) {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (action === "mark") {
          const session = sessions.get(sessionId);
          if (session) session.marks.push(elapsedMs(session));
        }
        /*
          To the main window only, never to the bar.

          The bar loads from the same bundle, so the recorder store is in
          its module graph and subscribed to this channel too — and a
          second store reacting to `stop` in a window that holds no
          MediaRecorders is a way for one keypress to mean two things.
          The bar learns what happened from the next `recorder:state`
          push, which is at most 200ms behind.
        */
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("recorder:command", { action, source: "shortcut" });
        }
      });
      if (ok) registered.push(accelerator);
    } catch {
      /* Another app owns it. Not fatal: the bar still works. */
    }
  }
  return registered;
}

function releaseShortcuts() {
  for (const [accelerator] of SHORTCUTS) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      /* nothing held it */
    }
  }
}

/* ── The floating control bar ───────────────────────────────────── */

const BAR_W = 300;
const BAR_H = 54;

function openBar(bounds) {
  if (barWindow && !barWindow.isDestroyed()) return;

  const area = bounds ?? screen.getPrimaryDisplay().workArea;
  barWindow = new BrowserWindow({
    width: BAR_W,
    height: BAR_H,
    x: Math.round(area.x + (area.width - BAR_W) / 2),
    y: Math.round(area.y + area.height - BAR_H - 34),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' is the level that stays above a full-screen window.
  barWindow.setAlwaysOnTop(true, "screen-saver");
  barWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  /*
    The whole reason this is a separate window rather than an overlay in
    the app: it must not be IN the recording. Content protection is what
    keeps it out — NSWindowSharingNone on macOS, WDA_EXCLUDEFROMCAPTURE
    on Windows 10 2004 and later. It is a no-op on Linux, where the bar
    will appear in a full-screen capture; the renderer says so.
  */
  try {
    barWindow.setContentProtection(true);
  } catch {
    /* unsupported on some Windows VM / legacy builds */
  }

  barWindow.once("ready-to-show", () => {
    if (barWindow && !barWindow.isDestroyed()) barWindow.showInactive();
  });

  // Same load rule as the main window (`main.cjs`), so the bar and the
  // app are never served from two different builds.
  const useDevServer = !app.isPackaged && process.env.ELECTRON_DIST !== "1";
  if (useDevServer) {
    barWindow.loadURL("http://localhost:3000/?window=recorder-bar").catch(() => {});
  } else {
    barWindow
      .loadFile(path.join(__dirname, "../dist/index.html"), { query: { window: "recorder-bar" } })
      .catch(() => {});
  }

  barWindow.on("closed", () => { barWindow = null; });
}

function closeBar() {
  if (barWindow && !barWindow.isDestroyed()) barWindow.destroy();
  barWindow = null;
}

/**
 * The bar window, for a debug capture.
 *
 * It exists because the bar CANNOT be screenshotted from outside the
 * app: `setContentProtection(true)` is what keeps it out of the
 * recording, and the OS honours that for every capture, including the
 * one somebody would take to check the bar looks right. `capturePage()`
 * renders from Electron's own compositor and is not affected, so this is
 * the only way to see it at all.
 */
function recorderBarWindow() {
  return barWindow && !barWindow.isDestroyed() ? barWindow : null;
}

/** True on the platforms where `setContentProtection` actually excludes. */
function barIsHiddenFromCapture() {
  return process.platform === "darwin" || process.platform === "win32";
}

/* ── Turning the take into something an editor can scrub ────────── */

function runFfmpeg(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 20 * 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, _out, stderr) => {
      resolve({ ok: !err, stderr: (stderr || "").trim() });
    });
  });
}

/**
 * The same, but watched — and the reason the convert screen can draw a bar.
 *
 * `execFile` buffers a process and hands it over once it is dead, which
 * is precisely the wrong shape for a step whose whole complaint is that
 * it says nothing while it runs. So the converting invocations spawn
 * instead, and `-progress pipe:1 -nostats` gives a machine-readable
 * position on stdout roughly twice a second.
 *
 * `onProgress` is called with the parsed samples; nothing here decides
 * what a percentage is, because that belongs to `convertProgress.cjs`
 * where it can be tested.
 *
 * The timeout is kept from the buffered version, and it has to be
 * enforced by hand: `spawn` has no `timeout` of its own that also
 * reaps the child.
 */
function runFfmpegWatched(bin, args, onProgress) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["-progress", "pipe:1", "-nostats", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let carry = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const read = readProgress(carry, chunk);
      carry = read.rest;
      for (const sample of read.samples) {
        try { onProgress(sample); } catch { /* a bar is never worth the take */ }
      }
    });

    /* Capped rather than unbounded: only the last couple of lines are
       ever read out of it, and a failing convert can be talkative. */
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, 20 * 60_000);

    const finish = (ok) => {
      clearTimeout(timer);
      resolve({ ok: ok && !timedOut, stderr: stderr.trim() });
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/**
 * The video codec a finished file actually holds, as ffmpeg names it.
 *
 * `ffmpeg -i <file>` with no output exits non-zero and prints the stream
 * table to stderr, which is exactly what is wanted here and needs no
 * second binary: ffprobe is not always installed, while ffmpeg has
 * already been resolved by the caller.
 *
 * Null when it cannot be read, which is treated as "do not copy".
 */
async function videoCodecOf(bin, input) {
  const probed = await runFfmpeg(bin, ["-hide_banner", "-i", input]);
  return videoCodecFromFfmpeg(probed.stderr);
}

/**
 * WebM out of MediaRecorder into MP4.
 *
 * This is not cosmetic. A MediaRecorder file carries NO duration in its
 * header and no cue index, so a `<video>` element reports its duration
 * as `Infinity` and seeking backwards re-decodes from zero. An editor
 * that cannot seek is not an editor, so every take goes through here
 * before it reaches the timeline.
 *
 * Stream copy first — a take recorded as H.264 needs no re-encode, and a
 * 4K twenty-minute file re-encoded is minutes of waiting for nothing. If
 * the copy is not available (VP8/VP9 cannot go into MP4) the transcode is
 * the fallback rather than the default.
 */
async function toMp4(input, tryCopy, watch) {
  const bin = findFfmpeg();
  if (!bin) {
    return {
      ok: false,
      path: input,
      raw: true,
      error:
        `FFmpeg was not found, so the take is still a .webm. Install ffmpeg (${ffmpegInstallHint()}) `
        + "and re-import the file to scrub it on the timeline.",
    };
  }

  const output = input.replace(/\.webm$/, ".mp4");
  const base = ["-y", "-nostdin", "-fflags", "+genpts", "-avoid_negative_ts", "make_zero", "-i", input];
  const tail = [
    "-c:a", "aac", "-b:a", "192k",
    "-af", "aresample=async=1:first_pts=0",
    "-movflags", "+faststart",
    output,
  ];

  /*
    `tryCopy` is the mime the renderer ASKED FOR, and that is a request,
    not a result — see `remuxPlan.cjs`. So the requested mime narrows the
    work and the FILE decides. Reading it costs one ffmpeg invocation
    that exits immediately, against a stream copy of a multi-gigabyte
    take that has to fail first otherwise.
  */
  if (tryCopy) {
    const codec = await videoCodecOf(bin, input);
    if (canStreamCopy(tryCopy, codec)) {
      const copied = await runFfmpegWatched(
        bin,
        [...base, "-c:v", "copy", ...tail],
        (sample) => watch?.({ ...sample, pass: "copy" }),
      );
      if (copied.ok && fs.existsSync(output) && fs.statSync(output).size > 0) {
        return { ok: true, path: output, raw: false };
      }
    }
  }

  const encoded = await runFfmpegWatched(
    bin,
    [
      ...base,
      "-c:v", "libx264",
      "-crf", "18",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-fps_mode", "cfr",
      ...tail,
    ],
    (sample) => watch?.({ ...sample, pass: "encode" }),
  );
  if (encoded.ok && fs.existsSync(output) && fs.statSync(output).size > 0) {
    return { ok: true, path: output, raw: false };
  }

  return {
    ok: false,
    path: input,
    raw: true,
    error: encoded.stderr.split("\n").filter(Boolean).slice(-2).join(" ")
      || "ffmpeg could not convert the take.",
  };
}

/* ── Teardown, shared by finish and cancel ──────────────────────── */

async function closeStreams(session) {
  await Promise.all(
    [...session.streams.values()].map(
      (out) =>
        new Promise((resolve) => {
          if (out.handle.destroyed || out.handle.writableEnded) {
            resolve();
            return;
          }
          out.closed = true;
          out.handle.end(() => resolve());
          setTimeout(resolve, 500);
        }),
    ),
  );
}

function teardown(session) {
  if (session.liveStream) {
    try { session.liveStream.stop(); } catch { /* ignore */ }
    session.liveStream = null;
  }
  if (session.sampler) clearInterval(session.sampler);
  session.sampler = null;
  if (session.input) session.input.stop();
  session.input = null;
  releaseShortcuts();
  closeBar();
  if (session.hidWindow) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      try { win.webContents.setBackgroundThrottling(true); } catch { /* ignore */ }
      win.show();
      win.focus();
    }
  }
}

/**
 * A `file://` URL the renderer can hand to a `<video>` element.
 * Handles Windows drive letters, spaces, UNC paths, and special characters cleanly.
 */
function fileUrl(absolute) {
  try {
    return pathToFileURL(path.resolve(absolute)).href;
  } catch {
    const normalised = absolute.replace(/\\/g, "/");
    return `file://${encodeURI(normalised.startsWith("/") ? normalised : `/${normalised}`)}`;
  }
}

/* ── IPC ────────────────────────────────────────────────────────── */

function initScreenRecorder(mainWindowGetter) {
  getMainWindow = mainWindowGetter;

  /*
    A hidden main window must never outlive the take that hid it.

    `hideWindow` hides it for the duration of a recording, and `teardown`
    shows it again on both exit paths. Neither runs if the RENDERER goes
    away mid-take: the session id lives in the renderer, so a reload, an
    HMR update or a crash means `recorder:finish` and `recorder:cancel`
    are never called, the session is orphaned, and the window stays
    hidden for the life of the process.

    What that looks like from outside is the part that costs the time.
    The floating bar is `skipTaskbar` and content-protected, so with the
    main window hidden macOS reports the app as having NO windows and
    being background-only: no Dock icon, nothing in the app switcher, and
    no way back to it. The app is running perfectly and answering its
    RPC, and it is unreachable.

    So the renderer loading is treated as proof that no take can still be
    running in it: orphaned sessions are torn down and the window comes
    back. A reload during a take has already killed the capture — the
    MediaRecorder lives in the renderer — so there is nothing left to
    protect by staying hidden.
  */
  const reconcileOnLoad = () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.on("did-finish-load", () => {
      for (const session of [...sessions.values()]) {
        teardown(session);
        void closeStreams(session);
        /*
          And forget it. Leaving the entry in the map kept a torn-down
          session reachable by id, so a `recorder:finish` arriving late
          from the old page would remux files that had just been closed
          and hand back a take built from a session with no recorders
          behind it.
        */
        sessions.delete(session.id);
      }
      const live = getMainWindow();
      if (live && !live.isDestroyed() && !live.isVisible()) { live.show(); live.focus(); }
    });
  };
  if (getMainWindow()) reconcileOnLoad();
  else app.whenReady().then(() => setTimeout(reconcileOnLoad, 0));

  ipcMain.handle("recorder:sources", async (_event, p) => {
    const width = (p && p.thumbWidth) || 480;
    let sources = [];
    try {
      sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width, height: Math.round((width * 9) / 16) },
        fetchWindowIcons: true,
      });
    } catch (err) {
      return { ok: false, error: err.message, sources: [] };
    }

    const displays = screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;

    /*
      A Mac always has at least one display. Zero of them is not a state
      the machine can be in, so it is the one RELIABLE signal that screen
      recording is denied — `getMediaAccessStatus` answers `granted` from
      a stale row and cannot be trusted for this.
    */
    const screens = sources.filter((source) => source.id.startsWith("screen:")).length;

    return {
      ok: true,
      deniedDespiteSettings: process.platform === "darwin" && screens === 0,
      sources: sources.map((source) => {
        let display = undefined;
        if (source.id.startsWith("screen:")) {
          if (source.display_id) {
            display = displays.find((d) => String(d.id) === String(source.display_id));
          }
          if (!display) {
            const parts = source.id.split(":");
            const parsedId = parts[1];
            if (parsedId) {
              display = displays.find((d) => String(d.id) === parsedId);
              if (!display && Number.isInteger(Number(parsedId))) {
                display = displays[Number(parsedId)];
              }
            }
          }
          if (!display && displays.length === 1) {
            display = displays[0];
          }
        }
        return {
          id: source.id,
          name: source.name,
          kind: source.id.startsWith("screen:") ? "screen" : "window",
          displayId: display ? display.id : null,
          /* Real pixels, not the thumbnail's. A window's are unknown
             until its stream starts, so they stay null and the renderer
             reads them off the track. */
          width: display ? Math.round(display.size.width * display.scaleFactor) : null,
          height: display ? Math.round(display.size.height * display.scaleFactor) : null,
          scaleFactor: display ? display.scaleFactor : 1,
          primary: display ? display.id === primaryId : false,
          thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
          icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
        };
      }),
    };
  });

  /*
    macOS gates all three of these behind TCC, and the failure mode is
    silent: a denied screen capture yields a black stream rather than an
    error, and a denied camera yields a stream with no frames. Asking up
    front is the difference between "nothing recorded" and a sentence
    telling the operator which switch to turn on.
  */
  ipcMain.handle("recorder:permissions", () => {
    const input = probeInputCapture();
    if (process.platform !== "darwin") {
      return {
        platform: process.platform,
        screen: "granted",
        camera: "granted",
        microphone: "granted",
        barHiddenFromCapture: barIsHiddenFromCapture(),
        input,
      };
    }
    return {
      platform: "darwin",
      screen: systemPreferences.getMediaAccessStatus("screen"),
      camera: systemPreferences.getMediaAccessStatus("camera"),
      microphone: systemPreferences.getMediaAccessStatus("microphone"),
      barHiddenFromCapture: true,
      input,
    };
  });

  /*
    ── The permission that says it is granted and is not ─────────────

    macOS builds that are ad-hoc signed with no Team ID hit this, and TCC
    binds a screen-recording grant to the binary's cdhash. Every rebuild
    is a different cdhash. So after an update the switch in System
    Settings is still on, `getMediaAccessStatus('screen')` still answers
    `granted`, and `desktopCapturer` returns ZERO displays — macOS never
    re-asks, because a row for the bundle id already exists.

    `tccutil reset` deletes this app's own row so macOS asks again on the
    next launch. It is scoped to this bundle and these services, and the
    worst it can do is make somebody tick a box they had already ticked.
    It stops being needed once these builds carry a Developer ID, at
    which point the grant keys on the team identifier and survives.
  */
  ipcMain.handle("recorder:resetScreenPermission", async () => {
    if (process.platform !== "darwin") {
      return { ok: false, message: "Only macOS keeps a grant that can go stale like this." };
    }
    const services = ["ScreenCapture", "Camera", "Microphone", "Accessibility", "ListenEvent"];
    const bundleIds = ["os.teminali.app"];
    await Promise.all(
      bundleIds.flatMap((bundleId) =>
        services.map(
          (service) =>
            new Promise((resolve) => {
              execFile("tccutil", ["reset", service, bundleId], { timeout: 10_000 }, () => resolve());
            }),
        ),
      ),
    );
    return {
      ok: true,
      message: "Cleared Teminali OS's recording permissions. They are asked for again on the next launch.",
    };
  });

  /** Quit and come back, so a fresh permission is asked for on launch. */
  ipcMain.handle("recorder:relaunch", () => {
    app.relaunch();
    app.exit(0);
    return true;
  });

  ipcMain.handle("recorder:requestPermission", async (_event, p) => {
    if (process.platform === "win32") {
      if (p.kind === "camera") {
        await shell.openExternal("ms-settings:privacy-webcam").catch(() => {});
        return { granted: false, opened: true };
      }
      if (p.kind === "microphone") {
        await shell.openExternal("ms-settings:privacy-microphone").catch(() => {});
        return { granted: false, opened: true };
      }
      return { granted: true, opened: false };
    }
    if (process.platform !== "darwin") return { granted: true, opened: false };

    /*
      Accessibility is what lets the input hook see clicks in other
      applications. `isTrustedAccessibilityClient(true)` asks macOS to
      show its own prompt, which is the only way the app appears in that
      list at all; the pane is opened as well, because the prompt is a
      one-time thing and the switch is where the actual grant happens.
    */
    if (p.kind === "accessibility") {
      systemPreferences.isTrustedAccessibilityClient(true);
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
      return { granted: false, opened: true };
    }

    /*
      There is no ask-for-screen-capture API. The only honest button is
      one that opens the exact pane the switch lives in, and macOS makes
      the operator restart the app afterwards.
    */
    if (p.kind === "screen") {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
      return { granted: false, opened: true };
    }

    const granted = await systemPreferences.askForMediaAccess(p.kind);
    return { granted, opened: false };
  });

  ipcMain.handle("recorder:begin", (_event, p) => {
    const id = `rec_${Date.now().toString(36)}`;
    const dir = path.join(recordingsRoot(), stamp(new Date()));

    try {
      /*
        0700, not 0755. A take carries a recording of somebody's screen
        and the sidecar logs the timing of every key they pressed; on a
        shared machine the default mode makes both readable by every
        other account on it. The mode on the DIRECTORY is what stops the
        listing that finds them, which matters more than the mode on any
        one file inside.
      */
      makePrivateDir(dir);
    } catch (err) {
      return { ok: false, error: `Could not create ${dir}: ${err.message}` };
    }

    const display = p.displayId === null || p.displayId === undefined
      ? null
      : screen.getAllDisplays().find((d) => d.id === p.displayId) ?? null;

    const session = {
      id,
      dir,
      startedAtMs: Date.now(),
      streams: new Map(),
      cursor: [],
      bounds: display ? display.bounds : null,
      scaleFactor: display ? display.scaleFactor : 1,
      sampler: null,
      paused: false,
      pausedTotalMs: 0,
      pausedAtMs: 0,
      marks: [],
      events: [],
      input: null,
      hidWindow: false,
    };

    for (const name of p.streams) {
      const filePath = path.join(dir, `${name}.webm`);
      const out = {
        name,
        filePath,
        handle: fs.createWriteStream(filePath),
        bytes: 0,
        closed: false,
        writeError: null,
      };
      out.handle.on("error", (err) => {
        if (!out.writeError) out.writeError = err.message;
        /* Nothing more can go to this file, and every further chunk for
           it would raise the same event again. */
        out.closed = true;
      });
      session.streams.set(name, out);
    }

    sessions.set(id, session);
    startSampling(session);

    /*
      The input hook shares the recording's clock and the display's
      bounds with the cursor sampler, deliberately: a click and the
      cursor position it is merged with have to be on the same timeline
      and in the same coordinate space, or the zoom lands next to the
      thing it was aimed at.

      Never started for a window capture. Without display bounds a click
      cannot be located in the frame at all, and a hook that reads every
      keystroke on the machine for no benefit is not a trade to make
      quietly.
    */
    session.input = session.bounds
      ? startInputCapture(
        () => elapsedMs(session),
        () => session.bounds,
        (event) => { if (!session.paused) session.events.push(event); },
      )
      : null;

    const shortcuts = registerShortcuts(id);

    let liveStream = null;
    if (p.live && p.live.enabled) {
      liveStream = createLiveStream(p.live, (status) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("recorder:liveStatus", status);
        }
      });
    }
    session.liveStream = liveStream;

    if (p.hideWindow) {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        try { win.webContents.setBackgroundThrottling(false); } catch { /* ignore */ }
        win.hide();
        session.hidWindow = true;
      }
    }
    openBar(session.bounds);

    return {
      ok: true,
      sessionId: id,
      dir,
      cursorTracked: session.bounds !== null,
      shortcuts,
      barHiddenFromCapture: barIsHiddenFromCapture(),
      input: session.input ? session.input.status : {
        ok: false,
        source: "cursor-only",
        reason: "failed",
        message: "A single window was captured, so there is no frame to place a click in.",
      },
      live: liveStream ? { active: true, service: p.live.service } : undefined,
    };
  });

  ipcMain.handle("recorder:chunk", (_event, p) => {
    const session = sessions.get(p.sessionId);
    if (!session) return { ok: false, error: "That recording session is not open." };
    const out = session.streams.get(p.stream);
    if (!out) return { ok: false, error: `No "${p.stream}" file in this session.` };
    if (out.writeError) {
      return { ok: false, error: `The ${p.stream} file stopped accepting data: ${out.writeError}` };
    }
    if (out.closed) return { ok: false, error: `The "${p.stream}" file is already closed.` };

    /*
      Wrapped, not copied. `Buffer.from(uint8Array)` allocates a second
      buffer and memcpys into it; `Buffer.from(buffer, offset, length)`
      views the bytes IPC already gave us. At the default 3s timeslice a
      screen chunk is several megabytes, so this was a multi-megabyte
      allocation and copy on the main process, twice a second across the
      two streams, for no reason — the bytes are written and dropped.

      The comment sits ABOVE the `try` rather than inside it:
      `recorder-live-stream.test.mjs` pins the write to being guarded by
      matching `try { out.handle.write`, and that pin is worth keeping.
    */
    try {
      out.handle.write(Buffer.from(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength));
      out.bytes += p.bytes.byteLength;
      return { ok: true, bytes: out.bytes };
    } catch (err) {
      out.writeError = err.message;
      out.closed = true;
      return { ok: false, error: `Failed to write chunk to ${p.stream}: ${err.message}` };
    }
  });

  ipcMain.handle("recorder:liveChunk", (_event, p) => {
    const session = sessions.get(p.sessionId);
    if (!session) return { ok: false, error: "That recording session is not open." };
    if (!session.liveStream) return { ok: false, error: "No active live stream for this session." };
    const ok = session.liveStream.write(p.bytes);
    return { ok };
  });

  ipcMain.handle("recorder:testLiveConnection", async (_event, p) => {
    return testLiveConnection(p);
  });

  ipcMain.handle("recorder:pause", (_event, p) => {
    const session = sessions.get(p.sessionId);
    if (!session) return { ok: false };
    if (p.paused && !session.paused) {
      session.paused = true;
      session.pausedAtMs = Date.now();
    } else if (!p.paused && session.paused) {
      session.pausedTotalMs += Date.now() - session.pausedAtMs;
      session.paused = false;
    }
    return { ok: true, elapsedMs: elapsedMs(session) };
  });

  /** What the floating bar shows. Pushed from the renderer that records. */
  ipcMain.handle("recorder:publishState", (_event, state) => {
    if (barWindow && !barWindow.isDestroyed()) barWindow.webContents.send("recorder:state", state);
    return true;
  });

  /** The bar has no recorder of its own; every button is a message. */
  ipcMain.handle("recorder:barCommand", (_event, p) => {
    /*
      Marks are recorded HERE rather than forwarded, so that both ways of
      making one — this button and the global shortcut — write to the
      same list with the same clock. The renderer has its own idea of
      elapsed time and it is a few milliseconds off this one; two marking
      paths disagreeing about when "now" was is exactly the kind of split
      that shows up later as a zoom landing on the wrong frame.
    */
    if (p.action === "mark") {
      for (const session of sessions.values()) session.marks.push(elapsedMs(session));
    }
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("recorder:command", { action: p.action, source: "bar" });
    }
    return true;
  });

  ipcMain.handle("recorder:finish", async (event, p) => {
    const session = sessions.get(p.sessionId);
    if (!session) return { ok: false, error: "That recording session is not open." };

    const durationMs = elapsedMs(session);
    teardown(session);
    await closeStreams(session);

    const files = {};

    /*
      A file that failed a write is still remuxed and still returned: a
      WebM truncated at the point the disk filled up usually plays up
      to that point, and half a take is worth more than none. What must
      not happen is finishing quietly, so the error rides along with it.
    */
    const wroteOf = (out) => (out.writeError
      ? `Part of the ${out.name} take could not be written to disk (${out.writeError}), `
        + "so it may end early."
      : null);

    const pending = [];
    for (const out of session.streams.values()) {
      if (out.bytes === 0) {
        files[out.name] = {
          path: out.filePath,
          url: "",
          bytes: 0,
          raw: true,
          error: wroteOf(out) ?? "Nothing was written for this source.",
        };
        continue;
      }
      pending.push(out);
    }

    /*
      One bar over however many files are converting.

      `converted` holds each stream's position rather than accumulating,
      so a copy that falls back to a re-encode simply restarts its own
      clock; `floor` is what stops the shared bar retreating when it
      does. Sent only when the drawn number changes — ffmpeg reports
      about twice a second per stream, and an IPC message that redraws
      nothing is a message not worth sending.
    */
    const converted = {};
    const ended = new Set();
    let floor = 0;
    let last = null;
    const report = (name, sample) => {
      converted[name] = sample.outTimeMs ?? 0;
      if (sample.done) ended.add(name); else ended.delete(name);

      const percent = aggregatePercent(converted, durationMs, pending.length, floor);
      if (percent !== null) floor = percent;
      const phase = ended.size === pending.length ? "finalising" : "converting";

      const line = `${percent}|${phase}|${sample.pass}`;
      if (line === last) return;
      last = line;
      if (!event.sender.isDestroyed()) {
        event.sender.send("recorder:convert", {
          percent, phase, pass: sample.pass, speed: sample.speed ?? null,
        });
      }
    };

    /*
      In parallel, because screen and camera are two independent files
      and converting them one after the other doubled the wait for no
      reason anybody watching the spinner could have guessed.
    */
    await Promise.all(pending.map(async (out) => {
      const result = await toMp4(out.filePath, p.copyable, (sample) => report(out.name, sample));
      const error = [wroteOf(out), result.error].filter(Boolean).join(" ");
      files[out.name] = {
        path: result.path,
        url: fileUrl(result.path),
        bytes: fs.existsSync(result.path) ? fs.statSync(result.path).size : out.bytes,
        raw: result.raw,
        ...(error ? { error } : {}),
      };
      /* The .webm is redundant once the .mp4 exists, and it is the same
         size again on disk. Only remove it when the conversion actually
         produced something. */
      if (!result.raw && result.path !== out.filePath) {
        try { fs.unlinkSync(out.filePath); } catch { /* keep going */ }
      }
    }));

    /*
      The sidecar is SEALED, and it is the one part of a take that is.

      It is not the video that is sensitive here. It is this: every
      cursor position at 30Hz and the timing of every keystroke of the
      session, which together are a recording of how somebody works, in a
      file that would otherwise be plain JSON in a folder that gets
      copied, backed up and shared. The video is the thing they meant to
      make; this is exhaust. `recorderVault.cjs` says why the video is
      deliberately left alone.
    */
    const cursorPath = path.join(session.dir, "cursor.json");
    try {
      writeSealed(cursorPath, "take-sidecar", JSON.stringify({
        durationMs,
        scaleFactor: session.scaleFactor,
        marks: session.marks,
        events: session.events,
        samples: session.cursor,
      }));
    } catch {
      /* The samples are returned below regardless; the file is a record. */
    }

    sessions.delete(session.id);

    return {
      ok: true,
      dir: session.dir,
      durationMs,
      files,
      cursor: session.cursor,
      events: session.events,
      marks: session.marks,
      cursorTracked: session.bounds !== null,
      scaleFactor: session.scaleFactor,
    };
  });

  ipcMain.handle("recorder:cancel", async (_event, p) => {
    const session = sessions.get(p.sessionId);
    if (!session) return { ok: false };

    teardown(session);
    await closeStreams(session);
    sessions.delete(session.id);

    if (p.discard) {
      try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch { /* leave it */ }
    }
    return { ok: true, dir: session.dir, discarded: p.discard };
  });

  /*
    Generated audio, written INTO the take rather than into a temp
    directory. A take is a folder, and everything the take needs belongs
    in it — a project reopened next month should not come back with every
    sound relinked because /tmp was cleared.

    The directory must ALREADY EXIST, and the name is reduced to a safe
    basename so nothing can climb out of it. Refusing to create
    directories is what stops a write inventing a path somewhere nobody
    looks.
  */
  ipcMain.handle("recorder:writeTakeAsset", async (_event, p) => {
    const target = path.resolve(p.dir);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return { ok: false, error: `No such directory: ${target}` };
    }

    const safe = path.basename(p.name).replace(/[^\w.\-]+/g, "_") || "asset.wav";
    const filePath = path.join(target, safe);
    try {
      fs.writeFileSync(filePath, Buffer.from(p.bytes));
      return { ok: true, path: filePath, url: fileUrl(filePath), bytes: p.bytes.byteLength };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /*
    A take's sidecar, opened.

    A PLAIN cursor.json still opens here, and that is not an oversight: a
    take assembled by hand, copied from an older build, or built by a
    test has to keep working, and `readMaybeSealed` says which it met.
  */
  ipcMain.handle("recorder:readManifest", async (_event, p) => {
    const file = path.join(path.resolve(p.dir), "cursor.json");
    if (!fs.existsSync(file)) return { ok: false, error: "No cursor.json in that folder." };

    const opened = readMaybeSealed(file, "take-sidecar");
    if (!opened.ok) return { ok: false, error: opened.message, reason: opened.reason };
    try {
      return { ok: true, manifest: JSON.parse(opened.plaintext) };
    } catch (err) {
      return { ok: false, error: `cursor.json is not valid JSON: ${err.message}` };
    }
  });

  ipcMain.handle("recorder:reveal", async (_event, p) => {
    if (!p || !p.path) return false;
    shell.showItemInFolder(path.resolve(p.path));
    return true;
  });
}

/** Recording holds a global shortcut and an always-on-top window. Neither may outlive a quit. */
function shutdownScreenRecorder() {
  releaseShortcuts();
  shutdownInputCapture();
  closeBar();
  for (const session of sessions.values()) {
    if (session.liveStream) {
      try { session.liveStream.stop(); } catch { /* ignore */ }
    }
    if (session.sampler) clearInterval(session.sampler);
    for (const out of session.streams.values()) {
      if (!out.closed) { out.closed = true; out.handle.end(); }
    }
  }
  sessions.clear();
}

module.exports = { initScreenRecorder, shutdownScreenRecorder, recorderBarWindow, recordingsRoot };
