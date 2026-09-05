/*
  The browser panel's real browser.

  The panel used to be an `<iframe>` inside the app's own window, which put a
  page the operator typed the address of inside the shell's renderer — a
  renderer that runs with `webSecurity: false` because the file pane draws PDFs
  and local previews. A frame in that process is a frame with the shell's
  privileges relaxed around it, and it is also a frame whose history we cannot
  read: an iframe's `history` is cross-origin, so Back and Forward in the panel
  were a list the pane kept for itself rather than the page's own.

  A `WebContentsView` fixes both. It is a separate web contents with its own
  session, its own process and its own navigation history, and it does not
  inherit the shell's `webPreferences` — so the page runs *with* web security,
  without node, sandboxed, and with no preload to reach for. It also cannot see
  `teminali-media://`: that scheme is handled on the default session, and this
  view is on `persist:teminali-browser`.

  What it costs is that the view is an OS-level layer above the DOM rather than
  part of it. Nothing in the page can be drawn over it, so the renderer has to
  say where it is (`setBounds`), and has to hide it whenever the app draws
  something on top — a menu, a modal — or moves it off the active tab. That is
  the whole of the contract below: bounds, visibility, navigation, and a state
  event back for the toolbar.
*/
const { WebContentsView, ipcMain, session, shell } = require("electron");

const PARTITION = "persist:teminali-browser";
const STATE_CHANNEL = "browser-view:state";

/** A page the panel may load. Anything else is a way out of the panel. */
function isAllowedUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/** Bounds arrive as CSS pixels; the view wants DIPs, which differ under zoom. */
function scaleBounds(bounds, zoomFactor) {
  const factor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    x: Math.round(bounds.x * factor),
    y: Math.round(bounds.y * factor),
    width: Math.max(0, Math.round(bounds.width * factor)),
    height: Math.max(0, Math.round(bounds.height * factor)),
  };
}

function isBounds(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    ["x", "y", "width", "height"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))
  );
}

function initBrowserViews({ getMainWindow, log }) {
  /** @type {Map<string, {view: import("electron").WebContentsView, bounds: object|null, visible: boolean}>} */
  const views = new Map();

  const mainWindowOf = (sender) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return null;
    return sender === window.webContents ? window : null;
  };

  const publish = (id) => {
    const window = getMainWindow();
    const entry = views.get(id);
    if (!window || window.isDestroyed() || !entry || entry.view.webContents.isDestroyed()) return;
    const contents = entry.view.webContents;
    window.webContents.send(STATE_CHANNEL, {
      id,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      // The renderer cannot hear this page — it is another process — and it
      // has to, because a page playing a video is a page the microphone will
      // transcribe as an operator. See src/services/voice/selfAudio.ts.
      audible: contents.isCurrentlyAudible(),
    });
  };

  const fail = (id, message) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(STATE_CHANNEL, { id, error: message });
  };

  function create(window, id) {
    const view = new WebContentsView({
      webPreferences: {
        // Deliberately none of the shell's relaxations: this is someone else's
        // page. No preload means there is no bridge for it to find.
        session: session.fromPartition(PARTITION),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    window.contentView.addChildView(view);

    const contents = view.webContents;
    // A link that would open a window navigates the panel instead when it is a
    // page, and goes to the real browser when it is anything else.
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedUrl(url)) contents.loadURL(url).catch(() => {});
      else shell.openExternal(url).catch(() => {});
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedUrl(url)) event.preventDefault();
    });
    for (const event of ["did-navigate", "did-navigate-in-page", "did-start-loading", "did-stop-loading", "page-title-updated", "audio-state-changed"]) {
      contents.on(event, () => publish(id));
    }
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED, which is what a navigation replaced by another one
      // reports; it is not a failure the operator did anything about.
      if (!isMainFrame || code === -3) return;
      log(`Browser view ${id} failed: ${code} ${description} ${url}`);
      fail(id, description || `Could not load (${code})`);
    });

    const entry = { view, bounds: null, visible: false };
    views.set(id, entry);
    return entry;
  }

  function destroy(id) {
    const entry = views.get(id);
    if (!entry) return;
    views.delete(id);
    const window = getMainWindow();
    // A page that was playing has stopped, and it will never say so itself: it
    // is about to have no web contents. Left unsaid, the renderer goes on
    // believing the app is making noise and keeps the microphone suspect.
    try {
      if (window && !window.isDestroyed()) window.webContents.send(STATE_CHANNEL, { id, audible: false, closed: true });
    } catch {}
    try {
      if (window && !window.isDestroyed()) window.contentView.removeChildView(entry.view);
    } catch {}
    try {
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    } catch {}
  }

  /*
    The pane mounts whenever its tab comes to the front, and the view it is
    the front of has been sitting there hidden all along, at whatever page the
    operator navigated it to. Loading the panel's stored address again on every
    mount would throw that away — the scroll position, the form, the three
    links deep — and reset the history that is the whole reason this is a view.
    So a mount asks for a view rather than for a navigation: an existing one is
    left exactly as it is and merely re-announces itself to the new toolbar.
  */
  ipcMain.handle("browser-view:ensure", (event, id, url) => {
    const window = mainWindowOf(event.sender);
    if (!window || typeof id !== "string" || !id) return { ok: false, reason: "unavailable" };
    if (views.has(id)) {
      publish(id);
      return { ok: true, existing: true };
    }
    if (!isAllowedUrl(url)) return { ok: false, reason: "scheme" };
    const entry = create(window, id);
    entry.view.webContents.loadURL(url).catch((error) => {
      log(`Browser view ${id} could not load ${url}:`, error?.message ?? error);
    });
    return { ok: true, existing: false };
  });

  ipcMain.handle("browser-view:navigate", (event, id, url) => {
    const window = mainWindowOf(event.sender);
    if (!window || typeof id !== "string" || !id) return { ok: false, reason: "unavailable" };
    if (!isAllowedUrl(url)) return { ok: false, reason: "scheme" };
    const entry = views.get(id) ?? create(window, id);
    entry.view.webContents.loadURL(url).catch((error) => {
      log(`Browser view ${id} could not load ${url}:`, error?.message ?? error);
    });
    return { ok: true };
  });

  ipcMain.on("browser-view:bounds", (event, id, bounds, visible) => {
    const window = mainWindowOf(event.sender);
    if (!window || typeof id !== "string") return;
    const entry = views.get(id);
    if (!entry) return;
    if (isBounds(bounds)) {
      entry.bounds = bounds;
      entry.view.setBounds(scaleBounds(bounds, window.webContents.getZoomFactor()));
    }
    const shown = Boolean(visible) && (isBounds(bounds) ? bounds.width > 0 && bounds.height > 0 : entry.visible);
    entry.visible = shown;
    entry.view.setVisible(shown);
  });

  ipcMain.on("browser-view:command", (event, id, command) => {
    if (!mainWindowOf(event.sender)) return;
    const entry = views.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) return;
    const contents = entry.view.webContents;
    if (command === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (command === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (command === "reload") contents.reload();
    else if (command === "stop") contents.stop();
    publish(id);
  });

  ipcMain.on("browser-view:destroy", (event, id) => {
    if (!mainWindowOf(event.sender)) return;
    destroy(id);
  });

  /** The window is going away, or the renderer is reloading into a fresh page. */
  function destroyAllBrowserViews() {
    for (const id of [...views.keys()]) destroy(id);
  }

  ipcMain.on("browser-view:destroy-all", (event) => {
    if (!mainWindowOf(event.sender)) return;
    destroyAllBrowserViews();
  });

  return { destroyAllBrowserViews };
}

module.exports = { initBrowserViews, isAllowedUrl, scaleBounds, isBounds, BROWSER_VIEW_PARTITION: PARTITION };
