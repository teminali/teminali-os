import { create } from "zustand";

export type ActivityType = "cmd" | "edit" | "read" | "test";

export interface AssistantActivityItem {
  id: string;
  type: ActivityType;
  category?: "cmd" | "explore" | "edit" | "task" | "test" | "tool" | "video";
  timestamp: number;
  timeLabel?: string;
  title?: string;
  cmd?: string;
  result?: string;
  details?: string;
  output?: string;
  file?: string;
  badge?: "modify" | "create" | "delete" | "read";
  plus?: string;
  minus?: string;
  desc?: string;
  status?: "success" | "running" | "failed";
  count?: number;
  subItems?: Array<{ id?: string; text: string; status?: "completed" | "running" | "failed" }>;
}

export type CodingEngine = "codex" | "claude" | "gemini" | "frontier";

export interface AssistantActivityState {
  items: AssistantActivityItem[];
  /** Whether the CLI streaming panel is expanded above the chatbox. */
  isOpen: boolean;
  isPanelExpanded: boolean;
  selectedVoice: string;
  activeEngine: CodingEngine;
  isTaskRunning: boolean;
  currentTaskPrompt: string | null;
  latestProgress: string | null;
  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
  togglePanelExpanded: () => void;
  setPanelExpanded: (expanded: boolean) => void;
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

const VOICE_STORAGE_KEY = "temi.voice";

/**
 * Gemini's prebuilt voice names are one capitalised word ("Sulafat", "Aoede").
 * The retired Kokoro keys were lowercase with underscores ("royal_velvet"), and
 * sent as `voiceName` one of those would fail the session, so it is dropped.
 */
const isGeminiVoiceName = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z][a-z]+$/.test(value);

/** The pick survives a relaunch. Storage can be absent or throw; Sulafat then. */
export function readSavedVoice(): string {
  try {
    const saved = globalThis.localStorage?.getItem(VOICE_STORAGE_KEY);
    if (isGeminiVoiceName(saved)) return saved;
  } catch {
    // Blocked or missing storage is not an error worth surfacing.
  }
  return "Sulafat";
}

function saveVoice(voice: string): void {
  try {
    globalThis.localStorage?.setItem(VOICE_STORAGE_KEY, voice);
  } catch {
    // The pick still holds for this launch.
  }
}

export const useAssistantActivityStore = create<AssistantActivityState>((set) => ({
  items: INITIAL_ITEMS,
  isOpen: false,
  isPanelExpanded: false,
  selectedVoice: readSavedVoice(),
  activeEngine: "codex",
  isTaskRunning: false,
  currentTaskPrompt: null,
  latestProgress: null,
  toggleOpen: () => set((state) => ({ isOpen: !state.isOpen, isPanelExpanded: !state.isPanelExpanded })),
  setOpen: (isOpen) => set({ isOpen, isPanelExpanded: isOpen }),
  togglePanelExpanded: () => set((state) => ({ isPanelExpanded: !state.isPanelExpanded, isOpen: !state.isPanelExpanded })),
  setPanelExpanded: (isPanelExpanded) => set({ isPanelExpanded, isOpen: isPanelExpanded }),
  setSelectedVoice: (selectedVoice) => {
    if (isGeminiVoiceName(selectedVoice)) saveVoice(selectedVoice);
    set({ selectedVoice });
  },
  setActiveEngine: (activeEngine) => set({ activeEngine }),
  setTaskRunning: (isTaskRunning, prompt = null) =>
    set({
      isTaskRunning,
      currentTaskPrompt: isTaskRunning ? prompt : null,
      latestProgress: isTaskRunning ? "Starting task..." : null,
      // Auto-expand the CLI streaming drawer when a task starts running
      isPanelExpanded: isTaskRunning ? true : undefined,
      isOpen: isTaskRunning ? true : undefined,
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

if (typeof window !== "undefined") {
  (window as unknown as { __assistantActivityStore: typeof useAssistantActivityStore }).__assistantActivityStore =
    useAssistantActivityStore;
}
