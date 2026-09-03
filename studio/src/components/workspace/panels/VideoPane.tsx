import React, { useCallback, useEffect, useRef, useState } from "react";

import { useMeasure } from "../../../video/hooks/useMeasure";
import { useTransportShortcuts } from "../../../video/hooks/useTransportShortcuts";
import { DensityProvider, densityFor, TIER_MIN } from "../../../video/hooks/useDensity";
import { PreviewPlayer } from "../../../video/components/preview/PreviewPlayer";
import { InspectorPanel } from "../../../video/components/inspector/InspectorPanel";
import { Timeline } from "../../../video/components/timeline/Timeline";
import { ContextMenu, Toasts } from "../../../video/components/ui/Overlays";
import { FolderOpen, Sliders, X } from "../../../video/components/ui/icons";
import { MediaPanel } from "../../sidebar/MediaPanel";

/* ── The Cut's own numbers ──────────────────────────────────────────────────
   Read off `teminaliCut/src/store/layoutStore.ts` and its editor shell in
   `teminaliCut/src/App.tsx`, not estimated. The first version of this pane
   guessed 300px / 46% / 220px, which is close enough to look right and wrong
   enough that the two editors drift apart the first time either is tuned.
   ───────────────────────────────────────────────────────────────────────── */

/** `layoutStore` DEFAULTS.inspectorWidth. Its own clamp is 240–520. */
const INSPECTOR_W = 296;
/** `layoutStore` DEFAULTS.sidebarWidth, which is the Cut's library rail. */
const LIBRARY_W = 264;
/** `layoutStore` DEFAULTS.timelineHeight, and the value its splitter resets to. */
const TIMELINE_H = 291;
/** `setTimelineHeight`'s lower clamp — below this the lanes stop being legible. */
const TIMELINE_MIN_H = 140;
/** The monitor is never shorter than this, however hard the timeline pulls. */
const MONITOR_MIN_H = 150;
/** `.editor-program`'s `min-w-[280px]`. The monitor is never thinner than this. */
const MONITOR_MIN_W = 280;

/** The width at which the inspector can be a column beside the monitor. */
const INSPECTOR_COLUMN_MIN_W = INSPECTOR_W + MONITOR_MIN_W;
/** And the width at which the library can join it, making three columns. */
const LIBRARY_COLUMN_MIN_W = LIBRARY_W + MONITOR_MIN_W + INSPECTOR_W;

/**
 * The video editor pane — the Teminali Cut editor, mounted as a panel.
 *
 * ## The shape, and why it changes
 *
 * Four regions, which is the layout CapCut uses and the one every NLE uses:
 * a media library, a program monitor and an inspector share the upper band,
 * and the timeline takes the floor across the full width.
 *
 * What is new is that the band's THREE COLUMNS ARE EARNED, not assumed. The
 * pane measures itself and spends the width it actually has, in the order a
 * cutter needs it:
 *
 *   ≥ 840px  library │ monitor │ inspector — the desktop editor.
 *   ≥ 576px          │ monitor │ inspector — the library visits as an overlay.
 *   <  576px         │ monitor │           — both visit; the monitor keeps the
 *                                            room, because a video editor that
 *                                            cannot show you the video is not
 *                                            one.
 *
 * That last row is the case this pane was failing. **The panel opens at 452px**
 * — narrower than a 296px inspector and a 280px monitor can share — so under
 * `INSPECTOR_COLUMN_MIN_W` the side panels are summoned rather than seated,
 * and on the tightest tier they arrive as sheets over the monitor instead of
 * as columns crushing it. Everything remains reachable at every width; only
 * the number of clicks changes. That is the whole of the mobile lesson.
 *
 * ## The splitter
 *
 * The band and the timeline are separated by a real drag handle. The previous
 * version derived the timeline's height from the pane's and gave the operator
 * no say, which is defensible on a desktop where 291px is right and wrong in a
 * 380px-tall panel where the only two useful answers are "mostly monitor" and
 * "mostly lanes". The height is clamped to the pane on every resize, so a
 * height chosen when the panel was tall cannot strand the monitor when it is
 * short.
 *
 * ## The library
 *
 * `MediaPanel` is the shell's own media pool surface, mounted here as the
 * editor's library rail. It is the SAME component the sidebar's Media tab
 * renders, reading the same `mediaPool` out of `timelineStore` — not a second
 * copy — so an import made in either place appears in both.
 *
 * The sidebar tab stays exactly where it is, and that is a safety property
 * rather than an oversight: import from disk is where consent for a file and
 * its folder is granted, and a consent surface that only exists while one
 * workspace panel happens to be open is not a consent surface. See
 * `src/video/P3-import-gate.md`.
 *
 * ## Scoping
 *
 * `.video-workspace` is load-bearing, not decorative. Every ported class and
 * every ported CSS variable is scoped to it, so the editor cannot leak its
 * `.card`, `.chip` or `--line` into the rest of the shell, and the shell's
 * own values keep winning inside it wherever the two systems overlap.
 * `data-tier` and `data-vtier` on the same element are how the stylesheet
 * asks the question this component already answered, so the tier is decided
 * once rather than re-derived in CSS against a different box.
 *
 * The two sheets this pane depends on — `src/video/video-tokens.css` and
 * `src/video/video-components.css` — are imported from `src/index.css`, not
 * from here: the component sheet uses `@apply`, which only resolves in the
 * file carrying the `@tailwind` directives.
 */
export const VideoPane: React.FC = () => {
  const [paneRef, { width, height }] = useMeasure<HTMLDivElement>();

  /* The transport keys the buttons advertise — Space, Home/End, ←/→, M, I,
     L. Scoped to this pane, which is the only one mounted while it lives. */
  useTransportShortcuts(paneRef);
  const density = densityFor(width, height);

  const canSeatInspector = width >= INSPECTOR_COLUMN_MIN_W;
  const canSeatLibrary = width >= LIBRARY_COLUMN_MIN_W;

  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);

  /* ── Minimising the seated inspector ───────────────────────────────────
     Wide enough to SEAT the inspector is not the same as wanting it: a
     296px rail is 296px the picture does not get, and the editor at its
     full width is exactly where someone watches rather than tweaks. So the
     column can be put away — and, like the splitter below, the choice is
     kept rather than silently replaced. It survives a trip down through the
     narrow tiers and back, so dragging the panel small does not quietly
     undo it. */
  const [inspectorMinimized, setInspectorMinimized] = useState(false);
  const inspectorSeated = canSeatInspector && !inspectorMinimized;

  /* ── The splitter ──────────────────────────────────────────────────────
     `null` means "you have not chosen", and the pane picks. Once dragged,
     the choice is kept and only ever clamped — never silently replaced,
     which is what makes a splitter feel like a splitter rather than a
     suggestion. */
  const [chosenTimelineH, setChosenTimelineH] = useState<number | null>(null);

  const maxTimelineH = Math.max(TIMELINE_MIN_H, height - MONITOR_MIN_H);
  const naturalTimelineH =
    height > 0 ? Math.max(TIMELINE_MIN_H, Math.min(TIMELINE_H, Math.round(height * 0.55))) : TIMELINE_H;
  const timelineHeight = Math.min(
    maxTimelineH,
    Math.max(TIMELINE_MIN_H, chosenTimelineH ?? naturalTimelineH)
  );

  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const handleSplitterDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: timelineHeight };
      const move = (ev: PointerEvent) => {
        const d = dragRef.current;
        if (!d) return;
        // Dragging UP grows the timeline, because the handle is its top edge.
        setChosenTimelineH(d.startH - (ev.clientY - d.startY));
      };
      const up = () => {
        dragRef.current = null;
        document.body.classList.remove("dragging-v");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      document.body.classList.add("dragging-v");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [timelineHeight]
  );

  /* A panel wide enough to seat a side panel does not also need it summoned:
     the column IS the open state, so the overlay flag is cleared when the
     column appears. Without this, dragging the panel wider left an overlay
     floating on top of the very column it was standing in for. */
  useEffect(() => {
    if (!canSeatInspector) return;
    /* Widening while the overlay stood OPEN is a request to see the
       inspector, so the column takes over and any earlier minimize is
       spent. Without this the overlay would be cleared into a minimized
       column and the inspector would vanish on the way up. */
    if (inspectorOpen) setInspectorMinimized(false);
    setInspectorOpen(false);
  }, [canSeatInspector, inspectorOpen]);
  useEffect(() => {
    if (canSeatLibrary) setLibraryOpen(false);
  }, [canSeatLibrary]);

  /*
    The summon controls.

    They ride the monitor's HEADER, beside the `Program` label, which is the
    one strip of this pane that never wraps and never has anything else on it.
    Two earlier homes were both floors: the monitor column's, where the bar sat
    on mark-in, mark-out and the speed selector as soon as the transport wrapped
    at `sm`; and the stage's, which cleared the controls but covered the picture
    and pushed the alignment shelf up to get out of its way. In the header it
    overlaps nothing and lifts nothing, and it reads as navigation, which is
    what it is. They are still the only chrome this pane adds to the ported
    editor.

    `Media` is drawn only when the library is not already seated, so the pane
    never offers to open something that is open. `Edit` is always drawn,
    because at every width it answers the same question — inspector, or
    picture — and only the mechanism behind it changes: seated, it minimizes
    the column; summoned, it opens the overlay. One control, so there is no
    second affordance to learn and no width at which the inspector cannot be
    put away.
  */
  const toggleInspector = useCallback(() => {
    if (canSeatInspector) setInspectorMinimized((m) => !m);
    else setInspectorOpen((o) => !o);
  }, [canSeatInspector]);

  const inspectorShown = inspectorSeated || inspectorOpen;

  const summonBar = (
    <div className="editor-summon-bar">
        {!canSeatLibrary && (
          <button
            onClick={() => setLibraryOpen((o) => !o)}
            className={`pro-btn editor-summon-btn ${libraryOpen ? "pro-btn-active" : ""}`}
            title={libraryOpen ? "Hide the media library" : "Show the media library"}
            aria-label={libraryOpen ? "Hide the media library" : "Show the media library"}
            aria-pressed={libraryOpen}
          >
            {libraryOpen ? <X className="w-3.5 h-3.5" /> : <FolderOpen className="w-3.5 h-3.5" />}
            <span>Media</span>
          </button>
        )}
        <button
          onClick={toggleInspector}
          className={`pro-btn editor-summon-btn ${inspectorShown ? "pro-btn-active" : ""}`}
          title={inspectorShown ? "Hide the inspector" : "Show the inspector"}
          aria-label={inspectorShown ? "Hide the inspector" : "Show the inspector"}
          aria-pressed={inspectorShown}
        >
          {inspectorShown ? <X className="w-3.5 h-3.5" /> : <Sliders className="w-3.5 h-3.5" />}
          {/* The word rides along only where the bar IS a summon bar. Where
              the inspector is seated the button is a minimize toggle in a
              header that is already full — at `lg` the format strip beside
              `Program` is what pays for anything added here, in truncated
              characters — so there the icon carries it alone, with the name
              still in the tooltip and the accessible label. */}
          {!canSeatInspector && <span>Edit</span>}
        </button>
    </div>
  );

  const overlayWidth = Math.min(INSPECTOR_W, Math.max(200, width - 48));
  const libraryOverlayWidth = Math.min(LIBRARY_W, Math.max(200, width - 48));

  return (
    <DensityProvider width={width} height={height}>
      <div ref={paneRef} className="video-workspace" data-tier={density.tier} data-vtier={density.vTier}>
        <div className="flex-1 flex min-h-0 relative">
          {/* ── Library ── */}
          {canSeatLibrary ? (
            <div className="editor-library-column flex-shrink-0 min-h-0" style={{ width: LIBRARY_W }}>
              <MediaPanel />
            </div>
          ) : (
            libraryOpen && (
              <>
                <div
                  className="editor-overlay-scrim"
                  onClick={() => setLibraryOpen(false)}
                  aria-hidden="true"
                />
                <div
                  className="editor-library-column editor-side-overlay is-left"
                  style={{ width: libraryOverlayWidth }}
                >
                  <MediaPanel />
                </div>
              </>
            )
          )}

          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <PreviewPlayer headerNav={summonBar} />
          </div>

          {/* ── Inspector ── */}
          {inspectorSeated ? (
            <div className="flex-shrink-0 min-h-0" style={{ width: INSPECTOR_W }}>
              <InspectorPanel />
            </div>
          ) : (
            !canSeatInspector && inspectorOpen && (
              <>
                <div
                  className="editor-overlay-scrim"
                  onClick={() => setInspectorOpen(false)}
                  aria-hidden="true"
                />
                {/*
                  On the tightest tier the inspector arrives as a SHEET from
                  the bottom rather than a rail from the side. A 296px rail in
                  a 452px pane leaves the monitor 156px, which is not a
                  monitor; the same 296px of controls laid across the full
                  width and up from the floor leaves the picture intact above
                  it. This is the one place the phone shape genuinely differs
                  from the desktop one rather than merely shrinking it.
                */}
                <div
                  className={density.isTight ? "editor-inspector-sheet" : "editor-side-overlay is-right"}
                  style={density.isTight ? undefined : { width: overlayWidth }}
                >
                  {density.isTight && (
                    <button
                      className="editor-sheet-grip"
                      onClick={() => setInspectorOpen(false)}
                      title="Close the inspector"
                      aria-label="Close the inspector"
                    >
                      <span className="editor-sheet-grip-bar" />
                    </button>
                  )}
                  <InspectorPanel />
                </div>
              </>
            )
          )}

        </div>

        {/* ── The splitter ── */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the timeline"
          tabIndex={0}
          onPointerDown={handleSplitterDown}
          onDoubleClick={() => setChosenTimelineH(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") setChosenTimelineH(timelineHeight + 16);
            else if (e.key === "ArrowDown") setChosenTimelineH(timelineHeight - 16);
            else return;
            e.preventDefault();
          }}
          className="editor-splitter"
          title="Drag to resize · double-click to reset"
        />

        <div className="flex-shrink-0 min-h-0" style={{ height: timelineHeight }}>
          <Timeline />
        </div>

        {/* The two surfaces the ported slice has always talked to. See
            `components/ui/Overlays.tsx` — they render here because the classes
            they wear are scoped to `.video-workspace`. */}
        <ContextMenu />
        <Toasts />
      </div>
    </DensityProvider>
  );
};

/* Re-exported for the layout test, which asserts that the pane's own
   thresholds and the density scale cannot drift apart. */
export { INSPECTOR_COLUMN_MIN_W, LIBRARY_COLUMN_MIN_W, TIMELINE_MIN_H, MONITOR_MIN_H, TIER_MIN };
