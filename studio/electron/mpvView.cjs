/*
  Where mpv's picture goes.

  `mpvProcess.cjs` spawns the engine and speaks JSON IPC to it. It draws
  nothing and owns no window, which is exactly what let it be written before
  the licence was settled. This file is the other half — B3 of the plan — and
  it is the half that is different on every platform.

  **Windows and Linux: `--wid`.** mpv takes a native window handle and makes
  its video output a child of that window, resized to fill its client area.
  Electron hands out exactly one native handle,
  `BrowserWindow.getNativeWindowHandle()`, so the thing mpv is given here is a
  `BrowserWindow` of our own: frameless, unfocusable, black, drawing nothing,
  parented to the shell, positioned over the player pane's rectangle and hidden
  whenever that rectangle is not on screen. It cannot be a `WebContentsView` —
  what the browser panel uses — because a `WebContentsView` has no native
  handle to give. It must not be the shell's own window either: mpv fills
  whatever window it is handed, so that would paint video over the entire
  application.

  **macOS: not this way, and not later either.** `--wid` on the Mac takes an
  `NSView` pointer, and a pointer means nothing outside the process that owns
  it; `addChildWindow` is likewise same-process only. No Mac application can
  embed another process's window, which is why every mpv-based Mac player,
  IINA included, links `libmpv` instead. That is B0's deciding fact and the
  reason this product's mpv and FFmpeg are LGPL builds — see
  `docs/MEDIA_LICENSING.md`. So `embedArgs` returns null on darwin rather than
  handing mpv a number that would address nothing there. The Mac's path is a
  linked `libmpv` driven through the render API into a Metal view: a native
  addon, a separate and more expensive piece of work, and deliberately not
  attempted here.

  **The rectangle is the browser panel's problem, already solved once.** A
  window layered over the shell does not clip to the document, cannot be
  positioned by CSS and cannot be drawn on top of. `services/browserView.ts`
  measures and clamps that rectangle (`measureBrowserViewBounds`) and decides
  when an overlay means hide (`isOverlayOpen`); `browserView.cjs` converts CSS
  pixels into device-independent ones (`scaleBounds`). All of it is reused
  rather than copied. The one thing this file adds is the final conversion,
  from a rectangle inside the window's content area to one on the screen —
  needed because a `BrowserWindow` is placed in screen coordinates where a
  `WebContentsView` is placed in its parent's.

  **A child window does not follow its parent.** `parent:` keeps this window
  above the shell and ties its lifetime to it, but on Windows and Linux moving
  the shell does not move the child, and the renderer has no reason to send new
  bounds when only the window moved — the pane's CSS rectangle did not change.
  So the parent's own `move`, `resize`, `hide`, `show`, `minimize` and
  `restore` are listened to here and the last known rectangle is re-applied.
  Without that, dragging the window leaves the video behind, floating over the
  desktop.

  **What is decided about input.** mpv is started with `--input-cursor=no` and
  `--input-vo-keyboard=no`, so the video output consumes neither clicks nor
  keys: the pane owns every control the operator sees, and a second, invisible
  set of bindings answering differently is the failure this avoids. The
  container window is additionally set to ignore mouse events so that a click
  on the video reaches the document underneath it.

  **What is not verified, and cannot be from this machine.** Every line below
  that talks to a window is Windows and Linux behaviour, and this repository is
  developed on a Mac, where `canEmbedSpawned` is false and none of it runs. The
  decisions — the handle's width, the argument list, the screen rectangle, when
  to hide — are pure functions with tests (`tests/mpv-view.test.mjs`). Whether
  a click actually falls through mpv's own child window to the document beneath
  is the one thing those tests cannot answer, because mpv creates that window
  itself inside ours; it is listed as a hand check in `DESIGN.md` §3 and must be
  run on a real Windows or Linux machine before this is called done.
*/

/* ── Where a spawned mpv can be embedded at all ───────────────────────────── */

/**
 * The platforms whose window handles cross a process boundary.
 *
 * Windows hands out an `HWND` and Linux an X11 window id, and both are
 * meaningful to any process that is told the number. Darwin is absent on
 * purpose and is not an omission to be fixed — see the header.
 */
const SPAWNED_EMBED_PLATFORMS = Object.freeze(["win32", "linux"]);

function canEmbedSpawned(platform = process.platform) {
  return SPAWNED_EMBED_PLATFORMS.includes(platform);
}

/* ── The handle ───────────────────────────────────────────────────────────── */

/**
 * `getNativeWindowHandle()`'s buffer as the integer `--wid` wants.
 *
 * Electron returns the handle as raw pointer-width bytes: eight on x64 and
 * arm64, four on a 32-bit build. Both are read here rather than assuming the
 * common case, because the failure of assuming is not a crash — it is a
 * plausible-looking wrong number, and mpv would embed itself into no window at
 * all and report nothing.
 *
 * The answer is a decimal *string*, not a number. `--wid` is an Integer64 and
 * a handle is not promised to fit in the 53 bits a JavaScript number keeps
 * exactly; going through `BigInt` means the value that reaches the command
 * line is the value that came out of the window.
 */
function nativeHandle(buffer) {
  if (!buffer || typeof buffer.length !== "number") return null;
  if (buffer.length >= 8) return String(buffer.readBigUInt64LE(0));
  if (buffer.length >= 4) return String(BigInt(buffer.readUInt32LE(0)));
  return null;
}

/* ── The arguments ────────────────────────────────────────────────────────── */

/**
 * What is added to `mpvArgs()` to make the engine draw into our window.
 *
 * Null rather than a partial list when the platform cannot embed a spawned
 * process or the handle did not decode: a caller that gets null must say the
 * player is unavailable, not start an mpv that opens its own window somewhere
 * over the app.
 *
 * Every option here was checked against the binary (`mpv --list-options`, 0.41)
 * rather than remembered, and each is a default that is wrong for an embedded
 * player rather than a preference:
 *
 * * `--force-window=yes` because mpv is started `--idle` with no file, and
 *   without this there is no video output until the first `loadfile` — the
 *   pane would show a black rectangle that is not yet mpv's.
 * * `--osc=no` (default yes) because mpv's on-screen controller would be a
 *   second set of transport controls drawn over the pane's own.
 * * `--osd-level=0` (default 1) because mpv's status messages are addressed to
 *   someone using mpv, and nobody here is.
 * * `--input-cursor=no` and `--input-vo-keyboard=no` (both default yes) so the
 *   video output answers neither the mouse nor the keyboard. The pane owns the
 *   controls; see the header.
 * * `--cursor-autohide=no` (default 1000ms) because mpv hiding the pointer
 *   after a second of stillness would hide it over the pane's own controls,
 *   which mpv does not know are there.
 *
 * `--vo` is deliberately not pinned. mpv's default already resolves to `gpu`
 * on both of these platforms, and naming it would turn a machine where `gpu`
 * fails into a black rectangle instead of letting mpv fall back.
 */
function embedArgs({ handle, platform = process.platform } = {}) {
  if (!canEmbedSpawned(platform)) return null;
  if (typeof handle !== "string" || !/^\d+$/.test(handle)) return null;
  return [
    `--wid=${handle}`,
    "--force-window=yes",
    "--osc=no",
    "--osd-level=0",
    "--input-cursor=no",
    "--input-vo-keyboard=no",
    "--cursor-autohide=no",
  ];
}

/* ── The rectangle ────────────────────────────────────────────────────────── */

/**
 * A rectangle inside the window's content area, as one on the screen.
 *
 * `bounds` has already been measured and clamped by
 * `measureBrowserViewBounds` and scaled out of CSS pixels by `scaleBounds`, so
 * the only arithmetic left is the content area's own origin. Width and height
 * are floored at one: a `BrowserWindow` cannot be zero-sized, and a rectangle
 * that has collapsed is meant to be hidden — which is `shouldShow`'s answer,
 * not this one's.
 */
function screenRect({ content, bounds } = {}) {
  const originX = Math.round(content?.x ?? 0);
  const originY = Math.round(content?.y ?? 0);
  return {
    x: originX + Math.round(bounds?.x ?? 0),
    y: originY + Math.round(bounds?.y ?? 0),
    width: Math.max(1, Math.round(bounds?.width ?? 0)),
    height: Math.max(1, Math.round(bounds?.height ?? 0)),
  };
}

/**
 * Whether the video window belongs on screen at all.
 *
 * The renderer has already decided the interesting half — the panel is not the
 * one on screen, or an overlay is drawn over it — and says so with `visible`.
 * What is added here is the collapsed rectangle: a pane mid-animation or
 * scrolled out of the window measures zero, and a one-pixel sliver of video at
 * the corner of the screen is worse than nothing.
 */
function shouldShow({ visible, bounds } = {}) {
  if (!visible) return false;
  return Number(bounds?.width) > 0 && Number(bounds?.height) > 0;
}

/* ── The window ───────────────────────────────────────────────────────────── */

/**
 * How a window that is never focused is put on screen.
 *
 * `showInactive` rather than `show`: the operator pressed play in the pane and
 * their keyboard must stay with the pane. `show` would move focus to a window
 * that has no content and answers no keys, and the pane's shortcuts would go
 * quiet with nothing on screen to explain why.
 */
const CHILD_WINDOW_OPTIONS = Object.freeze({
  frame: false,
  transparent: false,
  backgroundColor: "#000000",
  hasShadow: false,
  focusable: false,
  skipTaskbar: true,
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  acceptFirstMouse: false,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
});

/** The parent events after which the child's screen rectangle is stale. */
const PARENT_MOVED = Object.freeze(["move", "moved", "resize", "resized", "restore"]);
/** The parent events after which the child must not be on screen. */
const PARENT_GONE = Object.freeze(["hide", "minimize"]);

/**
 * The black rectangle mpv paints into, and the bookkeeping that keeps it over
 * the right part of the window.
 *
 * Small on purpose. It creates one window, reports the handle and the
 * arguments that go with it, follows a rectangle, and destroys the window. It
 * does not spawn mpv, does not know what is playing and does not decide when
 * the player exists — `attach` hands its caller the arguments to pass to
 * `MpvProcess`, and the caller owns the process, exactly as `mpvProcess.cjs`
 * owns the transport and nothing above it.
 */
class MpvView {
  constructor({ window, platform = process.platform } = {}) {
    this.parent = window ?? null;
    this.platform = platform;
    this.child = null;
    /** The last rectangle the renderer reported, in CSS pixels of the document. */
    this.bounds = null;
    this.visible = false;
    this.listeners = [];
  }

  /** Whether this platform embeds a spawned mpv. False on darwin — see the header. */
  get supported() {
    return canEmbedSpawned(this.platform);
  }

  get attached() {
    return Boolean(this.child && !this.child.isDestroyed());
  }

  /**
   * Create the window and report what mpv must be started with.
   *
   * Returns `{ ok: false, reason }` rather than throwing, because "this
   * platform cannot do it" is a normal answer that the pane has to draw, not
   * an error that ends anything.
   */
  attach() {
    if (!this.supported) {
      return {
        ok: false,
        reason: `A spawned mpv cannot be embedded on ${this.platform}; that needs a linked libmpv.`,
      };
    }
    if (!this.parent || this.parent.isDestroyed()) {
      return { ok: false, reason: "There is no window to embed into." };
    }
    if (this.attached) return { ok: true, args: this.args, handle: this.handle };

    const { BrowserWindow } = require("electron");
    this.child = new BrowserWindow({
      ...CHILD_WINDOW_OPTIONS,
      parent: this.parent,
      show: false,
      ...screenRect({ content: this.parent.getContentBounds(), bounds: { x: 0, y: 0, width: 1, height: 1 } }),
    });
    /*
      A click on the video is a click on the pane's own surface, so the
      container refuses the mouse and lets it through to the document beneath.
      mpv's video output is a further child window that this cannot speak for,
      which is why `--input-cursor=no` is set as well and why the click-through
      is a hand check rather than a claim.
    */
    this.child.setIgnoreMouseEvents(true);

    this.handle = nativeHandle(this.child.getNativeWindowHandle());
    this.args = embedArgs({ handle: this.handle, platform: this.platform });
    if (!this.args) {
      this.detach();
      return { ok: false, reason: "The window handle could not be read." };
    }

    this.#followParent();
    return { ok: true, args: this.args, handle: this.handle };
  }

  /**
   * Put the video over this rectangle, or take it off screen.
   *
   * `bounds` is in CSS pixels of the shell's document — the same rectangle
   * `browser-view:bounds` carries — and is scaled and offset here rather than
   * by the renderer, which cannot know either the zoom factor or where the
   * window is on the desktop.
   */
  setBounds(bounds, visible) {
    if (bounds) this.bounds = bounds;
    this.visible = Boolean(visible);
    this.#apply();
  }

  /** Take the video off screen without ending it — a switched-away tab, a hidden window. */
  hide() {
    this.visible = false;
    this.#apply();
  }

  /** The window goes; mpv's own exit is the caller's business. */
  detach() {
    for (const off of this.listeners.splice(0)) off();
    if (this.child && !this.child.isDestroyed()) this.child.destroy();
    this.child = null;
    this.handle = null;
    this.args = null;
    this.visible = false;
  }

  #apply() {
    if (!this.attached) return;
    if (!shouldShow({ visible: this.visible, bounds: this.bounds })) {
      if (this.child.isVisible()) this.child.hide();
      return;
    }
    const { scaleBounds } = require("./browserView.cjs");
    const scaled = scaleBounds(this.bounds, this.parent.webContents.getZoomFactor());
    this.child.setBounds(screenRect({ content: this.parent.getContentBounds(), bounds: scaled }));
    if (!this.child.isVisible()) this.child.showInactive();
  }

  /**
   * The shell moved, so the video must move with it.
   *
   * See the header: a child window keeps its own screen position when its
   * parent is dragged, and the renderer has no reason to report a rectangle
   * that did not change in its own coordinates.
   */
  #followParent() {
    const parent = this.parent;
    const on = (event, handler) => {
      parent.on(event, handler);
      this.listeners.push(() => { try { parent.off(event, handler); } catch { /* the window went first */ } });
    };
    const reapply = () => this.#apply();
    for (const event of PARENT_MOVED) on(event, reapply);
    for (const event of PARENT_GONE) on(event, () => { if (this.attached && this.child.isVisible()) this.child.hide(); });
    on("show", reapply);
    on("closed", () => this.detach());
  }
}

/* ── What the engine says about its tracks ────────────────────────────────── */

/**
 * The properties the pane needs that the snapshot has no field for.
 *
 * `OBSERVED_PROPERTIES` in `mpvProcess.cjs` is the contract's own state —
 * position, duration, volume — and every one of them maps to a field of the
 * snapshot `player-state.js` publishes. These two do not: they are how the
 * pane's *menu* is drawn while mpv holds the picture, which is a renderer
 * concern and belongs to this file rather than to the transport. They ride the
 * same `mpv-view:state` push, so nothing new crosses the preload.
 *
 * `aid` is deliberately not here. The snapshot has no field for the audio
 * track that is playing and the menu has no row for one, so observing it would
 * push a value with nowhere to go; the audio *list* is in `track-list`, which
 * is what `audio_track` actually needs to resolve a label.
 */
const ENGINE_PROPERTIES = Object.freeze({
  "track-list": "tracks",
  sid: "subtitleId",
});

/**
 * A selected track's number, or null for none.
 *
 * mpv answers `sid` with `false` when subtitles are off and with the string
 * `"auto"` before it has chosen — neither is a track, and both would be drawn
 * as one by a menu comparing ids. Null is the only honest answer for "nothing
 * is selected", and it is what the pane already means by no active track.
 */
function trackId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/* ── The channel ──────────────────────────────────────────────────────────── */

/**
 * One embedded player, and why not several.
 *
 * `browser-view:*` is keyed by panel id because every browser tab is its own
 * page and they coexist. An embedded mpv does not: `--wid` is fixed at spawn,
 * so a second panel means a second process and a second window, and two
 * hardware-decoding video pipelines on a laptop is a decision nobody asked
 * for. So the first panel to ask owns the engine and a second is refused with
 * a reason the pane can draw — which is honest, where quietly stealing the
 * engine from the panel the operator is actually watching would not be.
 *
 * Everything here fails soft. `ok: false` with a sentence is the answer for a
 * platform that cannot embed, an mpv that is not installed and a panel that is
 * not the owner alike; none of those are exceptional, and all three are things
 * the operator has to be told rather than errors to be thrown.
 */
function initMpvView({ getMainWindow, log = () => {} } = {}) {
  const { ipcMain } = require("electron");
  const { MpvProcess, MpvError, playerTracks } = require("./mpvProcess.cjs");

  /** The panel that owns the engine, or null when nothing is embedded. */
  let owner = null;
  let view = null;
  let mpv = null;

  const send = (channel, payload) => {
    const window = getMainWindow?.();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  };

  /** The engine ended — crash, exit or teardown. Said once, so nothing waits on it. */
  const relinquish = (reason) => {
    const id = owner;
    owner = null;
    mpv = null;
    try { view?.detach(); } catch { /* the window went first */ }
    view = null;
    if (id) send("mpv-view:state", { id, closed: true, error: reason ?? undefined });
  };

  async function ensure(id) {
    const window = getMainWindow?.();
    if (!window || window.isDestroyed()) return { ok: false, reason: "There is no window to embed into." };
    if (owner && owner !== id) {
      return { ok: false, reason: "The player is already embedded in another panel." };
    }
    if (owner === id && mpv) return { ok: true, existing: true };

    view = new MpvView({ window });
    const attached = view.attach();
    if (!attached.ok) {
      view = null;
      return attached;
    }

    /*
      The embed arguments are appended to the transport's, not merged with
      them: `mpvArgs` owns how mpv is spoken to and this file owns where it
      draws, and `tests/mpv-view.test.mjs` asserts the two lists never name the
      same option.
    */
    mpv = new MpvProcess({ extraArgs: attached.args });
    if (!mpv.available) {
      const { mpvInstallHint } = require("./mpvProcess.cjs");
      mpv = null;
      view.detach();
      view = null;
      return { ok: false, reason: `mpv was not found. Install it (${mpvInstallHint()}) or set MPV_PATH.` };
    }

    mpv.on("property", ({ name, field, value }) => {
      if (!owner) return;
      if (field) {
        send("mpv-view:state", { id: owner, [field]: value });
        return;
      }
      const engine = ENGINE_PROPERTIES[name];
      if (!engine) return;
      send("mpv-view:state", {
        id: owner,
        [engine]: name === "track-list" ? playerTracks(value) : trackId(value),
      });
    });
    mpv.on("stderr", (line) => log("[mpv]", line));
    mpv.once("exit", ({ code, signal }) => {
      log(`mpv exited (code ${code}, signal ${signal})`);
      relinquish("The player stopped.");
    });

    try {
      await mpv.start();
    } catch (error) {
      const reason = error instanceof MpvError ? error.message : String(error?.message ?? error);
      try { mpv.stop(); } catch { /* it never started */ }
      mpv = null;
      view.detach();
      view = null;
      return { ok: false, reason };
    }

    owner = id;
    /*
      Observed after the owner is set, unlike the transport's own properties,
      and that ordering is the whole reason these are placed here rather than
      in `observeAll`. mpv answers an `observe_property` with the value it has
      right now, and the handler above drops anything that arrives with no
      owner — for `duration` that costs nothing, because an idle mpv has none,
      but a track list dropped on the floor would leave the pane's menu empty
      until the next file. A failure to observe is not a failure to play: the
      picture is there, the menu is the file's own subtitles again, and the
      pane's `unsupported` reads the empty list and says so.
    */
    try {
      for (const name of Object.keys(ENGINE_PROPERTIES)) await mpv.ipc.observeProperty(name);
    } catch (error) {
      log("mpv would not report its tracks:", error?.message ?? error);
    }
    return { ok: true };
  }

  ipcMain.handle("mpv-view:ensure", async (event, id) => {
    if (typeof id !== "string" || !id) return { ok: false, reason: "No panel asked." };
    try {
      return await ensure(id);
    } catch (error) {
      log("mpv could not be embedded:", error?.stack || error?.message || error);
      relinquish();
      return { ok: false, reason: String(error?.message ?? error) };
    }
  });

  /*
    Fire-and-forget, like `browser-view:bounds` and for the same reason: this
    arrives on every scroll, resize and animation frame of a pane that is
    moving, and a round trip per frame would make the video lag the layout it
    is supposed to be part of.
  */
  ipcMain.on("mpv-view:bounds", (event, id, bounds, visible) => {
    if (!view || owner !== id) return;
    try {
      view.setBounds(bounds, visible);
    } catch (error) {
      log("mpv view bounds could not be applied:", error?.message ?? error);
    }
  });

  /** The file, by path. `loadfile` rather than a respawn — mpv is `--idle` and outlives it. */
  ipcMain.handle("mpv-view:load", async (event, id, filePath) => {
    if (owner !== id || !mpv?.ipc) return { ok: false, reason: "This panel does not own the player." };
    if (typeof filePath !== "string" || !filePath) return { ok: false, reason: "No file was named." };
    try {
      await mpv.ipc.command("loadfile", filePath, "replace");
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  });

  /**
   * A `PlayerCommand`, through the table it already has.
   *
   * The mapping is `mpvCommand`'s and stays there: this handler decides
   * nothing about what an action means, which is what keeps the contract in
   * one place for both engines. A null result is the table declining on
   * purpose — series navigation is the pane's, not mpv's — and is reported as
   * such rather than as a success that moved nothing.
   */
  ipcMain.handle("mpv-view:command", async (event, id, command, context) => {
    if (owner !== id || !mpv?.ipc) return { ok: false, reason: "This panel does not own the player." };
    try {
      const results = await mpv.ipc.run(command, context ?? {});
      if (results === null) return { ok: false, reason: `mpv does not answer \`${command?.action}\`.` };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  });

  const FRAME_WIDTH = 1280;
  const FRAME_QUALITY = 82;

  /**
   * One frame of what mpv is showing, as base64 JPEG.
   *
   * `capturePlayerFrame` in `src/services/playerFrame.ts` draws the `<video>`
   * element on a canvas, and while mpv owns the picture there is no element to
   * draw: the frame is in another process, on a window this document cannot
   * read. So the pane asks here, and mpv's `screenshot-raw` hands back the
   * frame it is displaying — no ffmpeg, no second decode, and no file written
   * anywhere the operator would have to clean up.
   *
   * The dimensions are this end's because they are the *agent's*, not the
   * pane's: `FRAME_WIDTH`/`FRAME_QUALITY` in `playerFrame.ts` are the same two
   * numbers for the element path, and the reason for them — a film frame
   * carries text, and text is the first thing a downscale destroys — is
   * written there. Changing one means changing both.
   *
   * `video` rather than `subtitles` as the flag: the agent is being asked what
   * is on screen, so a burned-in caption is part of the answer.
   */
  ipcMain.handle("mpv-view:frame", async (event, id) => {
    if (owner !== id || !mpv?.ipc) return { ok: false, reason: "This panel does not own the player." };
    try {
      const { packBitmap } = require("./mpvProcess.cjs");
      const bitmap = packBitmap(await mpv.ipc.command("screenshot-raw", "video"));
      if (!bitmap) return { ok: false, reason: "The player answered with a frame this build cannot read." };
      const { nativeImage } = require("electron");
      let image = nativeImage.createFromBitmap(bitmap.pixels, { width: bitmap.width, height: bitmap.height });
      if (image.isEmpty()) return { ok: false, reason: "The player answered with a frame this build cannot read." };
      if (bitmap.width > FRAME_WIDTH) image = image.resize({ width: FRAME_WIDTH, quality: "good" });
      return { ok: true, image: image.toJPEG(FRAME_QUALITY).toString("base64") };
    } catch (error) {
      /*
        The usual failure here is mpv refusing the screenshot because nothing is
        decoded yet — a file still opening, or a seek in flight. That is a
        sentence the agent can repeat and try again on, not a crash.
      */
      return { ok: false, reason: String(error?.message ?? error) };
    }
  });

  ipcMain.on("mpv-view:destroy", (event, id) => {
    if (owner !== id) return;
    try { mpv?.stop(); } catch { /* already gone */ }
    relinquish();
  });

  /**
   * The document was replaced, or the window closed.
   *
   * Same reasoning as `destroyAllBrowserViews`: a window layered over the
   * shell belongs to the document that asked for it, and a reload gives it a
   * document that has never heard of it. An mpv left behind would keep a black
   * rectangle over a page that is not asking for one.
   */
  function shutdownMpvView() {
    try { mpv?.stop(); } catch { /* already gone */ }
    relinquish();
  }

  return { shutdownMpvView };
}

module.exports = {
  CHILD_WINDOW_OPTIONS,
  ENGINE_PROPERTIES,
  MpvView,
  PARENT_GONE,
  PARENT_MOVED,
  SPAWNED_EMBED_PLATFORMS,
  canEmbedSpawned,
  embedArgs,
  initMpvView,
  nativeHandle,
  screenRect,
  shouldShow,
  trackId,
};
