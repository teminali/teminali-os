/* ─────────────────────────────────────────────────────────────────────────────
   What the media approval gate needs from the operating system.

   The gate itself lives in the renderer (`src/services/mediaConsent.ts`) and is
   deliberately free of I/O, because the checks it makes have to be testable
   under plain Node. But two of them cannot be made in a renderer at all:

   • **Resolution.** `..` has to be collapsed and symlinks followed before a path
     is judged, and the answer is what the prompt shows. A gate that validates
     one path and opens another is worse than no gate, and only a process with
     `fs` can tell the difference.
   • **The policy's anchors.** The deny list is written against the operator's
     home directory and the app's own `userData`, which only main knows.

   And one thing that is not a check at all: ffmpeg. It is here for the reason
   the Cut gives (`teminaliCut/electron/main.ts:400`) — the renderer supplies a
   FILTER STRING and named options, never argv, so a caller cannot reach `-f`,
   an output path, or anything else that writes where it likes. The worst it can
   express is a bad filtergraph, which fails with ffmpeg's own message.
   ───────────────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { fileURLToPath } = require("url");

/**
 * The real path, as far as it exists.
 *
 * `fs.realpathSync` throws on a path whose leaf is not there yet — which is
 * every `import_media_from_path` typo and every ffmpeg output that has not been
 * written. Resolving the deepest ancestor that DOES exist and re-appending the
 * remainder gives the same security property (a component that does not exist
 * cannot be a symlink) without turning "no such file" into "the gate crashed".
 */
function resolveRealPath(input) {
  if (typeof input !== "string" || input.length === 0) return null;
  let candidate = path.resolve(input);
  const trailing = [];

  for (;;) {
    try {
      const real = fs.realpathSync(candidate);
      return trailing.length ? path.join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = path.dirname(candidate);
      // `/` is its own parent: nothing above this exists, so the lexical
      // resolution is the best answer there is.
      if (parent === candidate) return path.resolve(input);
      trailing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

/** A path or URL ffmpeg — a separate process — can actually open. */
function ffmpegSource(mediaUrl) {
  if (typeof mediaUrl !== "string") return "";
  if (!mediaUrl.startsWith("file://")) return mediaUrl;
  try {
    return fileURLToPath(mediaUrl);
  } catch {
    try {
      return decodeURIComponent(mediaUrl.replace(/^file:\/\//, ""));
    } catch {
      return mediaUrl.replace(/^file:\/\//, "");
    }
  }
}

/** `ffmpeg.exe` on Windows, `ffmpeg` everywhere else. */
const FFMPEG_BINARY = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

/**
 * The install locations worth trying before PATH, per platform.
 *
 * These come FIRST and not as a fallback, because the whole reason they are
 * listed is that PATH is the thing that is missing: see `findFfmpeg`. On
 * Windows the four package managers people actually install ffmpeg with each
 * put it somewhere different, and only winget's Links directory is reliably
 * on a GUI process's PATH.
 */
function fixedFfmpegDirs() {
  const env = process.env;
  if (process.platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const home = env.USERPROFILE || "";
    return [
      "C:\\ffmpeg\\bin",
      path.join(programFiles, "ffmpeg", "bin"),
      // Chocolatey shims, then Scoop's, then winget's.
      path.join(env.ChocolateyInstall || "C:\\ProgramData\\chocolatey", "bin"),
      home ? path.join(home, "scoop", "shims") : null,
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links") : null,
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    // Homebrew on Apple silicon, Homebrew on Intel, MacPorts, the system.
    return ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"];
  }
  return ["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"];
}

/**
 * Where ffmpeg is, if it is anywhere.
 *
 * A packaged app launched from Finder inherits launchd's PATH, which has none
 * of the places Homebrew or MacPorts install into — the same landmine the
 * gateway's `bin-paths.js` documents. Windows has the same problem with a
 * different shape: an app started from the Start menu gets the PATH that
 * existed when Explorer started, so an ffmpeg installed since then is
 * invisible until the operator logs out.
 *
 * So: the explicit override, then the known install directories, then PATH
 * as the catch-all for a custom install. PATH is searched LAST on purpose —
 * the fixed list is ordered by preference (Homebrew's build over the system's)
 * and putting PATH first would let an arbitrary earlier entry win.
 *
 * Looked up once and cached: the answer does not change within a session, and
 * a miss costs a `statSync` per candidate.
 */
let ffmpegPath;
function findFfmpeg() {
  if (ffmpegPath !== undefined) return ffmpegPath;

  const fromPath = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);

  const candidates = [
    process.env.FFMPEG_PATH,
    ...fixedFfmpegDirs().map((dir) => path.join(dir, FFMPEG_BINARY)),
    ...fromPath.map((dir) => path.join(dir, FFMPEG_BINARY)),
  ].filter(Boolean);

  ffmpegPath = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) ?? null;
  return ffmpegPath;
}

/**
 * What to tell an operator who has not got ffmpeg.
 *
 * Naming the wrong package manager is worse than naming none: it sends
 * somebody to a command that does not exist on their machine.
 */
function ffmpegInstallHint() {
  if (process.platform === "win32") return "winget install Gyan.FFmpeg";
  if (process.platform === "darwin") return "brew install ffmpeg";
  return "apt install ffmpeg";
}

/**
 * Run one filtergraph over one input, to a new file in temp.
 *
 * 15 minutes, which is the Cut's figure and a WORK deadline — not to be
 * confused with the gate's own 90s deadline, which is a HUMAN one. The
 * original file is never touched: everything lands in a fresh output path.
 */
function processWithFfmpeg(options = {}) {
  const binary = findFfmpeg();
  if (!binary) {
    return Promise.resolve({
      ok: false,
      error: `ffmpeg was not found. Install it (\`${ffmpegInstallHint()}\`) or set FFMPEG_PATH.`,
    });
  }

  const dir = path.join(os.tmpdir(), "teminali-os-processed");
  fs.mkdirSync(dir, { recursive: true });

  const safe = path.basename(String(options.name || "processed")).replace(/[^\w.\-]+/g, "_") || "processed";
  const ext = options.audioOnly ? "wav" : "mp4";
  const outPath = path.join(dir, `${Date.now().toString(36)}_${safe}.${ext}`);

  const args = ["-y", "-nostdin", "-i", ffmpegSource(options.input)];
  if (options.vf) args.push("-vf", String(options.vf));
  if (options.af) args.push("-af", String(options.af));
  if (options.fps) args.push("-r", String(Number(options.fps)));

  if (options.audioOnly) {
    args.push("-vn", "-c:a", "pcm_s16le", "-ar", "48000");
  } else {
    args.push("-c:a", "aac", "-b:a", "256k");
    args.push("-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p");
  }
  args.push(outPath);

  return new Promise((resolve) => {
    execFile(binary, args, { timeout: 15 * 60_000, maxBuffer: 1024 * 1024 }, (err, _out, stderr) => {
      const text = (stderr || "").trim();
      if (err || !fs.existsSync(outPath)) {
        resolve({
          ok: false,
          // ffmpeg says what went wrong in its last few lines; the rest is
          // build configuration nobody reading a tool result needs.
          error: text.split("\n").filter(Boolean).slice(-3).join(" ") || err?.message || "ffmpeg failed.",
        });
        return;
      }
      const size = fs.statSync(outPath).size;
      if (size === 0) {
        resolve({ ok: false, error: "ffmpeg produced an empty file." });
        return;
      }
      resolve({ ok: true, path: outPath, bytes: size });
    });
  });
}

/**
 * One audit line per decision.
 *
 * Which grant satisfied a call is the whole point: an allowed call tells you
 * nothing unless you know whether it was the folder the operator picked, an
 * answer they gave, or a session grant they forgot they made. Without the
 * reason, "the agent imported something odd" has no answer.
 */
function formatAuditLine(entry = {}) {
  const verdict = entry.allowed ? "allowed" : "refused";
  return `[media] ${verdict} ${entry.tool ?? "?"} · ${entry.agentName ?? "?"} · ${entry.reason ?? "?"} · ${entry.path ?? "?"}`;
}

module.exports = {
  resolveRealPath, ffmpegSource, findFfmpeg, ffmpegInstallHint, fixedFfmpegDirs,
  processWithFfmpeg, formatAuditLine,
};
