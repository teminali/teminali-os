/**
 * The media player, from the outside.
 *
 * Two channels, both one-way, and that is the design. The pane that owns a
 * `<video>` *publishes* what it is showing — here, to the store's `live`
 * snapshot and, throttled, to the gateway's `/api/workspace/player/state` —
 * and the gateway hands that snapshot to the agent's `player` tool. The agent's
 * `player_control` goes the other way: the gateway puts a `player` event on
 * the run's own NDJSON stream (the only channel back to the window during a
 * turn, see `emitToRun`), `agentCliService` dispatches it here, and whichever
 * pane holds the player executes it. There is at most one: `WorkspacePanel`
 * mounts the active panel's pane and no other.
 *
 * The action list is spelled in `server/player-state.js` too, and
 * `tests/player-state.test.mjs` asserts the two are the same list — an action
 * the gateway accepts and the pane ignores is a tool call that reports success
 * and does nothing.
 */

/*
  No top-level runtime imports, deliberately. The action list below is the
  contract `server/player-state.js` is checked against by
  `tests/player-state.test.mjs`, which runs under plain node — a module that
  pulled in the gateway client and a zustand store at load would drag the
  whole renderer in with it. Both are imported where they are used instead;
  `services/workspaceMedia.ts` does the same, for the same reason.
*/

export const PLAYER_ACTIONS = [
  "play", "pause", "toggle", "restart",
  "seek", "seek_by", "volume", "mute", "unmute", "rate",
  "subtitles", "fullscreen",
  "next", "previous", "episode", "episodes",
] as const;

export type PlayerAction = (typeof PLAYER_ACTIONS)[number];

export interface PlayerCommand {
  action: PlayerAction;
  value?: number | string | boolean;
}

export interface PlayerEpisodeSummary {
  index: number;
  path: string;
  title: string;
  code: string | null;
  /** Seconds, once the card has read the file's header; null before. */
  duration: number | null;
  /** 0–1 of it the operator has watched. */
  watched: number;
}

export interface PlayerSnapshot {
  /** The gallery of episodes, or the player itself. */
  view: "player" | "episodes";
  path: string | null;
  title: string | null;
  kind: "video" | "audio" | null;
  series: {
    folder: string;
    title: string;
    /** 1-based index of the episode in the player, or null on the gallery. */
    index: number | null;
    count: number;
    episodes: PlayerEpisodeSummary[];
  } | null;
  playing: boolean;
  ended: boolean;
  time: number;
  duration: number | null;
  volume: number;
  muted: boolean;
  rate: number;
  subtitles: { available: string[]; active: string | null };
  fullscreen: boolean;
  /** What the player said when it could not play, or null. */
  error: string | null;
}

type Listener = (command: PlayerCommand) => void;
const listeners = new Set<Listener>();

/** The pane that holds the player registers here for the turn's commands. */
export function subscribePlayerCommands(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when a mounted player took the command. */
export function dispatchPlayerCommand(command: PlayerCommand): boolean {
  if (listeners.size === 0) return false;
  for (const listener of listeners) listener(command);
  return true;
}

/*
  Publishing.

  A playing video changes four times a second. The store gets every snapshot,
  because a hook subscribed to `live` is cheap; the gateway gets one at most
  every second, plus one *immediately* for anything discrete — play, pause, a
  seek landing, a track change, another episode — so an agent that just asked
  for a pause reads "paused" and not the frame before it.
*/
const QUIET_MS = 1000;
let pending: PlayerSnapshot | null | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;

async function send(snapshot: PlayerSnapshot | null): Promise<void> {
  try {
    const { GatewayClient } = await import("./gatewayClient");
    await GatewayClient.request("/api/workspace/player/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ player: snapshot }),
    });
  } catch {
    /* The gateway is the agent's window onto the player, not the operator's; a missed report is not worth a toast. */
  }
}

function flush(): void {
  timer = null;
  if (pending === undefined) return;
  const snapshot = pending;
  pending = undefined;
  void send(snapshot);
  timer = setTimeout(flush, QUIET_MS);
}

export function publishPlayerState(snapshot: PlayerSnapshot | null, options: { immediate?: boolean } = {}): void {
  void import("../store/playerStore").then(({ usePlayerStore }) => usePlayerStore.getState().setLive(snapshot));
  pending = snapshot;
  if (options.immediate || snapshot === null) {
    if (timer) clearTimeout(timer);
    timer = null;
    flush();
    return;
  }
  if (!timer) flush();
}

/** Clamp helpers shared by the pane and the keyboard, so a key and a tool agree on the limits. */
export const PLAYER_LIMITS = Object.freeze({ minRate: 0.25, maxRate: 3, seekStep: 10, volumeStep: 0.1 });

export function clampRate(rate: number): number {
  return Math.min(PLAYER_LIMITS.maxRate, Math.max(PLAYER_LIMITS.minRate, rate));
}

export function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, volume));
}
