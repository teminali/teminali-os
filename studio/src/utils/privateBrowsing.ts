/**
 * What a private tab is allowed to leave behind, decided without touching
 * anything.
 *
 * Pure and dependency-free for the same reason `browserRecording.ts` is: this
 * is a promise made to the operator in the panel's own words — "the tab is not
 * reopened after a reload" — and a promise that can only be exercised by
 * quitting the app and starting it again is one nobody exercises.
 *
 * The rule itself is small and the reason is not. A private view lives on an
 * unprefixed Electron partition, which is in memory: its cookies and storage
 * go when the process does (electron/browserView.cjs). The *tab*, though, is a
 * renderer object in a persisted zustand store, so without this the address a
 * private tab was last on would be written to localStorage and reopened on the
 * next launch — the one place a private session cannot reach to clean up, and
 * the exact thing the mode says it does not do.
 */

/** The shape this needs of a panel; the store's `PanelTab` satisfies it. */
export interface PrivatablePanel {
  id: string;
  private?: boolean;
}

/**
 * The panels that may be written to disk, and which of them is still active.
 *
 * The active id is recomputed rather than kept, because dropping the panel it
 * points at would restore a session whose active tab does not exist — the last
 * remaining panel is the honest answer, and null when there is none.
 */
export function persistablePanels<T extends PrivatablePanel>(
  panels: T[],
  activePanelId: string | null,
): { panels: T[]; activePanelId: string | null } {
  const kept = panels.filter((panel) => panel.private !== true);
  if (kept.length === panels.length) return { panels, activePanelId };
  const stillThere = kept.some((panel) => panel.id === activePanelId);
  return {
    panels: kept,
    activePanelId: stillThere ? activePanelId : (kept[kept.length - 1]?.id ?? null),
  };
}
