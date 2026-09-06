import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PlaybackPosition } from "../services/workspaceGallery";
import type { PlayerSnapshot } from "../services/playerControl";

/**
 * What the player remembers between sessions, and what it is showing now.
 *
 * `positions` is the resume table — where each file was left, keyed by its
 * workspace-relative path and kept to the newest `MAX_POSITIONS` so a year of
 * watching does not grow the persisted blob without bound. `subtitle` is the
 * label the operator last chose, so the next episode comes up with the same
 * language showing. `autoplayNext` is the countdown at the end of an episode.
 *
 * `live` is not persisted: it is the current pane's snapshot, published for
 * anything in the window that wants to render it, and it is null the moment
 * the pane unmounts.
 */

export const MAX_POSITIONS = 200;

interface PlayerState {
  positions: Record<string, PlaybackPosition>;
  remember: (path: string, time: number, duration: number) => void;
  forget: (path: string) => void;
  subtitle: string | null;
  setSubtitle: (label: string | null) => void;
  autoplayNext: boolean;
  setAutoplayNext: (value: boolean) => void;
  live: PlayerSnapshot | null;
  setLive: (snapshot: PlayerSnapshot | null) => void;
}

function prune(positions: Record<string, PlaybackPosition>): Record<string, PlaybackPosition> {
  const entries = Object.entries(positions);
  if (entries.length <= MAX_POSITIONS) return positions;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_POSITIONS));
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set) => ({
      positions: {},
      remember: (path, time, duration) =>
        set((state) => ({
          positions: prune({ ...state.positions, [path]: { time, duration, at: Date.now() } }),
        })),
      forget: (path) =>
        set((state) => {
          if (!(path in state.positions)) return state;
          const positions = { ...state.positions };
          delete positions[path];
          return { positions };
        }),
      subtitle: null,
      setSubtitle: (subtitle) => set({ subtitle }),
      autoplayNext: true,
      setAutoplayNext: (autoplayNext) => set({ autoplayNext }),
      live: null,
      setLive: (live) => set({ live }),
    }),
    {
      name: "teminali-player-v1",
      partialize: (state) => ({ positions: state.positions, subtitle: state.subtitle, autoplayNext: state.autoplayNext }),
    },
  ),
);
