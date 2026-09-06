/**
 * Which search engine the browser panel uses.
 *
 * One preference, in its own store, persisted here rather than in the gateway.
 * `browserStore` deliberately holds nothing on disk — it is a cache of files
 * the gateway owns — and this is the opposite kind of thing: nobody else needs
 * to read it, it must survive a reload, and a round trip to answer "what does
 * the icon in the search box look like" would make the toolbar flicker.
 *
 * Main is told separately (see services/browserView.ts `announceSearchEngine`),
 * because the right-click menu's "Search … for" is drawn in another process
 * and cannot read this.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { DEFAULT_SEARCH_ENGINE_ID, searchEngineById, type SearchEngine } from "../utils/searchEngines";

interface SearchState {
  engineId: string;
  setEngine: (id: string) => void;
}

export const useSearchStore = create<SearchState>()(
  persist(
    (set) => ({
      engineId: DEFAULT_SEARCH_ENGINE_ID,
      setEngine: (id) => set({ engineId: searchEngineById(id).id }),
    }),
    {
      name: "teminali-search-engine",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/** The chosen engine itself, resolved. Never undefined — see `searchEngineById`. */
export function useSearchEngine(): SearchEngine {
  return useSearchStore((state) => searchEngineById(state.engineId));
}
