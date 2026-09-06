/**
 * The browser panel's page lives outside this document.
 *
 * In the desktop app the panel is a `WebContentsView` — its own web contents,
 * its own session, its own history — layered over the window by main rather
 * than framed inside the shell's renderer. See electron/browserView.cjs for
 * why. The consequence for this side is that the view is not in the DOM: it
 * cannot be positioned by CSS and nothing can be drawn on top of it. So the
 * pane measures its viewport and reports it, and reports `false` for visible
 * whenever the app draws over that rectangle — a menu, a modal — or whenever
 * the panel is not the one on screen.
 *
 * A browser build has no bridge and keeps the old iframe, which is why every
 * accessor here answers null rather than throwing.
 */

/** The panel toolbar's view of a page it does not own. */
export interface BrowserViewState {
  id: string;
  url?: string;
  title?: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  error?: string;
  /** Whether the page is making sound — the microphone's business, not the toolbar's. */
  audible?: boolean;
  /** The view is gone; sent once, so nothing keeps believing it is still playing. */
  closed?: boolean;
}

export type BrowserViewCommand = "back" | "forward" | "reload" | "stop";

/**
 * A file the panel is fetching, as main reports it.
 *
 * `done` is separate from `state` because an `interrupted` mid-flight can still
 * resume: only a `done` event is an outcome worth writing down.
 */
export interface BrowserDownload {
  downloadId: string;
  /** The panel whose page started it, or null if that view has since gone. */
  panelId: string | null;
  url: string;
  filename: string;
  state: "progressing" | "paused" | "interrupted" | "completed" | "cancelled";
  done: boolean;
  received: number;
  /** 0 when the server did not say how big the file is. */
  total: number;
  /** Where it was saved. Empty unless the download finished. */
  path: string;
}

export interface BrowserViewBridge {
  navigate(id: string, url: string): Promise<{ ok: boolean; reason?: string }>;
  /** The view for this panel, created at `url` only if it does not exist yet. */
  ensure(id: string, url: string): Promise<{ ok: boolean; reason?: string; existing?: boolean }>;
  setBounds(id: string, bounds: BrowserViewBounds, visible: boolean): void;
  command(id: string, command: BrowserViewCommand): void;
  destroy(id: string): void;
  destroyAll(): void;
  onState(handler: (state: BrowserViewState) => void): () => void;
  onDownload(handler: (download: BrowserDownload) => void): () => void;
  /** False when main did not itself save that path — see electron/browserView.cjs. */
  revealDownload(path: string): Promise<boolean>;
  /** Hand an http(s) address to the operator's real browser. */
  openExternal(url: string): Promise<boolean>;
}

export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The bridge, or null in a browser build — where the pane falls back to an iframe. */
export function browserViewBridge(): BrowserViewBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { teminali?: { browserView?: BrowserViewBridge } }).teminali?.browserView;
  return bridge ?? null;
}

/**
 * The viewport rectangle in CSS pixels of this document.
 *
 * Clamped to the window, because a view is an OS layer and does not clip to
 * the page: a panel scrolled or animated past the edge would otherwise paint
 * over whatever is beside the window. A zero-size rectangle is the signal to
 * hide rather than to draw a sliver.
 */
export function measureBrowserViewBounds(element: Element | null): BrowserViewBounds {
  if (!element) return { x: 0, y: 0, width: 0, height: 0 };
  const rect = element.getBoundingClientRect();
  const left = Math.min(Math.max(0, rect.left), window.innerWidth);
  const top = Math.min(Math.max(0, rect.top), window.innerHeight);
  const right = Math.min(window.innerWidth, Math.max(0, rect.right));
  const bottom = Math.min(window.innerHeight, Math.max(0, rect.bottom));
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(Math.max(0, right - left)),
    height: Math.round(Math.max(0, bottom - top)),
  };
}

export function boundsEqual(a: BrowserViewBounds | null, b: BrowserViewBounds): boolean {
  return Boolean(a) && a!.x === b.x && a!.y === b.y && a!.width === b.width && a!.height === b.height;
}

/**
 * Is the app drawing something over the panel right now?
 *
 * A view sits above the whole document, so a modal that dims the app would be
 * dimmed *by* the page it is supposed to cover. Every overlay in the shell is
 * either a `role="dialog"` (Modal) or a `role="menu"` (Menu), so asking the
 * document is both cheaper and more honest than threading a flag out of every
 * store that can open one.
 */
export function isOverlayOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[role="dialog"], [role="menu"]') !== null;
}

/**
 * Destroy the view of any panel that has been closed.
 *
 * The pane cannot do this itself: it unmounts both when its tab is closed and
 * when the operator merely switches tabs, and those must not mean the same
 * thing — switching away hides a page, closing a tab ends it. Only the store
 * knows which happened, so the reconciliation is a subscription to the store
 * rather than a component effect.
 */
export function reapClosedBrowserViews(store: {
  getState(): { panels: { id: string; kind: string }[] };
  subscribe(listener: (state: { panels: { id: string; kind: string }[] }) => void): () => void;
}): () => void {
  const bridge = browserViewBridge();
  if (!bridge) return () => {};
  let known = new Set(browserPanelIds(store.getState().panels));
  return store.subscribe((state) => {
    const present = new Set(browserPanelIds(state.panels));
    for (const id of known) if (!present.has(id)) bridge.destroy(id);
    known = present;
  });
}

function browserPanelIds(panels: { id: string; kind: string }[]): string[] {
  return panels.filter((panel) => panel.kind === "browser").map((panel) => panel.id);
}
