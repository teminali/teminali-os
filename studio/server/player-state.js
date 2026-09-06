/**
 * The media player, as the gateway sees it.
 *
 * The window publishes what its player is showing (`/api/workspace/player/state`)
 * and the agent reads it back (`player`) or asks for a change
 * (`player_control`). The gateway holds no handle on the element: it keeps the
 * last snapshot the window sent and forwards a command down the run's own
 * stream. So this module is two pure things — a registry that sanitises what
 * the window reports, and a parser for what the agent asks — and nothing that
 * needs a socket to test.
 *
 * `PLAYER_ACTIONS` is the same list `src/services/playerControl.ts` spells,
 * and `tests/player-state.test.mjs` asserts they match: an action the gateway
 * accepts and the pane does not know is a tool call that says "done" and does
 * nothing.
 */

export const PLAYER_ACTIONS = Object.freeze([
  "play", "pause", "toggle", "restart",
  "seek", "seek_by", "volume", "mute", "unmute", "rate",
  "subtitles", "fullscreen",
  "next", "previous", "episode", "episodes",
]);

/** What each action wants in `value`, for the parser and for the tool's description. */
const VALUE_OF = Object.freeze({
  seek: "seconds",
  seek_by: "seconds",
  volume: "fraction",
  rate: "rate",
  subtitles: "label",
  fullscreen: "optional-boolean",
  episode: "index",
});

export const PLAYER_RATE = Object.freeze({ min: 0.25, max: 3 });

/** Bounds on what the window may report, so a snapshot cannot become a payload. */
const LIMITS = Object.freeze({ text: 512, episodes: 500, labels: 32 });

export class PlayerCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PlayerCommandError";
    this.code = code;
  }
}

function finite(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  return value.length > LIMITS.text ? value.slice(0, LIMITS.text) : value;
}

/**
 * The agent's request, checked. Every refusal names what was wrong and what
 * would have been right, because the result is read by a model that will try
 * again — "seek wants a number of seconds" is a correction; "bad request" is
 * a dead end.
 */
export function parsePlayerCommand(body) {
  const action = typeof body?.action === "string" ? body.action.trim().toLowerCase() : "";
  if (!PLAYER_ACTIONS.includes(action)) {
    throw new PlayerCommandError("PLAYER_ACTION_UNKNOWN",
      `"${action || "(none)"}" is not a player action. One of: ${PLAYER_ACTIONS.join(", ")}.`);
  }
  const raw = body?.value;
  const wants = VALUE_OF[action];
  if (!wants) return { action };

  switch (wants) {
    case "seconds": {
      const seconds = finite(typeof raw === "string" ? Number(raw) : raw);
      if (seconds === null) throw new PlayerCommandError("PLAYER_VALUE_REQUIRED", `\`${action}\` wants \`value\` as a number of seconds${action === "seek_by" ? " — negative to go back" : ""}.`);
      if (action === "seek" && seconds < 0) throw new PlayerCommandError("PLAYER_VALUE_REQUIRED", "`seek` wants a position at or after 0 seconds; use `seek_by` with a negative number to go back.");
      return { action, value: seconds };
    }
    case "fraction": {
      const fraction = finite(typeof raw === "string" ? Number(raw) : raw);
      if (fraction === null || fraction < 0 || fraction > 1) throw new PlayerCommandError("PLAYER_VALUE_REQUIRED", "`volume` wants `value` between 0 and 1.");
      return { action, value: fraction };
    }
    case "rate": {
      const rate = finite(typeof raw === "string" ? Number(raw) : raw);
      if (rate === null || rate < PLAYER_RATE.min || rate > PLAYER_RATE.max) {
        throw new PlayerCommandError("PLAYER_VALUE_REQUIRED", `\`rate\` wants \`value\` between ${PLAYER_RATE.min} and ${PLAYER_RATE.max}; 1 is normal speed.`);
      }
      return { action, value: rate };
    }
    case "label": {
      if (raw === false) return { action, value: "off" };
      if (raw === true || raw === undefined || raw === null) return { action, value: "on" };
      const label = text(String(raw).trim());
      if (!label) return { action, value: "on" };
      return { action, value: label };
    }
    case "optional-boolean": {
      if (raw === undefined || raw === null) return { action };
      if (typeof raw === "boolean") return { action, value: raw };
      if (raw === "true" || raw === "on") return { action, value: true };
      if (raw === "false" || raw === "off") return { action, value: false };
      throw new PlayerCommandError("PLAYER_VALUE_REQUIRED", "`fullscreen` takes `value` true or false, or no value to toggle.");
    }
    case "index": {
      const index = finite(typeof raw === "string" ? Number(raw) : raw);
      if (index === null || !Number.isInteger(index) || index < 1) throw new PlayerCommandError("PLAYER_VALUE_REQUIRED", "`episode` wants `value` as the episode's number, counting from 1 — the numbers `player` lists.");
      return { action, value: index };
    }
    default:
      return { action };
  }
}

/** One snapshot, with every field bounded and typed, or null when it is not one. */
export function sanitisePlayerSnapshot(input) {
  if (!input || typeof input !== "object") return null;
  const view = input.view === "episodes" ? "episodes" : "player";
  const kind = input.kind === "audio" ? "audio" : input.kind === "video" ? "video" : null;
  let series = null;
  if (input.series && typeof input.series === "object") {
    const episodes = Array.isArray(input.series.episodes) ? input.series.episodes.slice(0, LIMITS.episodes) : [];
    series = {
      folder: text(input.series.folder, ""),
      title: text(input.series.title, ""),
      index: Number.isInteger(input.series.index) ? input.series.index : null,
      count: Number.isInteger(input.series.count) ? input.series.count : episodes.length,
      episodes: episodes
        .filter((episode) => episode && typeof episode === "object")
        .map((episode) => ({
          index: Number.isInteger(episode.index) ? episode.index : 0,
          path: text(episode.path, ""),
          title: text(episode.title, ""),
          code: text(episode.code, null),
          duration: finite(episode.duration),
          watched: Math.min(1, Math.max(0, finite(episode.watched, 0))),
        })),
    };
  }
  const available = Array.isArray(input.subtitles?.available)
    ? input.subtitles.available.filter((label) => typeof label === "string").slice(0, LIMITS.labels).map((label) => text(label, ""))
    : [];
  return {
    view,
    path: text(input.path),
    title: text(input.title),
    kind,
    series,
    playing: input.playing === true,
    ended: input.ended === true,
    time: Math.max(0, finite(input.time, 0)),
    duration: finite(input.duration),
    volume: Math.min(1, Math.max(0, finite(input.volume, 1))),
    muted: input.muted === true,
    rate: finite(input.rate, 1),
    subtitles: { available, active: text(input.subtitles?.active) },
    fullscreen: input.fullscreen === true,
    error: text(input.error),
  };
}

/**
 * The last thing the window said its player was doing. One slot: the window
 * mounts one pane at a time, and a pane that unmounts reports null.
 */
export function createPlayerRegistry({ now = Date.now } = {}) {
  let current = null;
  return {
    report(input) {
      const snapshot = sanitisePlayerSnapshot(input);
      current = snapshot ? { ...snapshot, reportedAt: now() } : null;
      return current;
    },
    current() {
      return current;
    },
    clear() {
      current = null;
    },
  };
}

function clock(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return "?";
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const two = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`;
}

/** One sentence for a tool result, so the model need not parse the object to answer "what's playing?". */
export function describePlayer(snapshot) {
  if (!snapshot) return "No video or audio is open in the operator's editor.";
  if (snapshot.view === "episodes" && snapshot.series) {
    return `The episode gallery for "${snapshot.series.title}" is showing — ${snapshot.series.count} episodes, none playing. \`episode\` with a number starts one.`;
  }
  const where = snapshot.series && snapshot.series.index
    ? `episode ${snapshot.series.index} of ${snapshot.series.count} in "${snapshot.series.title}"`
    : `"${snapshot.title ?? snapshot.path ?? "a file"}"`;
  const state = snapshot.error ? `cannot play (${snapshot.error})` : snapshot.ended ? "finished" : snapshot.playing ? "playing" : "paused";
  const subtitles = snapshot.subtitles.active ? `, subtitles ${snapshot.subtitles.active}` : snapshot.subtitles.available.length > 0 ? ", subtitles off" : "";
  const sound = snapshot.muted ? ", muted" : "";
  const speed = snapshot.rate !== 1 ? `, at ${snapshot.rate}×` : "";
  return `Showing ${where}: ${state} at ${clock(snapshot.time)} of ${clock(snapshot.duration)}${subtitles}${sound}${speed}${snapshot.fullscreen ? ", fullscreen" : ""}.`;
}

export { LIMITS as PLAYER_SNAPSHOT_LIMITS };
