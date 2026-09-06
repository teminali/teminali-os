/**
 * Workspace panel model.
 *
 * The redesign replaces the old single-slot split view with a tab strip that
 * holds any number of panels of twelve kinds — terminal, browser, canvas,
 * side chat, file, guardian, the two agent CLIs, usage, benchmark, release (the
 * last of which the tab strip hides for non-administrators) and the video
 * editor. The screen recorder is NOT among them: it is a dialog, because it is
 * something you do rather than somewhere you leave the app. See
 * `recorderDialogStore`. It lives in its
 * own store rather than inside
 * studioStore because it is pure view state: which panels exist, which one is
 * showing, and how wide the strip is. None of it belongs in the chat/session
 * store, and keeping it separate means a panel change does not re-render every
 * chat subscriber.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { persistablePanels } from "../utils/privateBrowsing";

export type PanelKind = "terminal" | "browser" | "canvas" | "side" | "file" | "gallery" | "guardian" | "claude" | "codex" | "usage" | "release" | "arena" | "video";

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
  /**
   * A browser tab on the in-memory session: nothing it visits is written down,
   * and the tab itself is not persisted. Settled when the tab opens — a view
   * cannot change session, so neither can this. See utils/privateBrowsing.ts.
   */
  private?: boolean;
  createdAt: number;
}

/** Everything a caller may set when opening a panel. */
export type PanelSeed = Partial<Omit<PanelTab, "id" | "createdAt" | "kind">> & { kind: PanelKind };

export const PANEL_DEFAULTS: Record<PanelKind, { label: string; shortcut: string }> = {
  file: { label: "File", shortcut: "⌘G" },
  /*
    Reached by clicking a folder, not from a menu, and so deliberately without
    a shortcut — every one an operator's fingers already know is taken, and
    ⇧⌘E in particular focuses the Explorer. Opened by `showFolder`, from a
    click in the tree or the agent's `open_file` on a folder.
  */
  gallery: { label: "Gallery", shortcut: "" },
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
  // "Editor", not "Video Editor": the title-bar control sits beside IDE, and
  // three words there crowded a strip whose other label is three letters. The
  // clapperboard beside it is what says which editor.
  video: { label: "Editor", shortcut: "⇧⌘V" },
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

/**
 * The widest the panel may be *right now*.
 *
 * The old clamp reserved 420px OF THE WINDOW for the chat and then let the
 * sidebar spend 260 of it, so the conversation was squeezed to ~160px — the
 * defect this replaces. The room the chat actually gets is the window minus
 * the rail and sidebar, and both numbers are read from the shell rather than
 * assumed, so the clamp follows the sidebar as it is dragged or collapsed.
 *
 * It is exported because a drag is not the only way a panel gets too wide: a
 * width restored from a session on a wider window, and a window dragged
 * narrower afterwards, both arrive without passing through `setWidth`.
 */
export function clampPanelWidth(width: number): number {
  if (typeof window === "undefined") return width;
  const css = getComputedStyle(document.documentElement);
  const px = (name: string, fallback: number) => {
    const value = parseFloat(css.getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  };

  /* Where the conversation actually starts, and what sits between it and the
     panel, are measured rather than derived. `--shell-left-inset` stops at the
     sidebar's edge and so counts neither splitter, and those two 2px gutters
     are exactly the amount by which a derived clamp still put the panel off
     the screen. Before first paint — and while an expanded panel has the chat
     hidden — there is nothing to measure, and the inset is the right answer. */
  const chat = document.querySelector("[data-chat-column]")?.getBoundingClientRect();
  const panel = document.querySelector("[data-workspace-panel]")?.getBoundingClientRect();
  const laidOut = chat !== undefined && chat.width > 0;
  const left = laidOut ? chat.left : px("--shell-left-inset", 260);
  const gutter = laidOut && panel !== undefined ? Math.max(0, panel.left - chat.right) : 0;

  const room = window.innerWidth - left - px("--chat-min-w", 420) - gutter;
  return Math.max(MIN_WIDTH, Math.min(width, Math.max(MIN_WIDTH, room)));
}

let sequence = 0;
function panelId(): string {
  sequence += 1;
  return `panel-${Date.now().toString(36)}-${sequence}`;
}

/** Two panels are "the same" when reopening one should focus it, not duplicate it. */
function matches(panel: PanelTab, seed: PanelSeed): boolean {
  if (panel.kind !== seed.kind) return false;
  // A file panel is identified by its path; everything else by kind alone, so
  // that "open the usage panel" twice does not leave two behind. Terminals,
  // side chats and browser tabs are the kinds there may be many of.
  if (seed.kind === "file") return Boolean(seed.path) && panel.path === seed.path;
  // The gallery is one panel that navigates, like a browser with no tabs:
  // matching on kind alone means clicking through six folders leaves one tab
  // rather than six. `focusOrOpen` moves it to the new folder.
  if (seed.kind === "gallery") return true;
  return seed.kind !== "side" && seed.kind !== "terminal" && seed.kind !== "browser";
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
          private: seed.private,
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
                ? {
                  ...panel,
                  ...(seed.url ? { url: seed.url } : {}),
                  ...(seed.label ? { label: seed.label } : {}),
                  // A gallery reopened on another folder navigates to it. The
                  // root is a real destination, so an empty path is honoured
                  // rather than treated as "no path given".
                  ...(seed.kind === "gallery" ? { path: seed.path ?? "" } : {}),
                }
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

      /* A drag records an intent the operator could actually express, so it is
         clamped on the way in. Everything else is clamped on the way out, by
         `WorkspacePanel`, which leaves the chosen width intact in the store. */
      setWidth: (width) => set(() => ({ width: clampPanelWidth(width) })),

      setAddMenuOpen: (open) => set({ isAddMenuOpen: open }),
    }),
    {
      name: "teminali-panels-v1",
      storage: createJSONStorage(() => localStorage),
      /*
        A stored session can hold a tab of a kind this build no longer has:
        "recorder", from when the recorder was a panel rather than a dialog,
        and "series", the name the gallery went by for an afternoon. Left
        alone neither crashes — `WorkspacePanel` falls through and the tab
        strip draws a document glyph — but the operator gets a tab labelled
        "Record Screen" or "Series" that opens onto nothing.

        The filter is now the *live* set of kinds rather than a list of dead
        names, so the next rename is handled by the rename itself. It has to
        happen on the way OUT of storage rather than in the reducers, because
        nothing ever calls a reducer for a panel that was simply restored.
      */
      version: 3,
      migrate: (persisted) => {
        const state = persisted as { panels?: { id: string; kind: string }[]; activePanelId?: string | null };
        if (!state?.panels) return state;
        const known = new Set(Object.keys(PANEL_DEFAULTS));
        const panels = state.panels.filter((panel) => known.has(panel.kind));
        const kept = new Set(panels.map((panel) => panel.id));
        return {
          ...state,
          panels,
          activePanelId:
            state.activePanelId && kept.has(state.activePanelId)
              ? state.activePanelId
              : panels.length > 0
                ? panels[panels.length - 1].id
                : null,
        };
      },
      /* A private tab is not written down — see utils/privateBrowsing.ts. The
         filter is here rather than in `close`, because nothing calls a reducer
         for a panel that was simply still open when the app quit. */
      partialize: (state) => ({
        ...persistablePanels(state.panels, state.activePanelId),
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
