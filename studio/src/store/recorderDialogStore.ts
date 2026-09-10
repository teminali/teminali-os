/**
 * Whether the screen recorder dialog is showing.
 *
 * A store of its own, and it holds exactly one boolean, because the two
 * things that open the recorder are nowhere near each other in the tree:
 * the File menu listener in `App.tsx` and the pill on the empty-chat
 * screen, now `TemiActionRow` in `components/voice/TemiComposer.tsx`.
 * Drilling a callback from `App` down to the pill would thread it through
 * four components that have no other reason to know the recorder exists.
 *
 * NOT persisted, and that is the difference from `panelStore`. A workspace
 * panel is somewhere you left the app; a modal is something you are doing.
 * Restoring a session into a recorder dialog nobody asked for — over the
 * conversation they actually came back to — is the failure mode this
 * avoids, and it is why the recorder stopped being a panel.
 */

import { create } from "zustand";

interface RecorderDialogState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useRecorderDialogStore = create<RecorderDialogState>((set) => ({
  isOpen: false,
  /* Idempotent on purpose. The menu item and the pill can both fire while
     the dialog is already up — and a take may be running inside it, which
     `RecorderPanel` guards on mount. Re-opening must not remount it. */
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
