/**
 * Every file the assistant wrote this session that nobody has ruled on yet.
 *
 * The assistant edits the working tree directly — that is the point of it — so
 * "review" here cannot mean staging a patch that has not landed. It means the
 * edit is on disk, it is listed, and one click puts the file back exactly as it
 * was. `before` is captured from the pre-edit read the writer already had to
 * do, so a reject is a restore rather than an inverse-patch that might not
 * apply.
 *
 * A store of its own rather than a slice of `studioStore` because the writers
 * are services (`liveEditService`) and the readers are chat components, and
 * neither should have to know about tabs, panels or profiles to reach it.
 *
 * NOT persisted. A `before` snapshot is only true of the disk it was read from;
 * restoring one across a restart, over whatever the operator did in between,
 * would be the worst kind of confident wrong.
 */

import { create } from "zustand";
import { changeTotals, recordChange, type ChangeTotals, type FileChange, type RecordChangeInput } from "../services/changeSet";
import { WorkspaceService } from "../services/workspaceService";
import { useStudioStore } from "./studioStore";

interface ChangeState {
  changes: FileChange[];
  /** The path a reject is currently writing, so its row can show it. */
  busyPath: string | null;
  error: string | null;
  /** The dock's file list; the summary bar is always visible. */
  expanded: boolean;
  /** The file whose diff is open, if any. */
  openPath: string | null;

  record: (input: RecordChangeInput) => void;
  accept: (path: string) => void;
  acceptAll: () => void;
  reject: (path: string) => Promise<void>;
  rejectAll: () => Promise<void>;
  clear: () => void;
  setExpanded: (expanded: boolean) => void;
  toggleOpen: (path: string) => void;
  totals: () => ChangeTotals;
}

/** Put the editor back in step with the disk after a reject. */
function syncEditor(change: FileChange, restored: { content: string; modified?: string; size?: number } | null) {
  const store = useStudioStore.getState();
  if (!restored) {
    // The file is gone; a tab pointed at it would be a view of nothing.
    const tab = store.tabs.find((entry) => entry.path === change.path);
    if (tab) store.closeTab(tab.id);
    return;
  }
  if (!store.tabs.some((entry) => entry.path === change.path)) return;
  store.syncFileContent({ path: change.path, content: restored.content, modified: restored.modified, size: restored.size });
}

export const useChangeStore = create<ChangeState>((set, get) => ({
  changes: [],
  busyPath: null,
  error: null,
  expanded: true,
  openPath: null,

  record: (input) =>
    set((state) => {
      const changes = recordChange(state.changes, input);
      return { changes, error: null, openPath: changes.some((change) => change.path === state.openPath) ? state.openPath : null };
    }),

  /* Accepting is bookkeeping. The bytes are already on disk — this only says
     the operator has seen them, which is why it cannot fail. */
  accept: (path) =>
    set((state) => ({
      changes: state.changes.filter((change) => change.path !== path),
      openPath: state.openPath === path ? null : state.openPath,
    })),

  acceptAll: () => set({ changes: [], openPath: null, error: null }),

  reject: async (path) => {
    const change = get().changes.find((entry) => entry.path === path);
    if (!change) return;
    set({ busyPath: path, error: null });
    try {
      if (change.existedBefore) {
        const restored = await WorkspaceService.writeFile(change.path, change.before);
        syncEditor(change, restored);
      } else {
        await WorkspaceService.deleteFile(change.path);
        syncEditor(change, null);
      }
      set((state) => ({
        changes: state.changes.filter((entry) => entry.path !== path),
        openPath: state.openPath === path ? null : state.openPath,
        busyPath: null,
      }));
    } catch (error) {
      // The row stays. A change that could not be undone must not disappear as
      // though it had been.
      set({ busyPath: null, error: error instanceof Error ? error.message : "The change could not be reverted." });
    }
  },

  rejectAll: async () => {
    // Sequential: each reject is a write, and firing a dozen at one gateway
    // that writes through a temp file and a rename is how you get half of them.
    for (const change of [...get().changes]) await get().reject(change.path);
  },

  clear: () => set({ changes: [], busyPath: null, error: null, openPath: null }),
  setExpanded: (expanded) => set({ expanded }),
  toggleOpen: (path) => set((state) => ({ openPath: state.openPath === path ? null : path })),
  totals: () => changeTotals(get().changes),
}));
