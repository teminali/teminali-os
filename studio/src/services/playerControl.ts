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
 *
 * ## One list, two engines
 *
 * Four of the actions — `frame_step`, `frame_back`, `chapter`, `audio_track` —
 * exist because mpv can do them (`electron/mpvProcess.cjs`), and a `<video>`
 * element cannot always do them for the file it happens to be showing.
 * Chromium plays a container's first audio track and offers no way to choose
 * another; it knows nothing about chapters; and it can only step a frame if
 * something told it the frame rate.
 *
 * The answer is *not* a second, shorter list for the pane, which would put the
 * same action in two contracts. It is `unsupported` in the snapshot below: the
 * pane says, per file, what it cannot do and why, and the gateway refuses
 * those before they are sent — so the model gets a sentence it can act on
 * instead of a "done" that moved nothing. An engine that can do everything
 * publishes an empty list and none of this is in the way.
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
  "seek", "seek_by", "frame_step", "frame_back", "chapter",
  "volume", "mute", "unmute", "rate",
  "subtitles", "audio_track", "fullscreen",
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
  /**
   * What this engine cannot do with *this* file, each with the sentence the
   * agent is given instead. Empty is the normal case; see the header.
   */
  unsupported: { action: PlayerAction; reason: string }[];
  /** What the player said when it could not play, or null. */
  error: string | null;
}

type Listener = (command: PlayerCommand) => void;
const listeners = new Set<Listener>();

/*
  ## The Set is per renderer, and stays that way

  A module-level `Set` holds one instance per renderer process, so a command
  sent in one window can never reach a listener registered in another. That has
  been written up as this file's bug, and `voice/temiMemoryStore.ts` names it
  in the comment on `resident` as the opposite of its own case. It was measured
  before it was fixed, and the measurement says it is not a live failure:

    - Three documents load this bundle. `electron/main.cjs:359` opens the studio
      window, `electron/assistant-overlay.cjs:86` opens the drawing layer with
      `?surface=overlay`, and `electron/screenRecorder.cjs:230` opens the bar
      with `?window=recorder-bar`. `src/main.tsx:164` renders `App` for the
      first and a single component for each of the other two.
    - Everything that dispatches (`StudioChat`, `AgentPane`, `aiService`,
      `voice/playerActions`) and everything that subscribes (`MediaPlayer`,
      `GalleryPane`) is inside `App`. Neither of the other two surfaces imports
      this module at all.
    - There is one studio window, not one per operator gesture. Every caller of
      `createWindow()` in `electron/main.cjs` (`second-instance`, `activate`,
      both trays, `activateAssistant`) checks first that `mainWindow` is gone.

  So the cross-renderer drop is latent, not live, and broadcasting over IPC to
  fix it would buy nothing and cost the invariant this file is built on: at
  most one player takes a command. A broadcast reaches every renderer, and the
  day a second studio window exists it would drive both players from one
  sentence, which is worse than dropping. The app already has a way to cross a
  process for this, and it is the one in the header: the pane publishes to the
  gateway, and the gateway comes back down the run's own stream. One player,
  one road, and a second road would need a notion of "the active player" that
  nothing in the app has.

  What was wrong, and is fixed below, is the answer rather than the delivery.
  `listeners.size > 0` answers "is a pane listening", and every caller reads it
  as "did a pane act". Those are different questions whenever the pane on
  screen ignores the action, which is not rare: `GalleryPane` acts on `episode`
  and `episodes` and drops the other eighteen, `MediaPlayer` drops `episode`,
  and its `runCommand` has no branch for `chapter` or `audio_track`. A `pause`
  said to the episode gallery returned true, so `aiService` reported delivered
  and Temi said it was done. That is the failure the header warns about, an
  action that reports success and moves nothing, arriving through the pane
  instead of through the gateway.
*/

/**
 * What a pane last said is on screen, which is how the dispatch below knows
 * whether anyone will act. Set by `publishPlayerState`, and separate from it
 * because the snapshot has two readers: the store and the gateway outward, and
 * this module inward. Null before any pane has published, and after one has
 * unmounted.
 */
let onScreen: PlayerSnapshot | null = null;

/** Records what is on screen. Called by `publishPlayerState`; see `onScreen`. */
export function notePlayerOnScreen(snapshot: PlayerSnapshot | null): void {
  onScreen = snapshot;
}

/** The pane that holds the player registers here for the turn's commands. */
export function subscribePlayerCommands(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether what is on screen will act on this command.
 *
 * Every rule here is read out of the snapshot the pane already publishes, not
 * invented: `unsupported` is the pane's own per-file, per-engine refusal list,
 * and `view` and `series` say which of the two listeners is mounted. The
 * gateway spends `unsupported` before it sends anything, but the chat and the
 * voice lane call `dispatchPlayerCommand` directly and never see it, so the
 * same list has to be spent here too or the two roads disagree.
 *
 * Silence is permission: with no snapshot, nothing is known about the pane and
 * refusing would invent a failure. A pane subscribes in one effect and
 * publishes in the next, and a command landing between the two is a real
 * ordering, so that window answers the way it always has.
 */
export function playerWillTake(command: PlayerCommand, snapshot: PlayerSnapshot | null): boolean {
  if (!snapshot) return true;
  if (snapshot.unsupported.some((entry) => entry.action === command.action)) return false;
  // The gallery, with nothing started. It owns the list and only the list.
  if (snapshot.view === "episodes") return command.action === "episode" || command.action === "episodes";
  // The player. It answers everything except `episode`, which belongs to the
  // gallery above it, and there is no gallery above a lone file.
  return command.action !== "episode" || snapshot.series !== null;
}

/** True when a mounted player took the command. */
export function dispatchPlayerCommand(command: PlayerCommand): boolean {
  if (listeners.size === 0) return false;
  if (!playerWillTake(command, onScreen)) return false;
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
  notePlayerOnScreen(snapshot);
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
