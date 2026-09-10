/**
 * The browser panel's own preferences.
 *
 * On disk here for the same reason the search engine is
 * (`store/searchStore.ts`): nobody else needs to read it, it must survive a
 * reload, and asking the gateway "is the bookmark bar showing" would make the
 * toolbar flicker on every mount. `browserStore` is the wrong home — it holds
 * nothing on disk on purpose, because it is a cache of files the gateway owns,
 * and this is the opposite kind of thing.
 *
 * One preference per pane it affects, and it is shared by every pane: a bar
 * shown in one tab and hidden in the next would read as a bug rather than as a
 * per-tab choice. Chrome makes the same call.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface BrowserPrefsState {
  /** Whether the strip of bookmarks under the toolbar is drawn. */
  bookmarkBar: boolean;
  toggleBookmarkBar: () => void;
}

export const useBrowserPrefsStore = create<BrowserPrefsState>()(
  persist(
    (set, get) => ({
      // Off by default: a new operator has no bookmarks, and an empty strip
      // under the toolbar is a row of nothing eating the page's height.
      bookmarkBar: false,
      toggleBookmarkBar: () => set({ bookmarkBar: !get().bookmarkBar }),
    }),
    {
      name: "teminali-browser-prefs",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
