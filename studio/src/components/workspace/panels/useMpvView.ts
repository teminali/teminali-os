import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { boundsEqual, isOverlayOpen, type BrowserViewBounds } from "../../../services/browserView";
import {
  embeddedPictureBounds,
  mpvViewBridge,
  type MpvCommandContext,
  type MpvFrameAnswer,
  type MpvPlayerCommand,
  type MpvViewState,
} from "../../../services/mpvView";

/**
 * The player pane's other picture: mpv's window, where there is one.
 *
 * `MediaPlayer` is a `<video>` element and everything that has to be true
 * around one. This hook is the fork — the whole of what changes when the
 * picture is not an element at all but a native child window mpv draws into
 * (`electron/mpvView.cjs`, B3). It asks for the engine, hands it the file,
 * tells it where to be, relays what it says about itself, and gives it back.
 *
 * **It answers `embedded: false` on almost every machine, and that is normal
 * rather than a failure.** A browser build has no bridge. macOS has the bridge
 * and refuses, because a process cannot embed another process's window there,
 * and keeps the element until a linked `libmpv` exists. Windows and Linux
 * embed. So every caller must draw both, and the element path must stay
 * exactly what it was — which is why nothing here reaches into the pane, and
 * why `embedded` is false until main has said otherwise rather than optimistic
 * and corrected.
 *
 * The rectangle is not measured here either: `services/browserView.ts` solved
 * that for the browser panel and `embeddedPictureBounds` adds the one thing it
 * did not need — subtracting the chrome, which an OS window cannot be drawn
 * under. See that function for why.
 */

let sequence = 0;

/**
 * A name for one pane's claim on the engine.
 *
 * It is not the workspace panel's id, deliberately. The pane is handed a path
 * and a title and no panel — `FilePane` renders it without one — and main only
 * needs a stable token to tell one claimant from another and to refuse the
 * second. Per mount, so a pane that is closed and reopened is a new claimant
 * and cannot inherit a claim it did not make.
 */
export function nextMpvViewId(): string {
  sequence += 1;
  return `mpv-view-${sequence}`;
}

export interface MpvSurfaceOptions {
  /** False for audio and while there is nothing to play. Nothing is asked for. */
  enabled: boolean;
  /** The file mpv should open — absolute, since mpv has no workspace root. */
  filePath: string | null;
  /** The pane. Its rectangle, less the chrome, is where the picture goes. */
  surfaceRef: { current: Element | null };
  /** The bars drawn above and below the picture; either may be absent. */
  topChromeRef: { current: Element | null };
  bottomChromeRef: { current: Element | null };
  /** Position, duration, paused, ended — as mpv observes them changing. */
  onState: (state: MpvViewState) => void;
}

export interface MpvSurface {
  /** True only where mpv actually holds the picture. */
  embedded: boolean;
  /** The last refusal, for the operator. Null when nothing has been refused. */
  reason: string | null;
  /** One contract action to the engine. A no-op when nothing is embedded. */
  command: (command: MpvPlayerCommand, context?: MpvCommandContext) => void;
  /**
   * One frame of mpv's picture, or **null where mpv does not hold it**.
   *
   * Null rather than a function that answers "not embedded" so that the pane
   * can hand this straight to `registerPlayerFrameSource` as the whole of the
   * fork: a source with no engine capture is the element path, and there is
   * nowhere for the two to be true at once.
   *
   * It is also null on a build whose preload has no `frame` — a packaged app
   * older than this bridge — which is the same fallback for the same reason.
   */
  frame: (() => Promise<MpvFrameAnswer>) | null;
}

export function useMpvView({
  enabled, filePath, surfaceRef, topChromeRef, bottomChromeRef, onState,
}: MpvSurfaceOptions): MpvSurface {
  const bridge = useMemo(() => mpvViewBridge(), []);
  const [id] = useState(nextMpvViewId);
  const [embedded, setEmbedded] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  /* ── Asking for the engine ──────────────────────────────────────────── */
  useEffect(() => {
    if (!bridge || !enabled) {
      setEmbedded(false);
      return;
    }
    let live = true;
    void bridge
      .ensure(id)
      .then((answer) => {
        if (!live) return;
        setEmbedded(answer.ok);
        if (!answer.ok) setReason(answer.reason ?? null);
      })
      .catch(() => {
        // A bridge that throws is a bridge that is not there. The element path
        // is the answer to that, and it needs no sentence.
        if (live) setEmbedded(false);
      });
    return () => {
      live = false;
      // Giving the engine back is this hook's, on every exit: an unmount, and
      // equally a pane that has turned out to be audio. Main refuses a second
      // claimant while a first still holds one, so a claim that is not
      // released is the next video failing to embed for no visible reason.
      try { bridge.destroy(id); } catch { /* already gone */ }
    };
  }, [bridge, enabled, id]);

  /* ── Handing it the file ────────────────────────────────────────────── */
  useEffect(() => {
    if (!bridge || !embedded || !filePath) return;
    let live = true;
    void bridge
      .load(id, filePath)
      .then((answer) => {
        if (live && !answer.ok) {
          // Falling back rather than showing black: the element could not open
          // some of what mpv can, but it opens most of it, and a pane with a
          // picture beats a pane with a reason.
          setReason(answer.reason ?? null);
          setEmbedded(false);
          try { bridge.destroy(id); } catch { /* already gone */ }
        }
      })
      .catch(() => {
        if (live) setEmbedded(false);
      });
    return () => { live = false; };
  }, [bridge, embedded, filePath, id]);

  /* ── What mpv says about itself ─────────────────────────────────────── */
  // Held in a ref so that a handler rebuilt on every render — which it is, it
  // closes over the pane's state — does not tear down the subscription and
  // miss whatever mpv said in between.
  const listener = useRef(onState);
  listener.current = onState;
  useEffect(() => {
    if (!bridge || !embedded) return;
    return bridge.onState((state) => {
      if (state.id === id) listener.current(state);
    });
  }, [bridge, embedded, id]);

  /* ── Where the picture is, and whether it may be seen ────────────────── */
  const last = useRef<{ bounds: BrowserViewBounds; visible: boolean } | null>(null);
  const report = useCallback((visible: boolean) => {
    if (!bridge) return;
    const bounds = embeddedPictureBounds(surfaceRef.current, {
      top: topChromeRef.current,
      bottom: bottomChromeRef.current,
    });
    // Both observers fire through a resize drag; sending only what changed
    // keeps that off the process boundary sixty times a second. Visibility is
    // part of the comparison because it is the half that matters most: an
    // unchanged rectangle that has become hidden must still be sent.
    if (last.current && last.current.visible === visible && boundsEqual(last.current.bounds, bounds)) return;
    last.current = { bounds, visible };
    bridge.setBounds(id, bounds, visible);
  }, [bridge, id, surfaceRef, topChromeRef, bottomChromeRef]);

  useLayoutEffect(() => {
    if (!bridge || !embedded) return;
    const show = () => report(!isOverlayOpen());
    show();
    // The chrome is observed as well as the pane: the bars decide the band the
    // picture gets, so a title that wraps to two lines moves the video.
    const observer = new ResizeObserver(show);
    for (const ref of [surfaceRef, topChromeRef, bottomChromeRef]) {
      if (ref.current) observer.observe(ref.current);
    }
    // The pane can move without resizing — a splitter drag, a sidebar collapse
    // — and an overlay can open without either.
    const overlays = new MutationObserver(show);
    overlays.observe(document.body, { childList: true, subtree: true, attributeFilter: ["style", "class"] });
    window.addEventListener("resize", show);
    return () => {
      observer.disconnect();
      overlays.disconnect();
      window.removeEventListener("resize", show);
      last.current = null;
      // Unmount is a tab switch as often as it is a close, and in both the
      // picture must stop being drawn before anything else happens.
      bridge.setBounds(id, { x: 0, y: 0, width: 0, height: 0 }, false);
    };
  }, [bridge, embedded, id, report, surfaceRef, topChromeRef, bottomChromeRef]);

  const command = useCallback((action: MpvPlayerCommand, context?: MpvCommandContext) => {
    if (!bridge || !embedded) return;
    void bridge
      .command(id, action, context)
      .then((answer) => {
        if (!answer.ok) setReason(answer.reason ?? null);
      })
      .catch(() => { /* the exit handler below reports the engine going away */ });
  }, [bridge, embedded, id]);

  const frame = useMemo(() => {
    if (!bridge || !embedded || typeof bridge.frame !== "function") return null;
    // No `setReason` on a failure, unlike `command`: a frame is asked for by
    // the agent, never by the operator, and the operator watching the film has
    // done nothing that a sentence under their scrubber would explain. The
    // reason goes back up to the agent, which is who asked.
    return () => bridge.frame(id).catch((error: unknown) => ({
      ok: false,
      reason: String((error as { message?: string })?.message ?? error),
    }));
  }, [bridge, embedded, id]);

  // Memoised because the pane hangs `runCommand` off it, and `runCommand` is
  // what the agent's command stream is subscribed through: a fresh object each
  // render would tear that subscription down and rebuild it every render.
  return useMemo(() => ({ embedded, reason, command, frame }), [embedded, reason, command, frame]);
}
