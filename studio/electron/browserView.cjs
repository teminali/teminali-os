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
const { app, dialog, WebContentsView, ipcMain, session, shell, webContents } = require("electron");
const { attachContextMenu, setSearchEngine } = require("./contextMenu.cjs");
const { createBrowserCdp } = require("./browserCdp.cjs");
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

  macOS grants the *system* passkey provider — the one that reaches iCloud
  Keychain — only to registered web browsers, behind
  `com.apple.developer.web-browser.public-key-credential`, which an Electron
  app cannot hold. Measured in this app rather than assumed:
  `PublicKeyCredential` is defined, `navigator.credentials.get` is a function,
  and `isUserVerifyingPlatformAuthenticatorAvailable()` answered false. So the
  page asked correctly and there was simply nothing to answer, which the
  operator experienced as a button that does nothing at all.

  **On macOS this is now answered**, by a different authenticator than the one
  Apple withholds: Electron 44's `app.configureWebAuthn` implements a platform
  authenticator against this Mac's Secure Enclave, and `electron/webauthn.cjs`
  turns it on when the build was signed with the keychain access group it
  needs. Touch ID only — device-bound credentials, no iCloud sync, no phone
  passkeys, no security keys — and nothing at all on Windows and Linux, which
  still have no platform authenticator here.

  So the probe below stays, and its going quiet on macOS is the acceptance
  test: `isUserVerifyingPlatformAuthenticatorAvailable()` now answers true,
  the early return at the check fires, and the notice never reaches the
  toolbar. Everywhere else the notice is still the honest answer.

  The probe wraps
  `credentials.get` and `.create` in the page's own world, calls through
  untouched, and — only when the platform authenticator really is absent —
  says so on the console. `console.info` is the channel deliberately: this view
  has no preload precisely so that someone else's page has no bridge to find,
  and a sentinel string main happens to read is not one.

  ## The request never ends on its own

  Measured in an Electron harness against a real https page, with the probe
  installed: `isUserVerifyingPlatformAuthenticatorAvailable()` answers false and
  `credentials.get({publicKey})` then stays **pending** — eight seconds in, no
  resolve, no reject, no dialog. That is the whole of the operator's
  experience: they press the button and the page spins for ever, because the
  page is correctly waiting for an authenticator that is never going to answer.

  So the probe also ends it. When no platform authenticator exists and the
  caller supplied no `signal` of its own, it attaches one and aborts after
  `PASSKEY_ABORT_MS`. The page then gets a rejection it already knows how to
  handle — which on Google's sign-in is what puts "Try another way" on screen.
  The wait is long on purpose: a *cross-platform* authenticator, a USB security
  key, is still possible here, and a person needs time to find one and touch it.
*/
const PASSKEY_SENTINEL = "teminali:passkey-unavailable:";

/**
 * How long a passkey request is left hanging before it is ended.
 *
 * Long enough to plug in a security key and touch it — that path can still
 * work and must not be cut short — and short enough that a page waiting for a
 * Touch ID that cannot come recovers by itself.
 */
const PASSKEY_ABORT_MS = 25_000;
const PASSKEY_PROBE = `(() => {
  const creds = navigator.credentials;
  if (!creds || creds.__teminaliPasskeyWatch) return;
  Object.defineProperty(creds, "__teminaliPasskeyWatch", { value: true });
  const sentinel = ${JSON.stringify(PASSKEY_SENTINEL)};
  const ABORT_MS = ${PASSKEY_ABORT_MS};
  for (const name of ["get", "create"]) {
    const original = creds[name];
    if (typeof original !== "function") continue;
    Object.defineProperty(creds, name, {
      configurable: true,
      writable: true,
      value: function (options) {
        if (!options || !options.publicKey) return original.call(creds, options);

        // The caller's own signal always wins: a page that manages its own
        // cancellation is not one to take the decision away from.
        var controller = null;
        var request = options;
        if (typeof AbortController === "function" && !options.signal) {
          controller = new AbortController();
          request = Object.assign({}, options, { signal: controller.signal });
        }

        var promise = original.call(creds, request);
        var settled = false;
        promise.then(function () { settled = true; }, function () { settled = true; });

        try {
          var api = window.PublicKeyCredential;
          var ask = api && api.isUserVerifyingPlatformAuthenticatorAvailable;
          Promise.resolve(ask ? ask.call(api) : false)
            .then(function (available) {
              if (available) return;
              console.info(sentinel + name);
              if (!controller) return;
              setTimeout(function () { if (!settled) controller.abort(); }, ABORT_MS);
            })
            .catch(function () {});
        } catch (error) {
          /* A page is free to have replaced the API; that is not an argument to have. */
        }
        return promise;
      },
    });
  }
})();`;

/**
 * How long an unanswered passkey chooser waits before it cancels itself.
 *
 * Generous: the operator may be reading two account names they have not seen
 * in a year. Bounded all the same, because Electron holds the page's promise
 * open until the callback comes back, and a chooser left behind a switched-away
 * tab must not hold it for the life of the process.
 */
const WEBAUTHN_CHOICE_MS = 120_000;

/**
 * The accounts a `select-webauthn-account` offers, reduced to what a chooser
 * can draw.
 *
 * Everything here was written by the page that created the credential, so it
 * is text of someone else's choosing: only the fields the UI shows survive,
 * they are clamped, and an entry with no credential id is dropped — a choice
 * that cannot be answered is not a choice.
 */
function webauthnAccounts(details) {
  const accounts = Array.isArray(details?.accounts) ? details.accounts : [];
  const text = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined);
  return accounts
    .filter((account) => typeof account?.credentialId === "string" && account.credentialId)
    .slice(0, 12)
    .map((account) => ({
      credentialId: account.credentialId,
      name: text(account.name),
      displayName: text(account.displayName),
    }));
}

/** The site asking, as a host the operator can recognise. */
function relyingPartyOf(details) {
  const id = details?.relyingPartyId;
  return typeof id === "string" ? id.slice(0, 253) : "";
}

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

/*
  What a screenshot is called before the operator renames it.

  The host and the minute, because a folder of `Screenshot 12.png` is a folder
  nobody can search. The hostname is site-controlled text on its way to a file
  path, so it is reduced to letters, digits, dots and dashes here rather than
  trusted — a leading dot or a slash in a "hostname" would otherwise decide
  which directory the save dialog opened in.
*/
function screenshotFilename(url, at = new Date()) {
  let host = "";
  try {
    host = new URL(String(url)).hostname;
  } catch {
    host = "";
  }
  const safe = host.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  const pad = (value) => String(value).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `teminali-${safe || "page"}-${stamp}.png`;
}

/*
  A picture, back out of the data URL the CDP layer answers with.

  browserCdp.cjs returns an image the way the agent's tools need it — a data URL
  in a JSON result — and this is the one caller that wants bytes instead. Kept
  strict on purpose: the string is what gets written to a file the operator
  chose, so anything that is not a base64 png or jpeg is refused rather than
  decoded on a guess.
*/
function dataUrlBytes(value) {
  if (typeof value !== "string") return null;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  return bytes.length > 0 ? bytes : null;
}

/*
  What "Clear cookies" and "Clear cache" actually clear.

  A mapping rather than two calls at the call site, because the honest answer to
  each label is not obvious and belongs somewhere a test can read it. Cookies
  take the HTTP auth cache with them: a stored Basic-auth credential is the same
  promise to the operator as a session cookie, and leaving it would sign them
  out of every site except the ones they would least expect. Nothing here
  touches localStorage or IndexedDB — the label says cookies.

  History is not in this table. It is the gateway's file, not a session's, and
  it is cleared through `browserStore` (see store/browserStore.ts).
*/
function clearDataPlan(kind) {
  if (kind === "cookies") return { storages: ["cookies"], cache: false, authCache: true };
  if (kind === "cache") return { storages: [], cache: true, authCache: false };
  return null;
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
      // A passkey request that found more than one credential and is waiting
      // for the operator to say which. See the chooser at the end of this file.
      webauthn: entry.webauthn ?? null,
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
    /* `cdp` stays null until something asks: attaching a debugger to every tab
       the operator opens would put a protocol channel on pages nobody ever
       asks the assistant about. See electron/browserCdp.cjs. */
    const entry = { view, bounds: null, visible: false, private: isPrivate === true, passkey: false, webauthn: null, cdp: null };
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
      // A chooser belongs to the request that raised it, and that request did
      // not survive the navigation. Cancelling settles Electron's callback,
      // which otherwise stays owed for ever.
      cancelWebauthnFor(id);
      /* The snapshot refs the assistant is holding describe a document that is
         no longer here. Dropped rather than left to fail on their own: a ref
         that still resolves after a navigation is a click on whatever now
         occupies that slot, reported as a success. */
      entry.cdp?.invalidateRefs();
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
    // Before the entry goes: an unanswered chooser owes Electron a callback,
    // and the tab it belonged to is not going to answer now.
    cancelWebauthnFor(id);
    // And the debugger, before the contents it is attached to goes: a detach
    // after the target is destroyed throws, and the message listener would
    // outlive the view that owns it.
    try {
      entry.cdp?.dispose();
    } catch {}
    entry.cdp = null;
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

  /*
    The assistant, reaching the page.

    One channel, and the operations are named rather than composed: the
    renderer asks for `snapshot` or `click`, never for a CDP method. The
    protocol is spoken only in browserCdp.cjs, behind an allowlist, and this
    handler's whole job is to find the view and hand over a plain result.

    Errors come back as `{ ok: false, error }` rather than as a rejected
    invoke. This answer travels on to the gateway and then into a tool result,
    and "there is no snapshot of this page yet" is something the agent can act
    on — where a thrown IPC error arrives as an unhandled rejection in the
    renderer and a silent timeout in the turn.
  */
  ipcMain.handle("browser-view:cdp", async (event, id, op, params) => {
    if (!mainWindowOf(event.sender)) return { ok: false, error: "The browser panel is not available in this window." };
    const entry = views.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) {
      return { ok: false, error: "That browser panel is not open. Open a page with `browse` first." };
    }
    const contents = entry.view.webContents;
    if (contents.isLoading()) {
      /*
        Not a refusal, a wait. A snapshot taken mid-navigation describes the
        page being left, which is worse than being told to ask again — and the
        agent's next call is usually one round trip away.
      */
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        if (typeof timer.unref === "function") timer.unref();
        contents.once("did-stop-loading", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (contents.isDestroyed()) return { ok: false, error: "That browser panel closed while it was loading." };
    }
    if (!entry.cdp) entry.cdp = createBrowserCdp({ contents, log });
    try {
      switch (op) {
        case "snapshot":
          return { ok: true, result: await entry.cdp.snapshot() };
        case "read":
          return { ok: true, result: await entry.cdp.read() };
        case "screenshot":
          return { ok: true, result: await entry.cdp.screenshot({ fullPage: params?.fullPage === true }) };
        case "click":
          return { ok: true, result: await entry.cdp.click({ ref: params?.ref, button: params?.button }) };
        case "type":
          return { ok: true, result: await entry.cdp.type({ ref: params?.ref, text: params?.text, submit: params?.submit === true }) };
        case "network":
          return { ok: true, result: await entry.cdp.networkLog({ limit: params?.limit, filter: params?.filter }) };
        case "eval":
          return { ok: true, result: await entry.cdp.evaluate({ expression: params?.expression }) };
        default:
          return { ok: false, error: `"${op}" is not something the browser panel can be asked to do.` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Browser view ${id} could not ${op}:`, message);
      return { ok: false, error: message };
    }
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

  /*
    The operator's own screenshot of the page.

    Full page and PNG, which is what separates it from the agent's
    `page_screenshot`: that one is a jpeg of what is on screen, sized for a
    model's context, and this one is a file somebody will open at 200% to read
    the small print. Same CDP layer either way — nothing else in the app speaks
    the protocol.

    Electron's save dialog, for the reason the downloads block below states: main
    does not invent paths inside the operator's home. The path it hands back is
    remembered the way a finished download is, so "Show in Finder" can reveal
    it — main watched this exact file being written, which is the only thing
    that makes a path revealable here. A screenshot of a private tab is kept for
    the session and not written to the list on disk, like a private download.
  */
  ipcMain.handle("browser-view:screenshot", async (event, id) => {
    const window = mainWindowOf(event.sender);
    if (!window) return { ok: false, error: "The browser panel is not available in this window." };
    const entry = views.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) return { ok: false, error: "That browser panel is not open." };
    const contents = entry.view.webContents;
    try {
      if (!entry.cdp) entry.cdp = createBrowserCdp({ contents, log });
      const shot = await entry.cdp.screenshot({ fullPage: true, format: "png" });
      const bytes = dataUrlBytes(shot.image);
      if (!bytes) return { ok: false, error: "The page produced no picture." };
      const chosen = await dialog.showSaveDialog(window, {
        title: "Save screenshot",
        defaultPath: path.join(app.getPath("downloads"), screenshotFilename(shot.url || contents.getURL?.() || "")),
        filters: [{ name: "PNG image", extensions: ["png"] }],
      });
      // Cancelled is not a failure, and must not read as one: the pane draws a
      // refusal in the same strip it draws a load error in.
      if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true };
      await fs.promises.writeFile(chosen.filePath, bytes);
      remember(chosen.filePath, !entry.private);
      return { ok: true, path: chosen.filePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Browser view ${id} could not be photographed:`, message);
      return { ok: false, error: message };
    }
  });

  /*
    Clearing cookies or the cache.

    Both sessions, always. The private one is wiped when its last tab closes
    anyway — but an operator asking to clear cookies means all of them, and a
    private tab open right now is holding some. Which storages each word covers
    is `clearDataPlan`, above, and not decided here.
  */
  ipcMain.handle("browser-view:clear-data", async (event, kind) => {
    if (!mainWindowOf(event.sender)) return { ok: false, error: "The browser panel is not available in this window." };
    const plan = clearDataPlan(kind);
    if (!plan) return { ok: false, error: "That is not something the browser panel can clear." };
    try {
      for (const partition of [PARTITION, PRIVATE_PARTITION]) {
        const store = session.fromPartition(partition);
        if (plan.storages.length) await store.clearStorageData({ storages: plan.storages });
        if (plan.cache) await store.clearCache();
        if (plan.authCache) await store.clearAuthCache();
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Browser data (${kind}) could not be cleared:`, message);
      return { ok: false, error: message };
    }
  });

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

  /*
    Two passkeys for one site, and a choice that has to leave this process.

    Once `app.configureWebAuthn` is on (electron/webauthn.cjs), a
    `navigator.credentials.get()` that matches more than one credential stops
    on `select-webauthn-account` and waits — and Electron is explicit that the
    request **stays pending until the callback is invoked**, and that a session
    with no listener at all cancels the request. So this is not decoration:
    without it, an operator with two passkeys for one site gets a
    `NotAllowedError` and no way to say which account they meant.

    The chooser is drawn by the renderer rather than by a native dialog, for
    the same reason everything else in this panel is: it is a page's request
    about the operator's own accounts, and it belongs in the panel's own
    chrome. It travels on the existing state channel, so it is subject to the
    same merge the toolbar already does, and the renderer's answer comes back
    on one narrow channel that carries a request id — a stale id settles
    nothing, which is what makes a second click harmless.

    Every path out of here settles the callback exactly once: a choice, a
    cancel, a navigation, a closed tab, or the timeout. An unanswered one is
    not a stuck dialog — it is a page that never hears back.
  */
  const pendingWebauthn = new Map();
  let webauthnSeq = 0;

  /**
   * Settle one pending request and take its chooser off the toolbar.
   *
   * `credentialId` must be one of the ids that were offered; anything else —
   * including the cancel this sends as `null` — makes the page's promise
   * reject with `NotAllowedError`, which is the same outcome as dismissing a
   * browser's own sheet.
   */
  function settleWebauthn(requestId, credentialId) {
    const pending = pendingWebauthn.get(requestId);
    if (!pending) return;
    pendingWebauthn.delete(requestId);
    clearTimeout(pending.timer);
    const entry = views.get(pending.id);
    if (entry && entry.webauthn && entry.webauthn.requestId === requestId) {
      entry.webauthn = null;
      publish(pending.id);
    }
    try {
      pending.callback(typeof credentialId === "string" && credentialId ? credentialId : null);
    } catch (error) {
      log("A passkey choice could not be delivered:", error?.message ?? error);
    }
  }

  /** Cancel whatever this view was asking, if anything. */
  function cancelWebauthnFor(id) {
    for (const [requestId, pending] of pendingWebauthn) {
      if (pending.id === id) settleWebauthn(requestId, null);
    }
  }

  for (const partition of [PARTITION, PRIVATE_PARTITION]) {
    session.fromPartition(partition).on("select-webauthn-account", (_event, details, callback) => {
      let claimed = false;
      try {
        const contents = details?.frame ? webContents.fromFrame(details.frame) : null;
        const id = contents ? panelIdOf(contents) : null;
        const entry = id ? views.get(id) : null;
        const window = getMainWindow();
        const accounts = webauthnAccounts(details);
        if (!entry || !window || window.isDestroyed() || accounts.length === 0) {
          callback(null);
          return;
        }
        const requestId = `webauthn-${++webauthnSeq}`;
        const timer = setTimeout(() => settleWebauthn(requestId, null), WEBAUTHN_CHOICE_MS);
        // A pending choice is not a reason to keep the process alive.
        if (typeof timer.unref === "function") timer.unref();
        pendingWebauthn.set(requestId, { id, callback, timer });
        claimed = true;
        entry.webauthn = { requestId, relyingPartyId: relyingPartyOf(details), accounts };
        publish(id);
      } catch (error) {
        log("The passkey account chooser failed:", error?.message ?? error);
        if (!claimed) callback(null);
      }
    });
  }

  ipcMain.on("browser-view:webauthn-choice", (event, requestId, credentialId) => {
    if (!mainWindowOf(event.sender)) return;
    settleWebauthn(requestId, credentialId);
  });

  return { destroyAllBrowserViews };
}

module.exports = {
  initBrowserViews,
  isPasskeyNotice,
  PASSKEY_PROBE,
  WEBAUTHN_CHOICE_MS,
  webauthnAccounts,
  relyingPartyOf,
  isAllowedUrl,
  scaleBounds,
  isBounds,
  parseKnownDownloads,
  isRevealable,
  screenshotFilename,
  dataUrlBytes,
  clearDataPlan,
  BROWSER_VIEW_PARTITION: PARTITION,
  BROWSER_VIEW_PRIVATE_PARTITION: PRIVATE_PARTITION,
};
