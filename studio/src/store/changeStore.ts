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
 *
 * A change nobody rules on is **kept**. Accepting is the default in every
 * direction: unreviewed rows sit here until the operator acts, closing the app
 * leaves every byte on disk, and a set that outgrows `MAX_PENDING_CHANGES` ages
 * its oldest rows out rather than reverting them. Nothing in this store ever
 * un-writes a file except `reject`, which the operator asked for by name.
 */

import { create } from "zustand";
import { changeTotals, planReject, recordChange, trimChanges, type ChangeTotals, type DiskState, type FileChange, type RecordChangeInput } from "../services/changeSet";
import { WorkspaceService } from "../services/workspaceService";
import { useStudioStore } from "./studioStore";

interface ChangeState {
  changes: FileChange[];
  /** The path a reject is currently writing, so its row can show it. */
  busyPath: string | null;
  error: string | null;
  /**
   * Changes aged out of the set to keep it bounded. They were **accepted**:
   * their bytes are on disk and stay there. Counted rather than dropped
   * silently, so the dock can say the offer to revert them has expired.
   */
  autoAccepted: number;
  /** The dock's file list; the summary bar is always visible. */
  expanded: boolean;
  /** The file whose diff is open, if any. */
  openPath: string | null;

  record: (input: RecordChangeInput) => void;
  accept: (path: string) => void;
  acceptAll: () => void;
  /** Resolves with the reason it could not be reverted, or null on success. */
  reject: (path: string) => Promise<string | null>;
  rejectAll: () => Promise<void>;
  clear: () => void;
  /** Acknowledge the aged-out count; it is a notice, not a pending item. */
  dismissAutoAccepted: () => void;
  setExpanded: (expanded: boolean) => void;
  toggleOpen: (path: string) => void;
  totals: () => ChangeTotals;
}

/**
 * Put the editor back in step with the disk after a reject.
 *
 * A dirty tab is never written over and never closed. Its buffer is the
 * operator's own unsaved text, and discarding that to undo the assistant's work
 * would trade one loss for another — so a tab left pointing at a deleted file
 * stays open as an unsaved buffer they can still save back.
 */
function syncEditor(change: FileChange, restored: { content: string; modified?: string; size?: number } | null) {
  const store = useStudioStore.getState();
  const tab = store.tabs.find((entry) => entry.path === change.path);
  if (!tab) return;
  if (!restored) {
    if (!tab.isDirty) store.closeTab(tab.id);
    return;
  }
  // `syncFileContent` skips a dirty tab of its own accord.
  store.syncFileContent({ path: change.path, content: restored.content, modified: restored.modified, size: restored.size });
}

/** True for the gateway's "there is no such file", which is an answer, not a fault. */
function isMissing(error: unknown): boolean {
  const failure = error as { code?: string; status?: number } | null;
  return failure?.code === "WORKSPACE_FILE_NOT_FOUND" || failure?.status === 404;
}

/** What the disk holds for a path right now. Null when nothing is there. */
async function readDisk(path: string): Promise<DiskState | null> {
  try {
    const file = await WorkspaceService.readFile(path);
    // A change is only ever recorded for a text file. Anything else means the
    // path is not the one this row describes, and comparing base64 to source
    // would "differ" for the wrong reason.
    if (file.encoding !== "utf8") throw new Error(`${file.name} is no longer a text file.`);
    return { content: file.content, modified: file.modified };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The change could not be reverted.";
}

export const useChangeStore = create<ChangeState>((set, get) => ({
  changes: [],
  busyPath: null,
  error: null,
  autoAccepted: 0,
  expanded: true,
  openPath: null,

  record: (input) =>
    set((state) => {
      const { changes, dropped } = trimChanges(recordChange(state.changes, input));
      return {
        changes,
        error: null,
        autoAccepted: state.autoAccepted + dropped,
        openPath: changes.some((change) => change.path === state.openPath) ? state.openPath : null,
      };
    }),

  /* Accepting is bookkeeping. The bytes are already on disk — this only says
     the operator has seen them, which is why it cannot fail. */
  accept: (path) =>
    set((state) => ({
      changes: state.changes.filter((change) => change.path !== path),
      openPath: state.openPath === path ? null : state.openPath,
    })),

  acceptAll: () => set({ changes: [], openPath: null, error: null, autoAccepted: 0 }),

  reject: async (path) => {
    const change = get().changes.find((entry) => entry.path === path);
    if (!change) return null;
    // One at a time. Two rejects in flight would each read the disk before the
    // other wrote it, and both would then believe their `before` was current.
    if (get().busyPath) return null;
    set({ busyPath: path, error: null });
    try {
      const plan = planReject(change, await readDisk(change.path));
      if (plan.action === "refuse") throw new Error(plan.reason);

      if (plan.action === "restore") {
        // `expectedModified` closes the last gap: the file can still change
        // between the read above and this write, and the gateway answers 409
        // rather than letting the restore land on top of it.
        const restored = await WorkspaceService.writeFile(change.path, plan.content, plan.expectedModified);
        syncEditor(change, restored);
      } else {
        if (plan.action === "delete") await WorkspaceService.deleteFile(change.path);
        syncEditor(change, null);
      }

      set((state) => ({
        changes: state.changes.filter((entry) => entry.path !== path),
        openPath: state.openPath === path ? null : state.openPath,
        busyPath: null,
      }));
      return null;
    } catch (error) {
      // The row stays. A change that could not be undone must not disappear as
      // though it had been.
      const reason = messageFor(error);
      set({ busyPath: null, error: reason });
      return reason;
    }
  },

  rejectAll: async () => {
    // Sequential: each reject is a write, and firing a dozen at one gateway
    // that writes through a temp file and a rename is how you get half of them.
    const failures: string[] = [];
    for (const change of [...get().changes]) {
      const reason = await get().reject(change.path);
      if (reason) failures.push(reason);
    }
    // Each reject writes its own failure into `error` and the next one clears
    // it, so without this the operator is told about one refusal when there
    // were four — and the rows that stayed behind would look unexplained.
    if (failures.length > 0) {
      set({
        error: failures.length === 1
          ? failures[0]
          : `${failures.length} files were left as they are. ${failures[0]}`,
      });
    }
  },

  clear: () => set({ changes: [], busyPath: null, error: null, openPath: null, autoAccepted: 0 }),
  dismissAutoAccepted: () => set({ autoAccepted: 0 }),
  setExpanded: (expanded) => set({ expanded }),
  toggleOpen: (path) => set((state) => ({ openPath: state.openPath === path ? null : path })),
  totals: () => changeTotals(get().changes),
}));
