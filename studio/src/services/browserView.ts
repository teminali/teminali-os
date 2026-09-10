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
  /**
   * The view is on the in-memory session, so nothing about it is written down.
   * Reported by main rather than read from the tab, because the tab is a
   * renderer object and the session is the thing that actually decides.
   */
  private?: boolean;
  /**
   * The page asked for a passkey and no platform authenticator answered.
   *
   * Not a failure of the page or of the request. On Windows and Linux there is
   * no platform authenticator in this app at all; on macOS a signed build has
   * Touch ID and this never arrives, which is the point. Main clears it on the
   * next navigation. See electron/browserView.cjs.
   */
  passkey?: boolean;
  /**
   * A passkey request that matched several credentials and is waiting to be
   * told which. Null once it is answered, cancelled or gone stale.
   */
  webauthn?: BrowserWebauthnRequest | null;
}

/** One credential the operator may sign in with. Text written by the site. */
export interface BrowserWebauthnAccount {
  credentialId: string;
  name?: string;
  displayName?: string;
}

/**
 * A choice main is holding a page's promise open for.
 *
 * The page is blocked until `chooseWebauthnAccount` answers with the
 * `requestId`, so this is one of the few pieces of view state the pane must
 * act on rather than merely draw.
 */
export interface BrowserWebauthnRequest {
  requestId: string;
  relyingPartyId: string;
  accounts: BrowserWebauthnAccount[];
}

/** What a view is made with. Settled when the tab opens; a navigation cannot change it. */
export interface BrowserViewOptions {
  /** Put the view on the in-memory session shared by every private tab. */
  private?: boolean;
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
  /** It came from a private tab: shown while it arrives, then not written down. */
  private?: boolean;
}

export interface BrowserViewBridge {
  navigate(id: string, url: string, options?: BrowserViewOptions): Promise<{ ok: boolean; reason?: string }>;
  /** The view for this panel, created at `url` only if it does not exist yet. */
  ensure(id: string, url: string, options?: BrowserViewOptions): Promise<{ ok: boolean; reason?: string; existing?: boolean }>;
  setBounds(id: string, bounds: BrowserViewBounds, visible: boolean): void;
  command(id: string, command: BrowserViewCommand): void;
  /**
   * Read or drive this panel's page through the DevTools Protocol.
   *
   * The op is named, never a CDP method — see electron/browserCdp.cjs, which is
   * the only thing in the app that speaks the protocol. Always resolves: a
   * refusal is `ok: false` with a message meant for the agent that asked.
   */
  cdp(id: string, op: BrowserCdpOp, params?: BrowserCdpParams): Promise<BrowserCdpAnswer>;
  /**
   * The operator's own screenshot: the whole page, as a PNG, wherever they say.
   *
   * Not the agent's `page_screenshot`, which is a jpeg of the viewport sized for
   * a model's context. Main shows the save dialog, so a dismissed dialog comes
   * back as `cancelled` rather than as an error — the pane must not draw that as
   * a failure.
   */
  screenshot(id: string): Promise<BrowserScreenshotAnswer>;
  /** Cookies or the cache, on both sessions. History is the gateway's — see store/browserStore.ts. */
  clearData(kind: BrowserClearKind): Promise<{ ok: boolean; error?: string }>;
  destroy(id: string): void;
  destroyAll(): void;
  /** Answer a passkey chooser. `null` cancels, and the page sees a NotAllowedError. */
  chooseWebauthnAccount(requestId: string, credentialId: string | null): void;
  onState(handler: (state: BrowserViewState) => void): () => void;
  onDownload(handler: (download: BrowserDownload) => void): () => void;
  /** False when main did not itself save that path — see electron/browserView.cjs. */
  revealDownload(path: string): Promise<boolean>;
  /** Hand an http(s) address to the operator's real browser. */
  openExternal(url: string): Promise<boolean>;
  /** Tell main which engine the right-click menu's "Search … for" means. */
  setSearchEngine(engine: { name: string; query: string }): void;
}

/**
 * The operations the browser panel's CDP channel answers.
 *
 * One per agent tool, and the names are the tool names minus their `page_`
 * prefix. Kept as a union rather than a string so that adding a tool without
 * adding a handler in electron/browserView.cjs is a typecheck failure.
 */
export type BrowserCdpOp = "snapshot" | "read" | "screenshot" | "click" | "type" | "network" | "eval";

export interface BrowserCdpParams {
  /** A `ref` from the last snapshot, for "click" and "type". */
  ref?: string;
  text?: string;
  /** Press Enter after typing — for a field that only reacts to a keystroke. */
  submit?: boolean;
  button?: "left" | "right" | "middle";
  fullPage?: boolean;
  limit?: number;
  filter?: string;
  expression?: string;
}

/**
 * What the panel can clear, and what it deliberately cannot.
 *
 * Two words, because each has one honest meaning in main
 * (`clearDataPlan` in electron/browserView.cjs). "history" is absent on
 * purpose: it is a gateway file the assistant reads, not session state, and it
 * goes through `browserStore.clearHistory`.
 */
export type BrowserClearKind = "cookies" | "cache";

/** Where the screenshot went, or why it did not. `cancelled` is neither. */
export interface BrowserScreenshotAnswer {
  ok: boolean;
  /** Where the operator saved it. Absent unless it was saved. */
  path?: string;
  /** The save dialog was dismissed. Not an error, and not worth a message. */
  cancelled?: boolean;
  error?: string;
}

/** Always resolved. `ok: false` carries a message written for the agent. */
export interface BrowserCdpAnswer {
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
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
 * dimmed *by* the page it is supposed to cover. Every overlay in the shell
 * carries a role, so asking the document is both cheaper and more honest than
 * threading a flag out of every store that can open one.
 *
 * `alertdialog` is in the list because leaving it out cost the one prompt that
 * could least afford it: `MediaConsentModal` is marked up correctly and asks
 * for the camera and the microphone, and a page was drawn over it — an
 * operator granting a device to something they cannot see. A role that means
 * "modal" must be matched however ARIA spells it, so the roles live in one
 * named constant that the source guard in `tests/overlay-roles.test.mjs`
 * checks every hand-rolled overlay against.
 */
export const OVERLAY_ROLES = ["dialog", "alertdialog", "menu"] as const;

const OVERLAY_SELECTOR = OVERLAY_ROLES.map((role) => `[role="${role}"]`).join(", ");

export function isOverlayOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector(OVERLAY_SELECTOR) !== null;
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

/**
 * Keep main's right-click menu on the same search engine as the toolbar.
 *
 * The menu is built in the main process and cannot read a store, so the choice
 * is pushed to it: once on start-up, because main boots with the default and
 * has no way of knowing what was persisted, and again on every change.
 *
 * Armed once for the whole app, like the other subscriptions in this file — a
 * component that owned it would stop publishing the moment its tab was
 * switched away from, and the menu would silently drift back.
 */
export function announceSearchEngine(store: {
  getState(): { engineId: string };
  subscribe(listener: (state: { engineId: string }) => void): () => void;
}, engineOf: (id: string) => { name: string; query: string }): () => void {
  const bridge = browserViewBridge();
  if (!bridge?.setSearchEngine) return () => {};
  let last = "";
  const publish = (id: string) => {
    if (id === last) return;
    last = id;
    bridge.setSearchEngine(engineOf(id));
  };
  publish(store.getState().engineId);
  return store.subscribe((state) => publish(state.engineId));
}
