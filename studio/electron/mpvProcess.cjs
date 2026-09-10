/*
  The player's engine, held at arm's length.

  The consumption player is a `<video>` element, and a `<video>` element is a
  browser's media stack: it plays what Chromium was built to demux and decode
  and nothing else. Everything else has to be transcoded on the way past, which
  is why `MediaPlayer.tsx` has a "transcode mode" whose duration is `Infinity`
  and whose timeline is arithmetic rather than a position — and why an MKV on a
  machine without ffmpeg does not play at all.

  mpv plays it. This module is the transport to mpv and nothing more: it finds
  the binary, spawns it idle with a JSON IPC socket, and speaks that protocol.
  It draws nothing, embeds nothing and owns no window. Embedding is B3 of the
  plan and is deliberately a separate step, because the transport is identical
  under either shape the engine can take — a spawned binary or a linked
  `libmpv` — so this could be written before that was chosen.

  It has since been chosen: **LGPL, built here** (B0; see
  `docs/MEDIA_LICENSING.md`). That is a decision about macOS more than about
  licence text — a process cannot embed another process's window there, so B3
  on the Mac ends in a link, and a linked GPL `libmpv` would make this product
  GPL. Nothing in this file changes because of it: Windows and Linux embed the
  spawned process with `--wid`, macOS links the same LGPL library later, and
  `mpvCommand` and the contract above it are untouched either way.

  Three things worth stating outright:

  * **No `node-mpv`.** It was last published six years ago, and being IPC-only
    there is nothing in it that is not written here — a socket, newline-framed
    JSON and a request id. Owning ~300 lines beats depending on an unmaintained
    wrapper for the same 300.

  * **The process is spawned, not linked.** That is the same posture already
    taken with ffmpeg, deliberately: a separate process at arm's length. When
    macOS moves to a linked `libmpv` in B3, `mpvCommand` and the whole contract
    above this file are unchanged; only `MpvProcess` is replaced.

  * **mpv is not bundled by any build today.** `findMpv` looks in a bundled
    location first so that shipping it later is a file drop rather than a code
    change, but nothing puts a file there yet — on a clean machine this returns
    null and the caller must say so, exactly as `mediaAccess.cjs` does for
    ffmpeg.

  What is *not* here, on purpose: any notion of a playlist. `next`, `previous`,
  `episode` and `episodes` are the pane's series navigation, not playback, and
  `mpvCommand` returns null for them rather than pretending mpv's own playlist
  is the same list. See the mapping table below.
*/

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

/* ── Finding it ───────────────────────────────────────────────────────────── */

/** `mpv.exe` on Windows, `mpv` everywhere else. */
const MPV_BINARY = process.platform === "win32" ? "mpv.exe" : "mpv";

/**
 * The install locations worth trying before PATH, per platform.
 *
 * Same list and same reasoning as `mediaAccess.cjs`'s `fixedFfmpegDirs`: a
 * packaged app launched from Finder inherits launchd's PATH, which contains
 * none of these, so PATH is the thing that is missing rather than the thing to
 * search first.
 */
function fixedMpvDirs(env = process.env) {
  if (process.platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const localAppData = env.LOCALAPPDATA || "";
    const home = env.USERPROFILE || "";
    return [
      "C:\\mpv",
      path.join(programFiles, "mpv"),
      path.join(env.ChocolateyInstall || "C:\\ProgramData\\chocolatey", "bin"),
      home ? path.join(home, "scoop", "shims") : null,
      localAppData ? path.join(localAppData, "Microsoft", "WinGet", "Links") : null,
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    // Homebrew on Apple silicon, Homebrew on Intel, MacPorts, the system.
    return ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"];
  }
  return ["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"];
}

/**
 * What to tell an operator who has not got mpv.
 *
 * Naming the wrong package manager is worse than naming none, so this follows
 * `ffmpegInstallHint` in giving one command per platform and no menu. Note
 * that this string is for a log and for the docs — the browser panel's rule
 * that a customer is never shown a shell command applies to anything the
 * player puts on screen.
 */
function mpvInstallHint() {
  if (process.platform === "win32") return "choco install mpv";
  if (process.platform === "darwin") return "brew install mpv";
  return "apt install mpv";
}

/**
 * Where mpv is, if it is anywhere. Null is a real answer.
 *
 * Order: the explicit override, then a copy shipped inside the app, then the
 * known install directories, then PATH as the catch-all for a custom install.
 * PATH is last for the same reason it is last in `findFfmpeg` — the fixed list
 * is ordered by preference and an arbitrary earlier PATH entry should not beat
 * it.
 *
 * Everything it touches is injected so the search is testable without a
 * filesystem: `env` for the override and the Windows prefixes, `resourcesPath`
 * for the bundled copy (Electron's, absent outside a packaged app), `exists`
 * for the probe itself.
 */
function findMpv({
  env = process.env,
  resourcesPath = process.resourcesPath,
  exists = (candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  },
} = {}) {
  const candidates = [
    env.MPV_PATH,
    resourcesPath ? path.join(resourcesPath, "mpv", MPV_BINARY) : null,
    ...fixedMpvDirs(env).map((dir) => path.join(dir, MPV_BINARY)),
    ...String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, MPV_BINARY)),
  ].filter(Boolean);
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/* ── The socket, and how anything else finds it ───────────────────────────── */

/**
 * The IPC endpoint mpv is told to create.
 *
 * On Windows `--input-ipc-server` takes a named pipe, not a path, and the pipe
 * namespace is flat — so the pid is in the name to keep two windows apart. On
 * everything else it is a unix socket in the temp directory, for the same
 * reason and with the same shape as the video bridge's endpoint file.
 */
function ipcSocketPath({ platform = process.platform, tmpdir = os.tmpdir(), pid = process.pid } = {}) {
  if (platform === "win32") return `\\\\.\\pipe\\teminali-os-mpv-${pid}`;
  return path.join(tmpdir, `teminali-os-mpv-${pid}.sock`);
}

/**
 * Where the socket's whereabouts are written down.
 *
 * The gateway and the MCP shims are separate processes that have no way to
 * learn a socket path chosen in Electron main's memory, so main publishes it
 * the way `videoRpc.cjs` publishes the video bridge's port and token, and it
 * is discovered the way `server/video-mcp.js` discovers that one.
 */
function endpointFile(tmpdir = os.tmpdir()) {
  return path.join(tmpdir, "teminali-os-mpv-bridge.json");
}

/**
 * What is written there.
 *
 * The pid is load-bearing on the reading side: a socket file survives a crash,
 * so a reader must be able to ask whether the process that made it is still
 * alive rather than connecting to a dead one and hanging.
 */
function endpointRecord({ socket, pid, binary, startedAt = Date.now() }) {
  return { socket, pid, binary, startedAt };
}

/* ── The framing ──────────────────────────────────────────────────────────── */

/*
  mpv's IPC protocol is newline-delimited JSON in both directions. A request is
  `{"command":[...],"request_id":N}`; a reply is `{"error":"success","data":…,
  "request_id":N}`; anything with an `event` key is unsolicited.

  Both framing helpers are pure and exported, because a partial line arriving
  mid-object is the failure that produces a silent, permanent hang rather than
  an error, and it deserves a test rather than a careful reading.
*/

/** One request, framed. Trailing newline included — mpv acts on nothing without it. */
function frameRequest(request) {
  return `${JSON.stringify(request)}\n`;
}

/**
 * Split what has arrived so far into whole messages plus whatever is left over.
 *
 * Returns `{ messages, rest }`. A line that is not JSON is dropped rather than
 * thrown on: mpv writes the odd diagnostic to the socket, and one malformed
 * line must not poison the stream behind it.
 */
function parseIpcChunk(buffer) {
  const messages = [];
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf("\n");
    if (newline === -1) break;
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (!line) continue;
    try { messages.push(JSON.parse(line)); } catch { /* not ours; drop the line, keep the stream */ }
  }
  return { messages, rest };
}

/* ── The mapping ──────────────────────────────────────────────────────────── */

/**
 * The rate bounds, spelled here as well so this file stands alone under plain
 * node. `server/player-state.js` refuses anything outside them before a
 * command reaches this module; the clamp below is the second line, for a
 * command that came from the pane rather than the agent.
 */
const PLAYER_RATE = Object.freeze({ min: 0.25, max: 3 });

/** mpv's `volume` property is a percentage; the contract's is a 0–1 fraction. */
function volumePercent(fraction) {
  const clamped = Math.min(1, Math.max(0, Number(fraction) || 0));
  return Math.round(clamped * 1000) / 10;
}

function clampRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return 1;
  return Math.min(PLAYER_RATE.max, Math.max(PLAYER_RATE.min, rate));
}

/**
 * Which track a label means, given what the file actually has. Subtitles and
 * audio both, because the question is the same one twice and the answer had
 * better not be two rules.
 *
 * Exact match first, then a substring — the same two-step `MediaPlayer.tsx`
 * does, so that "english" finds "English (SDH)" in both engines and the
 * assistant does not learn one rule for one player and another for the other.
 */
function trackFor(label, tracks) {
  const wanted = String(label).trim().toLowerCase();
  if (!wanted) return null;
  return tracks.find((track) => String(track.label || "").toLowerCase() === wanted)
    ?? tracks.find((track) => String(track.label || "").toLowerCase().includes(wanted))
    ?? null;
}

/**
 * What one track is called, given what mpv knows about it.
 *
 * The same three-step the pane uses on a probe (`MediaPlayer.tsx`: the
 * stream's title, else its language in capitals, else its number), because
 * where mpv holds the picture this list *is* the pane's subtitle menu — a
 * fourth rule would mean the same file was named one thing by one engine and
 * another by the other. The external file's own name comes before the number:
 * a sidecar mpv could read no language out of is still "Episode 1.srt" to the
 * operator, which is more than "Track 2" is.
 */
function trackLabel(track) {
  const title = String(track?.title ?? "").trim();
  if (title) return title;
  const language = String(track?.lang ?? "").trim();
  if (language) return language.toUpperCase();
  const file = String(track?.["external-filename"] ?? "").trim();
  if (file) return file.split(/[\\/]/).pop();
  return `Track ${track?.id ?? "?"}`;
}

/**
 * mpv's `track-list` as the two lists the contract asks about.
 *
 * This is the answer to the question B3 left open. The pane's own subtitle
 * tracks are WebVTT blobs it built out of sidecar files, and mpv chooses a
 * track by an `sid` out of the file — two lists with nothing in common, which
 * is why `subtitles` was published as unsupported while embedded. mpv already
 * loads the same sidecars (`--sub-auto=exact` above) and already numbers
 * everything it has, so the list it reports here is the one true list, and the
 * pane shows it rather than its own.
 *
 * `selected` is carried because `sid` and `aid` are also observed and the two
 * must not be able to disagree: this is what mpv had when it last spoke.
 * Video tracks are dropped — nothing in the contract chooses one.
 */
function playerTracks(list) {
  const tracks = Array.isArray(list) ? list : [];
  const of = (type) => tracks
    .filter((track) => track?.type === type && Number.isFinite(Number(track.id)))
    .map((track) => ({
      id: Number(track.id),
      label: trackLabel(track),
      language: track?.lang ? String(track.lang) : null,
      selected: Boolean(track?.selected),
      external: Boolean(track?.external),
    }));
  return { subtitles: of("sub"), audio: of("audio") };
}

/**
 * mpv's `screenshot-raw` reply as a bitmap Electron will accept, or null.
 *
 * The reply is `{ w, h, stride, format, data }` with `data` base64. Three
 * things have to be true before it is a picture, and each of them is a bug
 * that produces a *skewed* image rather than an error, which is why this is a
 * pure function with a test rather than four lines at the call site:
 *
 * * **`stride` is bytes per row and may exceed `w * 4`.** mpv pads rows to
 *   whatever its allocator liked. Handing the padded buffer to Electron with
 *   only a width shears the image diagonally — it still looks like a frame,
 *   so nothing downstream notices. Each row is copied out at its own offset.
 * * **`bgr0` sets the fourth byte to zero, not to 255.** That is mpv's default
 *   format and the only one asked for here. Zero is transparent, and a
 *   transparent bitmap encodes as a black JPEG. The alpha byte is forced
 *   opaque on the way through.
 * * **The byte order must already be BGRA.** `nativeImage.createFromBitmap`
 *   documents no other. `bgr0` and `bgra` are that order; `rgba` is not and is
 *   refused rather than silently swapping the operator's blue for red.
 *
 * Kept in this file, not in `mpvView.cjs`, because it is arithmetic with no
 * Electron in it and `tests/mpv-ipc.test.mjs` runs under plain node.
 */
function packBitmap(raw) {
  const width = Number(raw?.w);
  const height = Number(raw?.h);
  const stride = Number(raw?.stride);
  const format = String(raw?.format ?? "bgr0").toLowerCase();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (!Number.isInteger(stride) || stride < width * 4) return null;
  if (format !== "bgr0" && format !== "bgra") return null;
  if (typeof raw?.data !== "string") return null;

  const source = Buffer.from(raw.data, "base64");
  if (source.length < stride * height) return null;

  const pixels = Buffer.allocUnsafe(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    source.copy(pixels, row * width * 4, row * stride, row * stride + width * 4);
  }
  for (let byte = 3; byte < pixels.length; byte += 4) pixels[byte] = 255;
  return { width, height, pixels };
}

/**
 * A `PlayerCommand` as mpv commands, or null when it is not mpv's question.
 *
 * The list of actions is `src/services/playerControl.ts`'s and
 * `server/player-state.js`'s — the frozen contract `tests/player-state.test.mjs`
 * guards. This function is the third place that list appears, and
 * `tests/mpv-ipc.test.mjs` asserts every action in it is answered here, so a
 * new action cannot be added to the contract and silently do nothing in mpv.
 *
 * Returning an **array** of commands, not one, is deliberate: `restart` is a
 * seek and an unpause, and doing it as two calls at the call site would put a
 * decision back where the point of this table is to take it away.
 *
 * Returning **null** is the other real answer, and there are two kinds:
 *
 * * `next` / `previous` / `episode` / `episodes` — series navigation. mpv has
 *   a playlist, but it is not the pane's episode list: the pane's is a folder
 *   scanned with watched-fractions and titles, and mapping one onto the other
 *   would make `episode 3` mean different files depending on what had been
 *   loaded. These stay with the pane, which then loads a file into mpv.
 * * `subtitles` or `audio_track` with a label that no track matches — the
 *   honest answer is that the request cannot be carried out, not that it
 *   silently turned into "first track".
 *
 * `context.subtitles` and `context.audio` are the file's tracks,
 * `[{ id, label }]`, as mpv's own `track-list` reports them. They are
 * parameters rather than lookups so the whole table stays pure.
 */
function mpvCommand(command, context = {}) {
  const action = String(command?.action || "");
  const value = command?.value;
  const subtitles = Array.isArray(context.subtitles) ? context.subtitles : [];

  switch (action) {
    case "play":
      return [["set_property", "pause", false]];
    case "pause":
      return [["set_property", "pause", true]];
    case "toggle":
      return [["cycle", "pause"]];
    /*
      `exact` on every seek, and it is not a detail.

      mpv's default is a keyframe seek: it lands on the nearest index point,
      which on a file encoded with a 10-second GOP is up to ten seconds from
      where it was sent. Measured against a real mpv 0.41 and an x265 clip,
      `seek -3 relative` from 8s arrived at **0**, and `+5` from there at
      **10**. The contract's `seek` and `seek_by` are in seconds, the pane's
      `<video>` seeks exactly, and B2's whole point is an assistant finding a
      described moment and going to it — a seek that misses by a GOP is not a
      seek. Exact costs a decode from the preceding keyframe, which is the
      right thing to spend.
    */
    case "restart":
      return [["seek", 0, "absolute+exact"], ["set_property", "pause", false]];
    case "seek":
      return [["seek", Number(value) || 0, "absolute+exact"]];
    case "seek_by":
      return [["seek", Number(value) || 0, "relative+exact"]];
    /*
      Frame stepping is mpv's own, and it is the reason these two actions
      exist at all. `frame-step` decodes exactly one frame forward and leaves
      the file paused; `frame-back-step` goes the other way, and mpv's own
      documentation warns it is expensive — it seeks behind the current
      position and decodes forward. Both are still the real thing, which
      `<video>` cannot be: an element told to advance by 1/fps lands wherever
      the decoder's nearest presentable frame is, and on a variable-frame-rate
      file that is not one frame.
    */
    case "frame_step":
      return [["frame-step"]];
    case "frame_back":
      return [["frame-back-step"]];
    /*
      mpv counts chapters from 0 and the contract counts from 1, because the
      contract's other index — `episode` — is a number the agent read off a
      list it was shown. One rule for both is worth the subtraction here.
    */
    case "chapter":
      return [["set_property", "chapter", Math.max(0, (Number(value) || 1) - 1)]];
    case "volume": {
      const percent = volumePercent(value);
      /*
        Muting at zero mirrors the pane, which sets `muted` when the volume
        reaches 0. It matters because `muted` is a field of the snapshot the
        agent reads back: if the two engines disagreed about what volume 0
        means, the agent would see a different answer to the same question
        depending on which one was playing.
      */
      return [["set_property", "volume", percent], ["set_property", "mute", percent === 0]];
    }
    case "mute":
      return [["set_property", "mute", true]];
    case "unmute":
      return [["set_property", "mute", false]];
    case "rate":
      return [["set_property", "speed", clampRate(value ?? 1)]];
    case "subtitles": {
      const wanted = value === undefined || value === null ? "on" : String(value);
      if (wanted === "off") return [["set_property", "sid", "no"]];
      if (wanted === "on") {
        const first = subtitles[0];
        return first ? [["set_property", "sid", first.id]] : [["set_property", "sid", "auto"]];
      }
      const chosen = trackFor(wanted, subtitles);
      return chosen ? [["set_property", "sid", chosen.id]] : null;
    }
    /*
      A number is mpv's `aid` as it stands — the contract counts audio tracks
      from 1 and so does mpv, so nothing is subtracted here and the chapter
      case above is the exception rather than this being one.

      A label goes through the same two-step resolution subtitles use, against
      `context.audio` — the file's audio tracks as `track-list` reports them.
      A label matching nothing is null, a refusal, for the reason spelled in
      the header: falling back to track 1 would answer a question the operator
      did not ask, and "Japanese" quietly meaning English is worse than being
      told the file has no Japanese.
    */
    case "audio_track": {
      const audio = Array.isArray(context.audio) ? context.audio : [];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value >= 1 ? [["set_property", "aid", Math.trunc(value)]] : null;
      }
      const chosen = trackFor(String(value ?? ""), audio);
      return chosen ? [["set_property", "aid", chosen.id]] : null;
    }
    case "fullscreen":
      return typeof value === "boolean"
        ? [["set_property", "fullscreen", value]]
        : [["cycle", "fullscreen"]];
    case "next":
    case "previous":
    case "episode":
    case "episodes":
      return null;
    default:
      return null;
  }
}

/**
 * The properties worth watching, and the snapshot field each one feeds.
 *
 * Observed rather than polled: mpv pushes a `property-change` event the moment
 * a value moves, and the alternative — asking for six properties on a timer —
 * is the shape that made the `<video>` path's throttling a tuning problem.
 */
const OBSERVED_PROPERTIES = Object.freeze({
  "time-pos": "time",
  duration: "duration",
  pause: "playing",
  volume: "volume",
  mute: "muted",
  speed: "rate",
  "eof-reached": "ended",
  path: "path",
  "media-title": "title",
});

/* ── Spawning it ──────────────────────────────────────────────────────────── */

/**
 * How mpv is started.
 *
 * `--idle` so it lives with no file loaded — the process outlasts any one
 * episode, and loading is a `loadfile` down the socket rather than a respawn.
 * `--no-terminal` because there is no terminal and mpv's keyboard handling on
 * stdin would fight the app's. `--no-input-default-bindings` because the
 * player's shortcuts belong to the pane, which already owns them; mpv's own
 * bindings would be a second, invisible set with different answers.
 *
 * `--sub-auto=exact` is mpv finding the same subtitle files the pane already
 * found. `subtitleTracksFor` in `src/services/workspaceGallery.ts` takes the
 * siblings whose base name is the video's, optionally followed by a dot and a
 * language — which is, word for word, what mpv's `exact` means. So the two
 * lists agree without either being sent to the other, and the pane can stop
 * building WebVTT out of files the engine has open already. It is written down
 * rather than left to the default because the correspondence is the point: if
 * mpv's default moved, the menu would quietly stop matching the folder.
 *
 * `--vo=libmpv` is *not* passed here. Under B1 mpv opens its own window, which
 * is what makes the transport testable before the embedding exists; B3 is
 * where the video output changes, and it changes here.
 */
function mpvArgs({ socket, extra = [] } = {}) {
  return [
    "--idle=yes",
    "--no-terminal",
    "--no-input-default-bindings",
    "--keep-open=yes",
    "--sub-auto=exact",
    `--input-ipc-server=${socket}`,
    ...extra,
  ];
}

class MpvError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MpvError";
    this.code = code;
  }
}

/** How long a request may go unanswered before it is a failure rather than a wait. */
const REQUEST_TIMEOUT_MS = 10_000;
/** mpv creates the socket a moment after it starts; this is how long we let it take. */
const CONNECT_TIMEOUT_MS = 5_000;
const CONNECT_RETRY_MS = 60;

/**
 * The JSON IPC client.
 *
 * One socket, one map of outstanding requests keyed by `request_id`, and an
 * emitter for everything unsolicited. It does not spawn anything and does not
 * know what mpv is for — `MpvProcess` owns the process, this owns the wire —
 * so it can be pointed at an mpv somebody else started, which is how it is
 * driven by hand.
 *
 * Events: `event` (mpv's own, verbatim), `property` (`{ name, field, value }`,
 * `field` being the snapshot field from `OBSERVED_PROPERTIES`), `close`.
 */
class MpvIpc extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
    this.socket = null;
    this.pending = new Map();
    this.observed = new Map();
    this.nextRequestId = 1;
    this.nextObserveId = 1;
    this.buffer = "";
  }

  /**
   * Connect, retrying until the socket exists or the deadline passes.
   *
   * The retry is not defensiveness: mpv creates the socket after it has
   * started, so the first connect attempt after a spawn reliably fails and a
   * client that gave up there would never work.
   */
  connect({ timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const socket = net.createConnection(this.socketPath);
        socket.setEncoding("utf8");
        /*
          The retry listener is removed the moment the connection is up. Left
          on, an error *after* connecting would be read as "the socket is not
          there yet" and start a second connection behind the first one — a
          client with two sockets and one `this.socket`, which loses replies.
        */
        const retry = () => {
          socket.destroy();
          if (Date.now() >= deadline) {
            reject(new MpvError("MPV_NO_SOCKET", `mpv's IPC socket did not appear at ${this.socketPath}.`));
            return;
          }
          setTimeout(attempt, CONNECT_RETRY_MS);
        };
        socket.once("connect", () => {
          socket.off("error", retry);
          this.socket = socket;
          socket.on("data", (chunk) => this.#receive(chunk));
          socket.on("close", () => this.#closed());
          socket.on("error", () => { /* close follows; one report is enough */ });
          resolve(this);
        });
        socket.once("error", retry);
      };
      attempt();
    });
  }

  #receive(chunk) {
    const { messages, rest } = parseIpcChunk(this.buffer + chunk);
    this.buffer = rest;
    for (const message of messages) {
      if (message.request_id !== undefined && this.pending.has(message.request_id)) {
        const { resolve, reject, timer } = this.pending.get(message.request_id);
        this.pending.delete(message.request_id);
        clearTimeout(timer);
        if (message.error && message.error !== "success") {
          reject(new MpvError("MPV_COMMAND_FAILED", message.error));
        } else {
          resolve(message.data);
        }
        continue;
      }
      if (message.event === "property-change") {
        const name = this.observed.get(message.id) ?? message.name;
        this.emit("property", { name, field: OBSERVED_PROPERTIES[name] ?? null, value: message.data });
        continue;
      }
      if (message.event) this.emit("event", message);
    }
  }

  /**
   * The socket went away.
   *
   * Every outstanding request is failed rather than left hanging: a promise
   * that never settles is how a dead player becomes a frozen turn.
   */
  #closed() {
    this.socket = null;
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new MpvError("MPV_CLOSED", "mpv's IPC socket closed before the command was answered."));
    }
    this.pending.clear();
    this.emit("close");
  }

  /** One mpv command. Resolves its `data`, rejects with mpv's own error string. */
  command(...args) {
    if (!this.socket) return Promise.reject(new MpvError("MPV_CLOSED", "mpv is not connected."));
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new MpvError("MPV_TIMEOUT", `mpv did not answer \`${args[0]}\` within ${REQUEST_TIMEOUT_MS}ms.`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(frameRequest({ command: args, request_id: requestId }));
    });
  }

  getProperty(name) { return this.command("get_property", name); }
  setProperty(name, value) { return this.command("set_property", name, value); }

  /** Ask to be told when `name` changes. The id is ours, so a change can be named back. */
  async observeProperty(name) {
    const id = this.nextObserveId++;
    this.observed.set(id, name);
    await this.command("observe_property", id, name);
    return id;
  }

  /** Every property in `OBSERVED_PROPERTIES`, in one go. */
  async observeAll() {
    for (const name of Object.keys(OBSERVED_PROPERTIES)) await this.observeProperty(name);
  }

  /** A whole `PlayerCommand`, through the table. Null means mpv was not asked. */
  async run(command, context) {
    const commands = mpvCommand(command, context);
    if (!commands) return null;
    const results = [];
    for (const args of commands) results.push(await this.command(...args));
    return results;
  }

  close() {
    try { this.socket?.end(); } catch { /* already gone */ }
  }
}

/**
 * The process, and the endpoint file that says where it is.
 *
 * Deliberately small: spawn, connect, publish, and on the way out unpublish and
 * kill. It does not restart mpv on a crash. A player that silently came back
 * with no file loaded and the volume at default would be worse than one that
 * stopped — the pane can see `close` and say so, and reloading is a decision
 * about what the operator was watching, which lives above this file.
 */
class MpvProcess extends EventEmitter {
  constructor({ binary = null, socket = null, tmpdir = os.tmpdir(), extraArgs = [] } = {}) {
    super();
    this.binary = binary ?? findMpv();
    this.socketPath = socket ?? ipcSocketPath({ tmpdir });
    this.tmpdir = tmpdir;
    this.extraArgs = extraArgs;
    this.child = null;
    this.ipc = null;
    this.published = false;
  }

  /** Whether there is an mpv to spawn at all. Null binary is a normal answer. */
  get available() { return Boolean(this.binary); }

  async start() {
    if (!this.binary) {
      throw new MpvError("MPV_NOT_FOUND", `mpv was not found. Install it (${mpvInstallHint()}) or set MPV_PATH.`);
    }
    /*
      A socket left by a crashed mpv would be connected to and then never
      answer, so it is removed before the spawn rather than after a hang.
      Windows named pipes are not files and disappear with their process.
    */
    if (process.platform !== "win32") {
      try { fs.unlinkSync(this.socketPath); } catch { /* not there, which is the normal case */ }
    }

    this.child = spawn(this.binary, mpvArgs({ socket: this.socketPath, extra: this.extraArgs }), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child.once("exit", (code, signal) => {
      this.child = null;
      this.#unpublish();
      this.emit("exit", { code, signal });
    });
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (line) => this.emit("stderr", String(line).trimEnd()));

    this.ipc = new MpvIpc(this.socketPath);
    await this.ipc.connect();
    /*
      Forwarded before the observes are placed, not after: mpv answers
      `observe_property` with the property's current value straight away, and a
      listener attached afterwards would miss the whole opening state — the
      player would look as though it had no duration until something moved.
    */
    this.ipc.on("property", (change) => this.emit("property", change));
    this.ipc.on("event", (event) => this.emit("event", event));
    await this.ipc.observeAll();
    this.#publish();
    return this.ipc;
  }

  #publish() {
    try {
      fs.writeFileSync(
        endpointFile(this.tmpdir),
        JSON.stringify(endpointRecord({
          socket: this.socketPath,
          pid: this.child?.pid ?? null,
          binary: this.binary,
        }), null, 2),
        { encoding: "utf8", mode: 0o600 }
      );
      this.published = true;
    } catch (error) {
      this.emit("stderr", `[mpv] could not publish the endpoint: ${error.message}`);
    }
  }

  #unpublish() {
    if (!this.published) return;
    this.published = false;
    try { fs.unlinkSync(endpointFile(this.tmpdir)); } catch { /* already gone */ }
  }

  stop() {
    this.#unpublish();
    this.ipc?.close();
    this.ipc = null;
    try { this.child?.kill(); } catch { /* already gone */ }
    this.child = null;
  }
}

/**
 * The running mpv, or null — the reader's half of the endpoint file.
 *
 * Mirrors `server/video-mcp.js`'s `runningBridge`: a stale file is the case
 * this exists to survive, so the pid is checked before the record is believed.
 * Signal 0 asks whether a process exists without touching it.
 */
function runningMpv({ tmpdir = os.tmpdir(), alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  let record;
  try { record = JSON.parse(fs.readFileSync(endpointFile(tmpdir), "utf8")); } catch { return null; }
  if (!record || typeof record.socket !== "string" || !Number.isInteger(record.pid)) return null;
  return alive(record.pid) ? record : null;
}

module.exports = {
  MPV_BINARY,
  OBSERVED_PROPERTIES,
  PLAYER_RATE,
  MpvError,
  MpvIpc,
  MpvProcess,
  endpointFile,
  endpointRecord,
  findMpv,
  fixedMpvDirs,
  frameRequest,
  ipcSocketPath,
  mpvArgs,
  mpvCommand,
  mpvInstallHint,
  packBitmap,
  parseIpcChunk,
  playerTracks,
  runningMpv,
  trackFor,
  trackLabel,
  volumePercent,
};
