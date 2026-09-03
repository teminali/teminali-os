/**
 * Workspace panel model.
 *
 * The redesign replaces the old single-slot split view with a tab strip that
 * holds any number of panels of twelve kinds — terminal, browser, canvas, side
 * chat, file, guardian, the two agent CLIs, usage, benchmark, release (the
 * last of which the tab strip hides for non-administrators) and the video
 * editor. It lives in its
 * own store rather than inside
 * studioStore because it is pure view state: which panels exist, which one is
 * showing, and how wide the strip is. None of it belongs in the chat/session
 * store, and keeping it separate means a panel change does not re-render every
 * chat subscriber.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type PanelKind = "terminal" | "browser" | "canvas" | "side" | "file" | "guardian" | "claude" | "codex" | "usage" | "release" | "arena" | "video";

export interface PanelTab {
  id: string;
  kind: PanelKind;
  label: string;
  /** Workspace-relative path, for file panels. */
  path?: string;
  /** Current address, for browser panels. */
  url?: string;
  /** Working directory, for terminal and agent panels. */
  cwd?: string;
  createdAt: number;
}

/** Everything a caller may set when opening a panel. */
export type PanelSeed = Partial<Omit<PanelTab, "id" | "createdAt" | "kind">> & { kind: PanelKind };

export const PANEL_DEFAULTS: Record<PanelKind, { label: string; shortcut: string }> = {
  file: { label: "File", shortcut: "⌘G" },
  terminal: { label: "Terminal", shortcut: "⌘J" },
  browser: { label: "Browser", shortcut: "⇧⌘B" },
  canvas: { label: "Canvas", shortcut: "⇧⌘A" },
  side: { label: "New Side Chat", shortcut: "⇧⌘S" },
  guardian: { label: "Guardian", shortcut: "⇧⌘G" },
  // The two coding agents the operator already has installed, each in its own
  // tab the way an editor gives them one.
  claude: { label: "Claude Code", shortcut: "⇧⌘C" },
  codex: { label: "Codex", shortcut: "⇧⌘O" },
  usage: { label: "Usage", shortcut: "⇧⌘U" },
  // Administrators only; the tab strip hides it for everyone else.
  release: { label: "Release", shortcut: "⇧⌘R" },
  arena: { label: "Benchmark", shortcut: "⇧⌘N" },
  // The video editor, ported from Teminali Cut. One at a time: it owns a
  // timeline and a preview surface, and a second copy would be a second
  // project competing for the same playback clock.
  video: { label: "Video Editor", shortcut: "⇧⌘V" },
};

interface PanelState {
  panels: PanelTab[];
  activePanelId: string | null;
  /** Whether the panel region is showing at all. */
  isOpen: boolean;
  /** Panel takes the wider of its two widths. */
  isExpanded: boolean;
  width: number;
  /** The add-panel popover in the tab strip. */
  isAddMenuOpen: boolean;

  open: (seed: PanelSeed) => string;
  /** Open a panel of this kind, reusing an existing one when it matches. */
  focusOrOpen: (seed: PanelSeed) => string;
  close: (id: string) => void;
  closeAll: () => void;
  activate: (id: string) => void;
  update: (id: string, patch: Partial<PanelTab>) => void;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  toggleExpanded: () => void;
  setWidth: (width: number) => void;
  setAddMenuOpen: (open: boolean) => void;
}

const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 452;

let sequence = 0;
function panelId(): string {
  sequence += 1;
  return `panel-${Date.now().toString(36)}-${sequence}`;
}

/** Two panels are "the same" when reopening one should focus it, not duplicate it. */
function matches(panel: PanelTab, seed: PanelSeed): boolean {
  if (panel.kind !== seed.kind) return false;
  // A file panel is identified by its path; everything else by kind alone, so
  // that "open the browser" twice does not leave two browsers behind.
  if (seed.kind === "file") return Boolean(seed.path) && panel.path === seed.path;
  return seed.kind !== "side" && seed.kind !== "terminal";
}

export const usePanelStore = create<PanelState>()(
  persist(
    (set, get) => ({
      panels: [],
      activePanelId: null,
      isOpen: false,
      isExpanded: false,
      width: DEFAULT_WIDTH,
      isAddMenuOpen: false,

      open: (seed) => {
        const id = panelId();
        const tab: PanelTab = {
          id,
          kind: seed.kind,
          label: seed.label ?? PANEL_DEFAULTS[seed.kind].label,
          path: seed.path,
          url: seed.url,
          cwd: seed.cwd,
          createdAt: Date.now(),
        };
        set((state) => ({
          panels: [...state.panels, tab],
          activePanelId: id,
          isOpen: true,
          isAddMenuOpen: false,
        }));
        return id;
      },

      focusOrOpen: (seed) => {
        const existing = get().panels.find((panel) => matches(panel, seed));
        if (existing) {
          set((state) => ({
            activePanelId: existing.id,
            isOpen: true,
            isAddMenuOpen: false,
            // Reopening a browser at a new address should navigate it.
            panels: state.panels.map((panel) =>
              panel.id === existing.id
                ? { ...panel, ...(seed.url ? { url: seed.url } : {}), ...(seed.label ? { label: seed.label } : {}) }
                : panel,
            ),
          }));
          return existing.id;
        }
        return get().open(seed);
      },

      close: (id) =>
        set((state) => {
          const panels = state.panels.filter((panel) => panel.id !== id);
          // Closing the active panel falls back to the most recent survivor,
          // which is what the eye expects when a tab disappears.
          const activePanelId =
            state.activePanelId === id ? (panels.length ? panels[panels.length - 1].id : null) : state.activePanelId;
          return { panels, activePanelId };
        }),

      closeAll: () => set({ panels: [], activePanelId: null }),

      activate: (id) => set({ activePanelId: id, isAddMenuOpen: false }),

      update: (id, patch) =>
        set((state) => ({
          panels: state.panels.map((panel) => (panel.id === id ? { ...panel, ...patch } : panel)),
        })),

      setOpen: (open) => set({ isOpen: open, ...(open ? {} : { isAddMenuOpen: false }) }),

      toggleOpen: () => set((state) => ({ isOpen: !state.isOpen, isAddMenuOpen: false })),

      toggleExpanded: () => set((state) => ({ isExpanded: !state.isExpanded })),

      setWidth: (width) =>
        set(() => {
          if (typeof window === "undefined") return { width };
          /* The old clamp reserved 420px OF THE WINDOW for the chat and then
             let the sidebar spend 260 of it, so the conversation was squeezed
             to ~160px — the defect this replaces. The room the chat actually
             gets is the window minus the rail and sidebar, and both numbers
             are read from the shell rather than assumed, so the clamp follows
             the sidebar as it is dragged or collapsed. */
          const css = getComputedStyle(document.documentElement);
          const px = (name: string, fallback: number) => {
            const value = parseFloat(css.getPropertyValue(name));
            return Number.isFinite(value) ? value : fallback;
          };
          const room =
            window.innerWidth - px("--shell-left-inset", 260) - px("--chat-min-w", 420);
          return { width: Math.max(MIN_WIDTH, Math.min(width, Math.max(MIN_WIDTH, room))) };
        }),

      setAddMenuOpen: (open) => set({ isAddMenuOpen: open }),
    }),
    {
      name: "teminali-panels-v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        panels: state.panels,
        activePanelId: state.activePanelId,
        isOpen: state.isOpen,
        isExpanded: state.isExpanded,
        width: state.width,
      }),
    },
  ),
);

/** The panel currently on screen, or null. */
export function useActivePanel(): PanelTab | null {
  return usePanelStore((state) => state.panels.find((panel) => panel.id === state.activePanelId) ?? null);
}
