/**
 * Where a search goes, and what to call it.
 *
 * Pure and dependency-free, like `address.ts` beside it, because three
 * separate surfaces have to agree on the answer: the home page's field, the
 * omnibox's first suggestion, and the right-click menu in main — which is a
 * different process and cannot import a React store.
 *
 * The list is short on purpose. An address bar that offers thirty engines is
 * an address bar with a settings screen in it; these five are the ones a
 * person is likely to have an opinion about, and any other search is one URL
 * typed into the same bar.
 *
 * Each engine is a query prefix rather than a template with a hole in it. The
 * prefix is also how a *finished* URL is recognised as a search, which is what
 * lets a tab be labelled with the words that were searched for rather than
 * with the engine's hostname.
 */

export interface SearchEngine {
  id: string;
  name: string;
  /** The query is percent-encoded and appended to this. */
  query: string;
  /**
   * The engine's own address, which is what its mark is derived from.
   *
   * Derived, not fetched — the same rule the bookmark tiles follow
   * (`utils/siteMark.ts`). A favicon pulled from the engine would be the real
   * logo at the cost of telling that engine the panel is open, which is a
   * strange price to pay for a picture of a letter.
   */
  home: string;
}

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: "google", name: "Google", query: "https://www.google.com/search?q=", home: "https://www.google.com" },
  { id: "bing", name: "Bing", query: "https://www.bing.com/search?q=", home: "https://www.bing.com" },
  { id: "duckduckgo", name: "DuckDuckGo", query: "https://duckduckgo.com/?q=", home: "https://duckduckgo.com" },
  { id: "brave", name: "Brave Search", query: "https://search.brave.com/search?q=", home: "https://search.brave.com" },
  { id: "perplexity", name: "Perplexity", query: "https://www.perplexity.ai/search?q=", home: "https://www.perplexity.ai" },
];

export const DEFAULT_SEARCH_ENGINE_ID = "google";

/**
 * The engine with this id, or Google.
 *
 * Never throws and never returns undefined: this is read while rendering a
 * toolbar, and a persisted id from a build that offered an engine this one
 * does not must degrade to a working search rather than to a blank field.
 */
export function searchEngineById(id: string | null | undefined): SearchEngine {
  return SEARCH_ENGINES.find((engine) => engine.id === id) ?? SEARCH_ENGINES[0];
}

/** The address a search for `query` goes to. */
export function searchUrlWith(engine: SearchEngine, query: string): string {
  return `${engine.query}${encodeURIComponent(query.trim())}`;
}

/**
 * The words a search URL was for, or null if it is not one.
 *
 * Checked against every engine rather than only the current one: switching
 * engines must not rename the tabs that are already open.
 */
export function searchQueryOf(url: string): string | null {
  const engine = SEARCH_ENGINES.find((candidate) => url.startsWith(candidate.query));
  if (!engine) return null;
  try {
    return new URL(url).searchParams.get("q");
  } catch {
    return null;
  }
}
