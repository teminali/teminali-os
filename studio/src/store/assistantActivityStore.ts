import { create } from "zustand";

export type ActivityType = "cmd" | "edit" | "read" | "test";

export interface AssistantActivityItem {
  id: string;
  type: ActivityType;
  timestamp: number;
  timeLabel?: string;
  cmd?: string;
  result?: string;
  file?: string;
  badge?: "modify" | "create" | "delete" | "read";
  plus?: string;
  minus?: string;
  desc?: string;
  status?: "success" | "running" | "failed";
}

export type CodingEngine = "codex" | "claude" | "gemini" | "frontier";

export interface AssistantActivityState {
  items: AssistantActivityItem[];
  /** Whether the activity dialog is open. Nothing opens it but a click. */
  isOpen: boolean;
  selectedVoice: string;
  activeEngine: CodingEngine;
  isTaskRunning: boolean;
  currentTaskPrompt: string | null;
  latestProgress: string | null;
  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
  setSelectedVoice: (voice: string) => void;
  setActiveEngine: (engine: CodingEngine) => void;
  setTaskRunning: (running: boolean, prompt?: string | null) => void;
  setLatestProgress: (progress: string | null) => void;
  logAction: (action: Omit<AssistantActivityItem, "id" | "timestamp">) => void;
  clearActivity: () => void;
}

/**
 * Empty on purpose.
 *
 * This list used to be seeded with three plausible-looking rows — a command
 * that exited 0, an edit of `+14 / -2` to diligenceEngine.ts — describing work
 * nobody had done. The voice narrates this feed (`activityPhrase.ts`,
 * `runProgressFromActivity.ts`), so on a cold start Temi could report a run
 * that never existed. The activity dialog has an empty state; use it.
 */
const INITIAL_ITEMS: AssistantActivityItem[] = [];

export const useAssistantActivityStore = create<AssistantActivityState>((set) => ({
  items: INITIAL_ITEMS,
  isOpen: false,
  selectedVoice: "royal_velvet",
  activeEngine: "codex",
  isTaskRunning: false,
  currentTaskPrompt: null,
  latestProgress: null,
  toggleOpen: () => set((state) => ({ isOpen: !state.isOpen })),
  setOpen: (isOpen) => set({ isOpen }),
  setSelectedVoice: (selectedVoice) => set({ selectedVoice }),
  setActiveEngine: (activeEngine) => set({ activeEngine }),
  setTaskRunning: (isTaskRunning, prompt = null) =>
    set({
      isTaskRunning,
      currentTaskPrompt: isTaskRunning ? prompt : null,
      latestProgress: isTaskRunning ? "Starting task..." : null,
    }),
  setLatestProgress: (latestProgress) => set({ latestProgress }),
  logAction: (action) =>
    set((state) => ({
      items: [
        {
          ...action,
          id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: Date.now(),
          timeLabel: "Just now",
        },
        ...state.items.slice(0, 49),
      ],
    })),
  clearActivity: () => set({ items: [] }),
}));
