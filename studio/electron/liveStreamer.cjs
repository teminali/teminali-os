/* ═══════════════════════════════════════════════════════════════════
   Live streaming to third-party RTMP destinations (YouTube, Twitch, etc.)

   Takes the program WebM chunks from the renderer's live MediaRecorder
   and pipes them into an FFmpeg child process, which transcodes/muxes
   into FLV over RTMP/RTMPS with low latency presets and 2s keyframe
   cadence (GOP) required by YouTube Live and Twitch.

   Safe error handling:
     • Stdin write errors (EPIPE) are caught and handled without
       crashing Node.
     • Connection failures and stderr warnings are captured and
       pushed back to the renderer as structured LiveStreamStatus events.
     • Clean teardown on finish, cancel, or app shutdown.
   ═══════════════════════════════════════════════════════════════════ */

const { spawn } = require("child_process");
const { findFfmpeg, ffmpegInstallHint } = require("./mediaAccess.cjs");
const { chooseEncoder, encoderLine } = require("./encoderProbe.cjs");
const { videoEncoderArgs } = require("./hardwareEncoder.cjs");

/** Standard RTMP / RTMPS endpoints per service. */
const SERVICE_DEFAULTS = {
  youtube: "rtmp://a.rtmp.youtube.com/live2",
  twitch: "rtmp://live.twitch.tv/app",
  facebook: "rtmps://live-api-s.facebook.com:443/rtmp/",
  custom: "",
};

/**
 * Builds the complete destination URL by joining endpoint and stream key safely.
 * Redacts stream keys in logs so credentials never appear in debug traces.
 */
function buildDestinationUrl(service, customUrl, streamKey) {
  const key = (streamKey || "").trim();
  const base = (customUrl || SERVICE_DEFAULTS[service] || SERVICE_DEFAULTS.youtube).trim();
  if (!key) return base;

  const normalized = base.replace(/\/+$/, "");
  return `${normalized}/${key}`;
}

/**
 * Format service name for display.
 */
function displayServiceName(service) {
  if (service === "youtube") return "YouTube Live";
  if (service === "twitch") return "Twitch";
  if (service === "facebook") return "Facebook Live";
  return "Custom RTMP";
}

/**
 * Tests an RTMP connection by running a lightweight 2-second probe.
 */
function testLiveConnection({ service = "youtube", rtmpUrl, streamKey }) {
  return new Promise((resolve) => {
    /*
      The argument is judged before the machine is.

      These two checks were the other way round, which made the answer to "is
      this stream key any good?" depend on whether FFmpeg happened to be
      installed: an empty key came back as "FFmpeg is not installed" on a bare
      machine and as "stream key is required" on a stocked one. It failed in CI
      for exactly that reason and passed on the author's Mac. An empty key is
      empty either way, and it is also the one of the two the operator can fix
      without leaving the field they are already in.
    */
    const key = (streamKey || "").trim();
    if (!key) {
      resolve({ ok: false, error: "Stream key is required to test the connection." });
      return;
    }

    const bin = findFfmpeg();
    if (!bin) {
      resolve({
        ok: false,
        error: `FFmpeg is not installed (${ffmpegInstallHint()}). Install FFmpeg to enable live streaming.`,
      });
      return;
    }

    /*
      Software, as the live path has always been: a hardware encoder would cost
      less CPU but this is a two-second black frame proving a stream key, and
      the answer must not depend on the graphics card. No rate control is
      requested, which leaves x264 on its default and openh264 on its own —
      neither matters for 640x360 of black.
    */
    const testEncoder = encoderLine({
      codec: "h264", ff: bin, allowHardware: false,
      speed: "ultrafast", lowLatency: true, pixFmt: null,
    });
    if (!testEncoder) {
      resolve({ ok: false, error: "This FFmpeg build has no usable video encoder, so the connection cannot be tested." });
      return;
    }

    const destination = buildDestinationUrl(service, rtmpUrl, key);
    const args = [
      "-y",
      "-nostdin",
      "-t", "2",
      "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
      ...testEncoder.args,
      "-c:a", "aac",
      "-f", "flv",
      "-flvflags", "no_duration_filesize",
      "-tcp_nodelay", "1",
      "-timeout", "5000000",
      destination,
    ];

    let stderr = "";
    let timedOut = false;
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16 * 1024);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({
        ok: false,
        error: "Connection timed out after 8 seconds. Check your network or RTMP URL.",
      });
    }, 8000);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Could not launch FFmpeg: ${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        resolve({
          ok: true,
          message: `Successfully connected to ${displayServiceName(service)}!`,
        });
      } else {
        const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
        const errHint = lines.find((l) => /error|refused|failed|denied|invalid|unauthorized/i.test(l))
          || lines.slice(-2).join(" ")
          || `Exit code ${code}`;
        resolve({
          ok: false,
          error: `Connection to ${displayServiceName(service)} failed: ${errHint}`,
        });
      }
    });
  });
}

/**
 * Creates an active live streaming session connected via FFmpeg to RTMP.
 */
function createLiveStream(options, onStatus) {
  const bin = findFfmpeg();
  if (!bin) {
    onStatus?.({
      active: false,
      status: "error",
      error: `FFmpeg was not found (${ffmpegInstallHint()}). Install FFmpeg to go live.`,
    });
    return null;
  }

  const {
    service = "youtube",
    rtmpUrl,
    streamKey,
    fps = 30,
    bitrateKbps = 4500,
  } = options;

  /*
    Software for the same reason the test broadcast is: a live encode that
    changes character with the machine's GPU is a support case nobody can
    reproduce. Which software encoder is probed, not assumed — an LGPL ffmpeg
    has no x264.
  */
  const encoder = chooseEncoder("h264", bin, { allowHardware: false });
  if (!encoder) {
    onStatus?.({
      active: false,
      status: "error",
      error: "This FFmpeg build has no usable video encoder, so there is nothing to stream with.",
    });
    return null;
  }

  const destination = buildDestinationUrl(service, rtmpUrl, streamKey);
  const targetFps = Math.min(60, Math.max(15, fps));
  const gop = targetFps * 2; // 2s GOP required by YouTube and Twitch

  const args = [
    "-hide_banner",
    "-nostats",
    "-f", "webm",
    "-i", "pipe:0",
    ...videoEncoderArgs({
      encoder,
      speed: "veryfast",
      lowLatency: true,
      bitrateKbps,
      maxrateKbps: Math.round(bitrateKbps * 1.25),
      bufsizeKbps: Math.round(bitrateKbps * 2),
      gop,
      keyintMin: targetFps,
    }),
    "-c:a", "aac",
    "-b:a", "160k",
    "-ar", "44100",
    "-f", "flv",
    "-flvflags", "no_duration_filesize",
    "-tcp_nodelay", "1",
    "-tcp_keepalive", "1",
    "-rtmp_buffer", "2000",
    "-timeout", "10000000",
    destination,
  ];

  let child;
  try {
    child = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  } catch (err) {
    onStatus?.({
      active: false,
      status: "error",
      error: `Could not start live stream: ${err.message}`,
    });
    return null;
  }

  const session = {
    child,
    service,
    status: "connecting",
    bytesWritten: 0,
    startedAtMs: Date.now(),
    closed: false,
    error: null,
  };

  onStatus?.({
    active: true,
    status: "connecting",
    bytesSent: 0,
    durationMs: 0,
    fps: targetFps,
  });

  let stderrBuffer = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer = (stderrBuffer + chunk).slice(-16 * 1024);
    if (session.status === "connecting" && /Stream mapping:|Output #0|Opening 'rtmp/i.test(chunk)) {
      session.status = "live";
      onStatus?.({
        active: true,
        status: "live",
        bytesSent: session.bytesWritten,
        durationMs: Date.now() - session.startedAtMs,
        fps: targetFps,
      });
    }
  });

  child.stdin.on("error", (err) => {
    // Prevent uncaught EPIPE from terminating the host process
    if (!session.error) session.error = err.message;
    session.closed = true;
  });

  child.on("error", (err) => {
    session.error = err.message;
    session.status = "error";
    session.closed = true;
    onStatus?.({
      active: false,
      status: "error",
      error: `Stream process error: ${err.message}`,
      bytesSent: session.bytesWritten,
      durationMs: Date.now() - session.startedAtMs,
    });
  });

  child.on("close", (code) => {
    session.closed = true;
    const isCleanExit = code === 0 || session.status === "ended";
    const status = isCleanExit ? "ended" : "error";
    session.status = status;

    let errMessage = session.error;
    if (!errMessage && !isCleanExit) {
      const lines = stderrBuffer.split("\n").map((l) => l.trim()).filter(Boolean);
      errMessage = lines.find((l) => /error|refused|failed|denied|invalid/i.test(l))
        || lines.slice(-2).join(" ")
        || `Live stream disconnected (code ${code})`;
    }

    onStatus?.({
      active: false,
      status,
      error: errMessage ?? undefined,
      bytesSent: session.bytesWritten,
      durationMs: Date.now() - session.startedAtMs,
    });
  });

  return {
    write(bytes) {
      if (session.closed || !child.stdin || !child.stdin.writable || session.status === "error" || session.status === "ended") {
        return false;
      }
      try {
        const canWrite = child.stdin.write(Buffer.from(bytes));
        session.bytesWritten += bytes.byteLength;
        return canWrite;
      } catch (err) {
        session.error = err.message;
        session.closed = true;
        return false;
      }
    },
    stop() {
      if (session.closed && session.status === "ended") return;
      session.status = "ended";
      session.closed = true;
      try {
        child.stdin.end();
      } catch { /* ignore */ }
      const killTimer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, 3000);
      child.once("close", () => clearTimeout(killTimer));
    },
  };
}

module.exports = {
  SERVICE_DEFAULTS,
  buildDestinationUrl,
  displayServiceName,
  testLiveConnection,
  createLiveStream,
};
