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
const { app, WebContentsView, ipcMain, session, shell } = require("electron");
const { attachContextMenu, setSearchEngine } = require("./contextMenu.cjs");
const fs = require("node:fs");
const path = require("node:path");

const PARTITION = "persist:teminali-browser";
/*
  The private session.

  No `persist:` prefix — that is the whole mechanism: Electron keeps an
  unprefixed partition in memory, so its cookies, storage and cache exist only
  while the process does. One session shared by every private tab, the way a
  browser's private *window* holds several tabs that can see each other's
  login, and cleared the moment the last of them closes so the next private tab
  starts from nothing.
*/
const PRIVATE_PARTITION = "teminali-browser-private";
const STATE_CHANNEL = "browser-view:state";
const DOWNLOAD_CHANNEL = "browser-view:download";
/** How many saved paths stay revealable. Old enough is off the operator's Home anyway. */
const MAX_KNOWN_DOWNLOADS = 200;

/*
  Passkeys, and the silence that made them look broken.

  macOS gates the platform authenticator — Touch ID — behind
  `com.apple.developer.web-browser.public-key-credential`, an entitlement Apple
  grants to registered web browsers and to nothing else; an Electron app cannot
  hold it. Measured in this app rather than assumed: `PublicKeyCredential` is
  defined, `navigator.credentials.get` is a function, and
  `isUserVerifyingPlatformAuthenticatorAvailable()` answers false. So the page
  asks correctly and there is simply nothing to answer, which the operator
  experiences as a button that does nothing at all.

  The limit is not fixable here. The silence is. The probe wraps
  `credentials.get` and `.create` in the page's own world, calls through
  untouched, and — only when the platform authenticator really is absent —
  says so on the console. `console.info` is the channel deliberately: this view
  has no preload precisely so that someone else's page has no bridge to find,
  and a sentinel string main happens to read is not one.
*/
const PASSKEY_SENTINEL = "teminali:passkey-unavailable:";
const PASSKEY_PROBE = `(() => {
  const creds = navigator.credentials;
  if (!creds || creds.__teminaliPasskeyWatch) return;
  Object.defineProperty(creds, "__teminaliPasskeyWatch", { value: true });
  const sentinel = ${JSON.stringify(PASSKEY_SENTINEL)};
  for (const name of ["get", "create"]) {
    const original = creds[name];
    if (typeof original !== "function") continue;
    Object.defineProperty(creds, name, {
      configurable: true,
      writable: true,
      value: function (options) {
        if (options && options.publicKey) {
          try {
            const api = window.PublicKeyCredential;
            const ask = api && api.isUserVerifyingPlatformAuthenticatorAvailable;
            Promise.resolve(ask ? ask.call(api) : false)
              .then((available) => { if (!available) console.info(sentinel + name); })
              .catch(() => {});
          } catch (error) {
            /* A page is free to have replaced the API; that is not an argument to have. */
          }
        }
        return original.call(creds, options);
      },
    });
  }
})();`;

/** Is this console line the probe above, rather than the page talking? */
function isPasskeyNotice(text) {
  return typeof text === "string" && text.startsWith(PASSKEY_SENTINEL);
}

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

/*
  Which files this process is allowed to point the Finder at.

  `shell.showItemInFolder` takes any absolute path, so a renderer that could
  hand it one at will would have a directory-listing oracle over the whole
  disk — a page's own name for its download is attacker-controlled text. So
  main keeps the list: a path is revealable only because main itself watched
  Electron's save dialog write that exact file. The list is persisted because
  the operator's Home page still shows last week's downloads after a restart,
  and a Reveal that worked yesterday and not today reads as a broken button.
*/
function parseKnownDownloads(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => typeof entry === "string" && path.isAbsolute(entry)).slice(0, MAX_KNOWN_DOWNLOADS);
  } catch {
    return [];
  }
}

/** The one question the reveal handler asks. Kept apart so it can be tested. */
function isRevealable(known, filePath) {
  return typeof filePath === "string" && filePath.length > 0 && known.has(filePath);
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
      // Which session this view is on. The renderer cannot infer it — the tab
      // that asked for a private view may since have been closed and reopened
      // — and it decides whether the visit is written down at all.
      private: entry.private === true,
      // The page asked for a passkey and nothing can answer. See PASSKEY_PROBE.
      passkey: entry.passkey === true,
    });
  };

  const fail = (id, message) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(STATE_CHANNEL, { id, error: message });
  };

  function create(window, id, isPrivate) {
    const view = new WebContentsView({
      webPreferences: {
        // Deliberately none of the shell's relaxations: this is someone else's
        // page. No preload means there is no bridge for it to find.
        session: session.fromPartition(isPrivate ? PRIVATE_PARTITION : PARTITION),
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
    /* Registered before the listeners below, because they read it: `passkey`
       has to be cleared by a navigation before that same navigation publishes. */
    const entry = { view, bounds: null, visible: false, private: isPrivate === true, passkey: false };
    views.set(id, entry);

    /*
      Right-click on someone else's page. A React menu could never appear over
      this: the page is its own `webContents`, layered above the document, and
      nothing the renderer draws reaches it. `isBrowserPage` is what adds Back,
      Forward and Reload — this is the one surface in the app where those mean
      something — and a Google search from a selection opens in this same panel
      rather than in Safari.
    */
    attachContextMenu(contents, {
      isBrowserPage: true,
      // The one surface where Inspect Element belongs: it opens the devtools of
      // this page, which is someone else's document, and reaches nothing of the
      // app's own. The shell window deliberately has none — see main.cjs.
      allowInspect: true,
      openInPanel: (url) => { contents.loadURL(url).catch(() => {}); },
    });

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

    // A new page has not asked for anything yet, so the notice from the last
    // one must not still be on the toolbar. Ordered before the publishing loop
    // below: the same `did-navigate` that clears it is the one that reports.
    contents.on("did-navigate", () => {
      entry.passkey = false;
    });
    contents.on("dom-ready", () => {
      contents.executeJavaScript(PASSKEY_PROBE, false).catch(() => {
        // A page that refused the injection is a page we say nothing about.
      });
    });
    contents.on("console-message", (event, _level, message) => {
      // Electron 36 moved the text onto the event; older builds pass it third.
      const text = typeof event?.message === "string" ? event.message : message;
      if (!isPasskeyNotice(text)) return;
      entry.passkey = true;
      publish(id);
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

    return entry;
  }

  /*
    The end of private browsing.

    An unprefixed partition is already in memory, so nothing survives the
    process — but a second private tab opened an hour later would otherwise
    inherit the first one's cookies, which is not what "private" is taken to
    mean. Cleared when the last private view goes, and not before: private tabs
    share one session on purpose, the way a private window holds several tabs.
  */
  const clearPrivateSession = () => {
    try {
      const store = session.fromPartition(PRIVATE_PARTITION);
      void store.clearStorageData();
      void store.clearCache();
      void store.clearAuthCache();
    } catch (error) {
      log("Could not clear the private session:", error?.message ?? error);
    }
  };

  function destroy(id) {
    const entry = views.get(id);
    if (!entry) return;
    views.delete(id);
    if (entry.private && ![...views.values()].some((other) => other.private)) clearPrivateSession();
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
  ipcMain.handle("browser-view:ensure", (event, id, url, options) => {
    const window = mainWindowOf(event.sender);
    if (!window || typeof id !== "string" || !id) return { ok: false, reason: "unavailable" };
    if (views.has(id)) {
      publish(id);
      return { ok: true, existing: true };
    }
    if (!isAllowedUrl(url)) return { ok: false, reason: "scheme" };
    const entry = create(window, id, options?.private === true);
    entry.view.webContents.loadURL(url).catch((error) => {
      log(`Browser view ${id} could not load ${url}:`, error?.message ?? error);
    });
    return { ok: true, existing: false };
  });

  ipcMain.handle("browser-view:navigate", (event, id, url, options) => {
    const window = mainWindowOf(event.sender);
    if (!window || typeof id !== "string" || !id) return { ok: false, reason: "unavailable" };
    if (!isAllowedUrl(url)) return { ok: false, reason: "scheme" };
    // An existing view keeps the session it was made on: privacy is decided
    // once, when the tab is opened, and a later navigation cannot change it.
    const entry = views.get(id) ?? create(window, id, options?.private === true);
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

  /* ── Downloads ──────────────────────────────────────────────────────────
     Armed once on the shared session rather than per view, because every tab
     is on `persist:teminali-browser` (see `create`) — a per-tab listener would
     fire once per open tab for a single file.

     The save path is deliberately not chosen here. Electron shows its own save
     dialog when nothing calls `setSavePath`, which puts the operator in front
     of the one decision that matters and keeps this process out of the
     business of inventing paths inside the user's home. What main does is
     watch what came back, so the file can be revealed later.

     Progress is IPC and never reaches the gateway: a 4 GB file would otherwise
     be several thousand POSTs. Only the end of a download is recorded, by the
     renderer. See src/services/browserDownloads.ts.
  */
  const knownFile = path.join(app.getPath("userData"), "gateway", "browser-downloads.json");
  /** @type {Set<string>} */
  let known = new Set();
  try {
    known = new Set(parseKnownDownloads(fs.readFileSync(knownFile, "utf8")));
  } catch {
    // No file yet, which is what a first run looks like.
  }

  const remember = (filePath, persist) => {
    if (!filePath || known.has(filePath)) return;
    known.add(filePath);
    // A private download is still a file the operator asked for and can still
    // be revealed while the app is open — but the list of what was downloaded
    // is exactly the thing private browsing promises not to write down.
    if (!persist) return;
    const kept = [...known].slice(-MAX_KNOWN_DOWNLOADS);
    known = new Set(kept);
    try {
      fs.mkdirSync(path.dirname(knownFile), { recursive: true });
      fs.writeFileSync(knownFile, JSON.stringify(kept, null, 2));
    } catch (error) {
      log("Could not record a download for reveal:", error?.message ?? error);
    }
  };

  let downloadSeq = 0;
  const panelIdOf = (contents) => {
    for (const [id, entry] of views) {
      if (!entry.view.webContents.isDestroyed() && entry.view.webContents === contents) return id;
    }
    return null;
  };

  const sendDownload = (payload) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    try {
      window.webContents.send(DOWNLOAD_CHANNEL, payload);
    } catch {}
  };

  const armDownloads = (partition) => {
    try {
      session.fromPartition(partition).on("will-download", (_event, item, contents) => {
        const downloadId = `dl-${Date.now()}-${++downloadSeq}`;
        const panelId = panelIdOf(contents);
        // The panel is the truth when it is still open; the session it arrived on
        // is the answer when the tab has already been closed under the download.
        const isPrivate = panelId ? views.get(panelId)?.private === true : partition === PRIVATE_PARTITION;
        const url = item.getURL();
        const filename = item.getFilename();
        // `done` rather than a state the renderer has to interpret: an
        // `interrupted` mid-flight can still resume, and only the final one is a
        // row worth writing. Inferring that from the word alone would record a
        // failed download every time the network hiccuped.
        const report = (state, done) =>
          sendDownload({
            downloadId,
            panelId,
            url,
            filename,
            state,
            done,
            received: item.getReceivedBytes(),
            total: item.getTotalBytes(),
            path: done && state === "completed" ? item.getSavePath() : "",
            // The renderer writes the finished row to the gateway; a private one
            // is shown while it arrives and then forgotten.
            private: isPrivate,
          });

        report("progressing", false);
        item.on("updated", (__event, state) => {
          if (state === "interrupted") report("interrupted", false);
          else report(item.isPaused() ? "paused" : "progressing", false);
        });
        item.once("done", (__event, state) => {
          // `cancelled` is also what dismissing the save dialog reports, so the
          // renderer drops those rather than writing a row for a file that was
          // never asked for.
          if (state === "completed") remember(item.getSavePath(), !isPrivate);
          report(state, true);
        });
      });
    } catch (error) {
      log("Browser downloads could not be armed:", error?.stack || error?.message || error);
    }
  };
  armDownloads(PARTITION);
  armDownloads(PRIVATE_PARTITION);

  ipcMain.handle("browser-view:reveal-download", (event, filePath) => {
    if (!mainWindowOf(event.sender)) return false;
    if (!isRevealable(known, filePath)) return false;
    // Reveal, never open: showing a file in the Finder is inspection, and
    // launching one is execution of something the operator downloaded from a
    // page. The second is not this button's to offer.
    shell.showItemInFolder(filePath);
    return true;
  });

  /*
    A page in the operator's real browser.

    The only way out of the panel, and it is one-directional: main hands the
    address to the OS and nothing comes back. Guarded by the same http(s) line
    every other entry point here draws, because `openExternal` will happily
    launch a `file:` or a custom scheme registered by some other application.
  */
  ipcMain.handle("browser-view:open-external", (event, url) => {
    if (!mainWindowOf(event.sender)) return false;
    if (!isAllowedUrl(url)) return false;
    shell.openExternal(url).catch((error) => log("Could not open externally:", error?.message ?? error));
    return true;
  });

  /*
    Which engine the right-click menu offers to search with.

    The preference is the renderer's — it is drawn in the home page's search
    box — and the menu that has to honour it is drawn here, in another process
    that cannot read a store. So the renderer says it once on start-up and
    again whenever it changes. Refused rather than trusted: `setSearchEngine`
    takes only an https prefix, because this ends up as an argument to a
    navigation.
  */
  ipcMain.on("browser-view:search-engine", (event, engine) => {
    if (!mainWindowOf(event.sender)) return;
    if (!setSearchEngine(engine)) log("Ignored a search engine that was not an https address:", engine?.query);
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

module.exports = {
  initBrowserViews,
  isPasskeyNotice,
  PASSKEY_PROBE,
  isAllowedUrl,
  scaleBounds,
  isBounds,
  parseKnownDownloads,
  isRevealable,
  BROWSER_VIEW_PARTITION: PARTITION,
  BROWSER_VIEW_PRIVATE_PARTITION: PRIVATE_PARTITION,
};
