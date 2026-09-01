import { create } from "zustand";

export interface ProjectData {
  id: string;
  title: string;
  fps: number;
  width: number;
  height: number;
}

export interface Clip {
  id: string;
  trackId: string;
  startSec: number;
  durationSec: number;
}

interface ProjectSlice {
  project: ProjectData;
  updateTitle: (title: string) => void;
  updateResolution: (width: number, height: number) => void;
}

interface TimelineSlice {
  currentTimeSec: number;
  clips: Clip[];
  seek: (time: number) => void;
  addClip: (clip: Clip) => void;
  removeClip: (id: string) => void;
}

export const useStudioStore = create<ProjectSlice & TimelineSlice>((set) => ({
  // Project State
  project: {
    id: "proj_01",
    title: "Untitled Commercial",
    fps: 60,
    width: 3840,
    height: 2160,
  },
  updateTitle: (title) => set((s) => ({ project: { ...s.project, title } })),
  updateResolution: (width, height) => set((s) => ({ project: { ...s.project, width, height } })),

  // Timeline State
  currentTimeSec: 0,
  clips: [
    { id: "c1", trackId: "V1", startSec: 0, durationSec: 5.2 },
    { id: "c2", trackId: "A1", startSec: 0, durationSec: 5.2 },
  ],
  seek: (time) => set({ currentTimeSec: Math.max(0, Math.min(time, 1000)) }),
  addClip: (clip) => set((s) => ({ clips: [...s.clips, clip] })),
  removeClip: (id) => set((s) => ({ clips: s.clips.filter((c) => c.id !== id) })),
}));
