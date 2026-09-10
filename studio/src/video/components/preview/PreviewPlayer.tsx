/* ═══════════════════════════════════════════════════════════════════
   Program monitor.

   Performance notes:
     • The render loop reads the store imperatively via `getState()` and
       only re-paints the canvas when the frame actually changed. It does
       NOT subscribe to `playheadMs`, so playback never re-renders React.
     • The viewport is computed from a measured stage size, so the canvas,
       the gizmo and the overlays all share one coordinate system.
   ═══════════════════════════════════════════════════════════════════ */

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useTimelineStore, getContentEndMs } from '../../store/timelineStore';
import { useProjectStore } from '../../store/projectStore';
import { useLayoutStore } from '../../store/layoutStore';
import { useRecorderStore } from '../../store/recorderStore';
import { computeViewport, viewToCanvas, hitTestBox, getClipBox } from '../../engine/geometry';
import { getNaturalSize } from '../../engine/compositor';
import { getVisibleClipsAt } from '../../store/timelineStore';
import { TransformGizmo } from '../canvas/TransformGizmo';
import { AlignmentBar } from '../canvas/AlignmentBar';
import { PlaybackControls } from './PlaybackControls';
import { useMeasure } from '../../hooks/useMeasure';
import { useProgramLoop } from '../../hooks/useProgramLoop';
import { useDensity } from '../../hooks/useDensity';
import { useAnchoredMenu } from '../ui/Overlays';
import { audioEngine } from '../../engine/audioEngine';
import type { ContextMenuItem } from '../../store/uiStore';
import {
  Grid3x3, Ratio, Film, Magnet, ZoomIn, ZoomOut, Maximize2, Gauge, Eye, Download,
} from '../ui/icons';

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/**
 * The narrowest transport bar that can still hold the master meters.
 *
 * Measured in the running app, not derived: the bar's content at its floors
 * is the mirror (88) + gap (12) + the transport's minimum (336) + gap (12) +
 * the meters' floor (88), inside 14px of padding on each side. Below this the
 * bar is over-full, and it does not clip — it paints over the column beside it.
 */
const TRANSPORT_METERS_MIN = 564;

/**
 * @param headerNav Chrome the *pane* wants in the monitor's header, on the
 *   left, reading as navigation beside the `Program` label.
 *
 *   This used to be a `stageOverlay` floating on the stage's floor, and before
 *   that on the monitor column's floor — where it covered mark-in, mark-out and
 *   the speed control as soon as the transport wrapped. The stage was a safer
 *   floor but still the wrong one: it sat over the picture and pushed the
 *   alignment shelf up to clear it. The header is chrome that never wraps and
 *   never overlaps anything, and it has the room — measured free space beside
 *   the label is 179px at `xs`, 279px at `sm` and 120px at `md`, against a bar
 *   of 147px, 147px and 81px.
 *
 *   At `lg` the bar is no longer empty: the inspector's minimize toggle lives
 *   there at every width, so a seated inspector can be put away. The header is
 *   effectively full at `lg`, and what pays for the toggle is the format strip
 *   above — it is `truncate` and not `flex-shrink-0`, so it yields characters
 *   rather than pushing the row over. The toggle is drawn icon-only wherever
 *   the inspector is seated, to keep that bill small.
 */
export const PreviewPlayer: React.FC<{ headerNav?: React.ReactNode }> = ({ headerNav }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stageRef, stageSize] = useMeasure<HTMLDivElement>();
  const [transportRef, transportSize] = useMeasure<HTMLDivElement>();
  const density = useDensity();
  const openMenu = useAnchoredMenu();

  const project = useProjectStore((s) => s.project);
  const tracksSignature = useTimelineStore((s) => s.tracks);
  /*
    A take that is being RECORDED owns the machine.

    `electron/screenRecorder.cjs` turns background throttling off and
    hides the window for the duration, which is right — the capture lives
    in this renderer and a throttled rAF would drop its frames. But it
    also means every other loop in here keeps running at full speed
    behind a window nobody can see, and this is the expensive one: the
    programme loop would go on compositing the LAST take at full rate
    while the encoder for the next one is asking for the same GPU. So it
    yields, exactly as it yields to an export.
  */
  const recorderPhase = useRecorderStore((s) => s.phase);
  const isCapturing = recorderPhase === 'countdown' || recorderPhase === 'recording'
    || recorderPhase === 'paused' || recorderPhase === 'processing';
  const setDurationMs = useProjectStore((s) => s.setDurationMs);
  const isExporting = useProjectStore((s) => s.isExporting);
  const exportProgress = useProjectStore((s) => s.exportProgress);
  const setExportModalOpen = useProjectStore((s) => s.setExportModalOpen);

  const {
    showSafeAreas, showRuleOfThirds, showCinemaLetterbox, showScopes,
    toggleSafeAreas, toggleRuleOfThirds, toggleCinemaLetterbox, toggleScopes,
  } = useLayoutStore();

  const guidesEnabled = useTimelineStore((s) => s.magneticCanvasGuides);
  const toggleCanvasGuides = useTimelineStore((s) => s.toggleCanvasGuides);
  const selectClip = useTimelineStore((s) => s.selectClip);
  const hasSelection = useTimelineStore((s) => s.selectedClipIds.length > 0);

  /* ── Zoom / fit ── */
  const [zoomMode, setZoomMode] = useState<'fit' | number>('fit');
  /* The monitor's fullscreen button opens the SHARED Player — the same
     one Home opens — rather than the `position: fixed` div this used to
     grow into. That div was fullscreen-looking and nothing else: no
     receding overlays, no Copilot, and a second copy of the transport. */
  const isPlayerOpen = useLayoutStore((s) => s.isPlayerOpen);
  const openPlayer = useLayoutStore((s) => s.openPlayer);
  const [meters, setMeters] = useState({ l: 0.04, r: 0.04, peak: 0 });

  /*
    The optical inset around the picture. The gizmo is an overlay and must
    not shrink the picture by a second, hidden margin — so these are the
    only numbers that decide how much of the stage the frame gets.

    They SCALE WITH THE PANE. 18px of padding either side is 8% of a 452px
    panel and 3% of a 1200px one; held constant it read as generous on the
    desktop and as wasted picture in the panel, where the frame is already
    the smallest thing on screen. The `MAX_CANVAS_WIDTH` ceiling exists so
    a very wide pane does not blow the monitor up past what the timeline
    below it can balance, and it lifts with the tier for the same reason.
  */
  const STAGE_PAD_X = density.isTight ? 8 : density.isCompact ? 12 : 18;
  const STAGE_PAD_TOP = density.isCompact ? 8 : 16;
  const STAGE_PAD_BOTTOM = density.isCompact ? 8 : 12;
  const MAX_CANVAS_WIDTH = density.rank >= 3 ? 960 : 720;
  const stageInner = useMemo(
    () => ({
      width: Math.max(1, stageSize.width - STAGE_PAD_X * 2),
      height: Math.max(1, stageSize.height - STAGE_PAD_TOP - STAGE_PAD_BOTTOM),
    }),
    [stageSize.width, stageSize.height, STAGE_PAD_X, STAGE_PAD_TOP, STAGE_PAD_BOTTOM]
  );

  const fitScale = useMemo(
    () => Math.min(stageInner.width / project.width, stageInner.height / project.height, MAX_CANVAS_WIDTH / project.width),
    [stageInner, project.width, project.height, MAX_CANVAS_WIDTH]
  );

  const zoomFactor = zoomMode === 'fit' ? 1 : zoomMode / Math.max(0.0001, fitScale);

  const viewport = useMemo(() => {
    // Fit within the padded box, but centre against the true stage bounds.
    const fitted = computeViewport(stageInner.width, stageInner.height, project, zoomFactor);
    return {
      ...fitted,
      offsetX: STAGE_PAD_X + (stageInner.width - fitted.displayWidth) / 2,
      offsetY: STAGE_PAD_TOP + (stageInner.height - fitted.displayHeight) / 2,
    };
  }, [stageInner, stageSize.width, stageSize.height, project, zoomFactor, STAGE_PAD_X, STAGE_PAD_TOP]);

  const effectiveScale = viewport.scale;

  /*
    The canvas's BACKING STORE, which is not the sequence's size and
    never was allowed to be.

    It was `project.width x project.height`. A screen recording off a
    3024x1964 laptop becomes a 2560x1662 sequence (`canvasFor` caps the
    long edge), so every preview frame composited 4.25 million pixels
    into an element the operator was looking at inside `MAX_CANVAS_WIDTH`
    — 960 CSS px at the widest tier. Two thirds of every pixel drawn was
    thrown away by the browser on its way to the screen.

    So the surface follows what is on screen: the displayed box, times
    the device pixel ratio, and never larger than the sequence itself
    (upscaling a 720p take to a 4K canvas would invent detail and charge
    for it). `DPR_CAP` is there because a 3x phone-class ratio triples the
    fill for a difference nobody has ever reported seeing on a monitor.

    Zoom is already inside `viewport.displayWidth`, so zooming to 200%
    genuinely gets more pixels rather than a blur — which is the one
    thing a fixed cap would have got wrong.
  */
  const surface = useMemo(() => {
    const DPR_CAP = 2;
    /*
      `useMeasure` reports 0x0 until the box is laid out, so the first
      frame is drawn against a viewport that does not exist yet. Without
      a floor that is a 2px canvas stretched across the whole stage for
      one paint — a flash of garbage rather than a soft first frame.
    */
    const MIN_EDGE = 320;
    const ratio = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, DPR_CAP);
    const wanted = Math.round(viewport.displayWidth * ratio);
    const width = Math.min(project.width, Math.max(MIN_EDGE, wanted));
    const height = Math.max(2, Math.round(width * (project.height / project.width)));
    return { width, height };
  }, [viewport.displayWidth, project.width, project.height]);

  /*
    The one thing `draft` gives up, said where it is given up.

    Motion blur is skipped in the preview and kept in the export (see
    `RenderQuality`). An operator who is not told that will read the
    difference as the export having invented something.
  */
  const draftHidesBlur = useMemo(
    () => tracksSignature.some((t) => t.type !== 'audio'
      && t.clips.some((c) => c.motionBlur?.enabled && c.motionBlur.samples > 1)),
    [tracksSignature]
  );

  /* ── Render loop ──────────────────────────────────────────────
     Owned by `useProgramLoop`, and yielded while the fullscreen
     Player is open. The loop drives the audio graph and every <video>
     element as well as the canvas, so exactly one of the two may run:
     two would sync the same media twice per frame from two callers.

     An export is the third claimant and takes the same yield.
     `seekVideosForFrame` parks those very elements on the frame it is
     encoding, so a preview still running beside it would scrub them
     back to the playhead between frames — and the file would come out
     holding whichever of the two wrote last. */
  useProgramLoop({
    canvasRef,
    project,
    active: !isPlayerOpen && !isExporting && !isCapturing,
    onMeters: setMeters,
  });

  /* ── Keep project duration >= content ── */
  useEffect(() => {
    const end = getContentEndMs(tracksSignature);
    if (end > project.durationMs) setDurationMs(Math.ceil(end / 1000) * 1000);
  }, [tracksSignature, project.durationMs, setDurationMs]);

  /* ── Click-to-select on the canvas ── */

  const handleStagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const stage = stageRef.current;
      if (!stage) return;

      const rect = stage.getBoundingClientRect();
      const point = viewToCanvas({ x: e.clientX - rect.left, y: e.clientY - rect.top }, viewport);

      const state = useTimelineStore.getState();
      const visible = getVisibleClipsAt(state.tracks, state.playheadMs);

      // Topmost first: the visible list is bottom-up, so walk it backwards.
      for (let i = visible.length - 1; i >= 0; i--) {
        const { clip } = visible[i];
        if (clip.type === 'audio') continue;
        const box = getClipBox(clip, project, state.playheadMs, getNaturalSize(clip));
        if (hitTestBox(point, box)) {
          selectClip(clip.id, e.shiftKey);
          return;
        }
      }

      if (!e.shiftKey) selectClip(null);
    },
    [stageRef, viewport, project, selectClip]
  );

  /* ── Zoom controls ── */

  const stepZoom = (direction: 1 | -1) => {
    const current = zoomMode === 'fit' ? fitScale : zoomMode;
    const idx = ZOOM_STEPS.findIndex((z) => z > current + 0.001);
    const next =
      direction === 1
        ? ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, idx === -1 ? ZOOM_STEPS.length - 1 : idx)]
        : ZOOM_STEPS[Math.max(0, (idx === -1 ? ZOOM_STEPS.length : idx) - 2)];
    setZoomMode(next);
  };

  const zoomLabel = zoomMode === 'fit' ? 'Fit' : `${Math.round(zoomMode * 100)}%`;

  /* ── The overlays ──────────────────────────────────────────────
     ONE list, two shapes. The segmented group and the folded menu are
     both generated from this, so a sixth overlay is one line here and
     appears in both — rather than the two hand-written copies that
     would otherwise have drifted the first time one was added. */
  const overlays = [
    { id: 'safe', active: showSafeAreas, toggle: toggleSafeAreas, icon: Ratio, title: 'Action & title safe margins' },
    { id: 'thirds', active: showRuleOfThirds, toggle: toggleRuleOfThirds, icon: Grid3x3, title: 'Rule-of-thirds grid' },
    { id: 'scope', active: showCinemaLetterbox, toggle: toggleCinemaLetterbox, icon: Film, title: '2.39:1 letterbox matte' },
    { id: 'guides', active: guidesEnabled, toggle: toggleCanvasGuides, icon: Magnet, title: 'Smart alignment guides' },
    { id: 'scopes', active: showScopes, toggle: toggleScopes, icon: Gauge, title: 'Video scopes' },
  ];
  const activeOverlays = overlays.filter((o) => o.active).length;
  const overlayMenu: ContextMenuItem[] = overlays.map((o) => ({
    id: o.id,
    label: o.active ? `${o.title} · on` : o.title,
    icon: o.icon,
    onSelect: o.toggle,
  }));

  return (
    /* The monitor column sits on chrome, not on the app backdrop —
       measured off the approved editor, where this plane is the single
       largest surface on the screen. */
    <div className="editor-program-inner flex-1 flex flex-col min-h-0 bg-spectrum-panelHeader relative">
      {/* ── Monitor bar ──────────────────────────────────────────────
          Three things, always in this order: what you are looking at,
          what is drawn over it, and how big it is drawn. Which of the
          three you can SEE depends on the tier — but the order never
          changes, so the fullscreen button is at the same end of the bar
          in a 400px panel as it is on a 1400px display.

          The five overlay switches are the interesting case. On the
          desktop they are five icons in a segmented group, glanced at
          constantly and named rarely, which is exactly what a segmented
          group is for. Below `lg` those same five icons are 150px of a
          452px bar, competing with the zoom controls for the last 40 of
          them — so they fold into one switch that says how many are on,
          and opens the five as a menu. Folding is not hiding: the menu
          carries the same five names, and the button carries the count,
          so "something is being drawn over my picture" stays visible at
          every width. That was the one fact worth keeping on the bar.  */}
      <div className="editor-program-header flex items-center justify-between gap-2 flex-shrink-0 border-b border-line bg-spectrum-panelHeader">
        <div className="flex items-center gap-2 min-w-0">
          {/* The shared panel title, not a hand-typed copy of it: the
              library and the monitor wear the same label control in the
              reference, and re-typing it is how they drifted apart. */}
          <span className="panel-title flex-shrink-0">Program</span>
          {density.rank >= 2 && (
            <>
              <span className="w-px h-3 bg-line flex-shrink-0" />
              <span className="text-ui-xs text-spectrum-textDim font-mono truncate tabular">
                {density.hasLabels
                  ? `${project.width}×${project.height} · ${project.fps} fps · Rec.709`
                  : `${project.height}p · ${project.fps}`}
              </span>
            </>
          )}
          {headerNav}
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {density.hasLabels ? (
            <div className="seg-group">
              {overlays.map((o) => (
                <OverlayToggle key={o.id} active={o.active} onClick={o.toggle} icon={o.icon} title={o.title} />
              ))}
            </div>
          ) : (
            <button
              onClick={(e) => openMenu(e, overlayMenu)}
              className={`pro-btn editor-tool-btn relative ${activeOverlays > 0 ? 'pro-btn-active' : ''}`}
              title={`View overlays${activeOverlays > 0 ? ` · ${activeOverlays} on` : ''}`}
              aria-label="View overlays"
              aria-haspopup="menu"
            >
              <Eye className="w-3.5 h-3.5" weight={activeOverlays > 0 ? 'fill' : 'regular'} />
              {activeOverlays > 0 && <span className="pro-badge">{activeOverlays}</span>}
            </button>
          )}

          <div className="seg-group">
            {!density.isTight && (
              <button onClick={() => stepZoom(-1)} className="seg-item !px-1.5" title="Zoom out" aria-label="Zoom out">
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => setZoomMode(zoomMode === 'fit' ? 1 : 'fit')}
              className="seg-item font-mono min-w-[42px]"
              title="Toggle fit / 100%"
              aria-label="Toggle fit / 100%"
            >
              {zoomLabel}
            </button>
            {!density.isTight && (
              <button onClick={() => stepZoom(1)} className="seg-item !px-1.5" title="Zoom in" aria-label="Zoom in">
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* The one control that leaves the editor with a file. It keeps
              its place while a render is running and wears the percentage,
              because the dialog can be dismissed and the export cannot: a
              running render with nowhere on screen is one nobody cancels. */}
          {isExporting && (
            <button
              type="button"
              onClick={() => setExportModalOpen(true)}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/25 text-emerald-400 text-xs transition-colors cursor-pointer"
              title={`Exporting: ${Math.round(exportProgress)}% — click to view`}
            >
              <div className="w-10 h-1 bg-black/40 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-400 rounded-full transition-all"
                  style={{ width: `${Math.max(4, Math.min(100, Math.round(exportProgress)))}%` }}
                />
              </div>
              <span className="text-[10px] font-mono font-semibold tabular-nums">
                {Math.round(exportProgress)}%
              </span>
            </button>
          )}

          <button
            onClick={() => setExportModalOpen(true)}
            className={`pro-btn editor-tool-btn relative ${isExporting ? 'pro-btn-active' : ''}`}
            title={isExporting ? `Exporting · ${Math.round(exportProgress)}%` : 'Export video'}
            aria-label={isExporting ? `Exporting, ${Math.round(exportProgress)} percent` : 'Export video'}
          >
            <Download className="w-3.5 h-3.5" />
            {isExporting && <span className="pro-badge">{Math.round(exportProgress)}</span>}
          </button>

          <button
            onClick={openPlayer}
            className="pro-btn editor-tool-btn"
            title="Play fullscreen"
            aria-label="Play fullscreen">
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Stage ── */}
      <div
        ref={stageRef}
        onPointerDown={(e) => { audioEngine.resume(); handleStagePointerDown(e); }}
        className="editor-program-stage flex-1 relative min-h-0 overflow-hidden stage-bed"
      >
        {/* Canvas + overlays, positioned exactly on the computed viewport */}
        <div
          className="absolute"
          style={{
            left: viewport.offsetX,
            top: viewport.offsetY,
            width: viewport.displayWidth,
            height: viewport.displayHeight,
          }}
        >
          {/* The picture floats above the bed, as the approved editor
              draws it: an 11px corner, a long soft drop and a single
              hairline. It was a hard-edged rectangle on a vignette. */}
          <div className="absolute inset-0 overflow-hidden bg-black rounded-squircle-md shadow-stage">
            <canvas
              ref={canvasRef}
              width={surface.width}
              height={surface.height}
              className="w-full h-full block"
            />
          </div>

          {/* Rule of thirds */}
          {showRuleOfThirds && (
            <div className="absolute inset-0 pointer-events-none z-10">
              {[1, 2].map((i) => (
                <div key={`v${i}`} className="absolute top-0 bottom-0 w-px bg-spectrum-control" style={{ left: `${(i * 100) / 3}%` }} />
              ))}
              {[1, 2].map((i) => (
                <div key={`h${i}`} className="absolute left-0 right-0 h-px bg-spectrum-control" style={{ top: `${(i * 100) / 3}%` }} />
              ))}
            </div>
          )}

          {/* Safe areas */}
          {showSafeAreas && (
            <div className="absolute inset-0 pointer-events-none z-10">
              <div className="absolute border border-spectrum-amber/40" style={{ inset: '5%' }} />
              <div className="absolute border border-spectrum-accent/40" style={{ inset: '10%' }} />
              <div className="absolute left-1/2 top-1/2 w-4 h-px bg-spectrum-control -translate-x-1/2" />
              <div className="absolute left-1/2 top-1/2 w-px h-4 bg-spectrum-control -translate-y-1/2" />
            </div>
          )}

          {/* Cinemascope mattes */}
          {showCinemaLetterbox && (
            <div className="absolute inset-0 pointer-events-none z-10 flex flex-col justify-between">
              <div className="w-full bg-black/92" style={{ height: '11.6%' }} />
              <div className="w-full bg-black/92" style={{ height: '11.6%' }} />
            </div>
          )}

          {/*
            The preview draws at draft quality and skips motion blur, which
            is worth roughly three times the frame rate on this timeline —
            see `RenderQuality`. It is also the one thing an operator could
            mistake for the export having invented something, so it is said
            here rather than left to be discovered in the finished file.
            Only shown when a clip under this project actually asks for it.
          */}
          {draftHidesBlur && (
            <div className="absolute bottom-2 left-2 z-10 pointer-events-none">
              <span
                className="flex items-center gap-1 h-5 px-1.5 rounded-squircle-xs bg-black/60 border border-white/10
                           text-micro text-white/70 backdrop-blur-sm"
                title="Motion blur is rendered on export. The preview skips it to stay responsive."
              >
                Preview · motion blur off
              </span>
            </div>
          )}
        </div>

        {/*
          The gizmo and its guides live at STAGE level, not inside the canvas
          wrapper: they position themselves with `canvasToView`, which already
          adds the viewport offset. Nesting them would apply it twice.
        */}
        <div className="absolute inset-0 pointer-events-none">
          <TransformGizmo viewport={viewport} stageRef={stageRef} />
        </div>

        {/* Scopes */}
        {showScopes && <ScopesOverlay canvasRef={canvasRef} />}

        {/* Zoom readout — only when the view is not simply fitted. */}
        {zoomMode !== 'fit' && (
          <div className="absolute top-2.5 left-2.5 glass rounded-squircle-xs px-2 h-6 flex items-center text-ui-xs font-mono text-spectrum-textMuted tabular z-30 pointer-events-none">
            {Math.round(effectiveScale * 100)}%
          </div>
        )}

        {/*
          Layer tools float over the stage instead of claiming a permanent
          bar: they are only meaningful while something is selected, and a
          row that appears and disappears would shift the picture each time.
        */}
        {hasSelection && (
          <div className="editor-align-shelf absolute bottom-3 left-1/2 -translate-x-1/2 z-30 animate-slide-up">
            <div className="glass rounded-squircle-md shadow-pop px-1.5 py-1">
              <AlignmentBar />
            </div>
          </div>
        )}

      </div>

      {/*
        ── Transport ──

        The meters are gated on the bar's OWN width, not on `data-tier`.
        The tier is the pane's width, but this bar only gets what the seated
        library and inspector leave behind: at tier `lg` with both seated the
        bar is 439px, and at `md` it is 339px, where the tier gate says the
        meters may stay. Their floor plus the transport's minimum needs
        TRANSPORT_METERS_MIN, so below that the bar overflowed and painted its
        own controls and the meters over the inspector beside it — measured at
        111px of spill at `lg` and 211px at `md`.

        `sm`/`xs` still drop the meters through the tier gate; this is the same
        decision, taken where the tier cannot see the width.
      */}
      <div
        ref={transportRef}
        data-narrow={transportSize.width > 0 && transportSize.width < TRANSPORT_METERS_MIN ? '' : undefined}
        className="editor-program-transport flex-shrink-0 px-[14px] pt-[10px] pb-[11px] border-t border-line bg-spectrum-panel flex items-stretch gap-3"
      >
        <div className="flex-1 min-w-0">
          <PlaybackControls />
        </div>
        <LevelMeters left={meters.l} right={meters.r} peak={meters.peak} />
      </div>
    </div>
  );
};

/* ── Small pieces ───────────────────────────────────────────────── */

/**
 * Master output meters.
 *
 * Channel letters and a fixed clip mark are what turn two coloured bars
 * into an instrument you can actually read: without them you can see that
 * something is loud, but not which side, or how close to clipping.
 */
const LevelMeters: React.FC<{ left: number; right: number; peak: number }> = ({ left, right, peak }) => (
  <div className="flex items-center gap-2 flex-shrink-0 pl-3 border-l border-line" title="Master output level">
    <div className="flex flex-col gap-[3px] justify-center">
      {(['L', 'R'] as const).map((ch) => (
        <span key={ch} className="text-micro font-mono font-semibold text-spectrum-textFaint leading-[7px]">
          {ch}
        </span>
      ))}
    </div>
    <div className="flex flex-col justify-center gap-[3px] w-[92px]">
      {[left, right].map((value, i) => (
        <div key={i} className="relative h-[7px] rounded-squircle-2xs bg-spectrum-sunken border border-line overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 transition-[width] duration-75"
            style={{
              width: `${Math.min(100, value * 100)}%`,
              background: value > 0.88
                ? 'linear-gradient(to right,#33c98d,#f0a92e 70%,#ee5a63)'
                : 'linear-gradient(to right,#2aa876,#33c98d)',
            }}
          />
          {/* 0 dBFS */}
          <div className="absolute inset-y-0 w-px bg-spectrum-control" style={{ left: '88%' }} />
          {peak > 0.05 && (
            <div className="absolute top-0 bottom-0 w-px bg-spectrum-control" style={{ left: `${Math.min(99, peak * 100)}%` }} />
          )}
        </div>
      ))}
    </div>
  </div>
);

/** Icon-only overlay switch. Its `on` state is accent-tinted, not just filled,
    because these read as "the monitor is showing something extra". */
const OverlayToggle: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  title: string;
}> = ({ active, onClick, icon: Icon, title }) => (
  <button onClick={onClick} className={`seg-item !px-1.5 ${active ? 'seg-item-on' : ''}`} title={title}
            aria-label={title}>
    <Icon className="w-3.5 h-3.5" />
  </button>
);

/**
 * Luma waveform + RGB parade sampled straight from the program canvas.
 * Throttled to ~8fps — scopes don't need frame parity and reading pixels
 * back off the GPU is the expensive part.
 */
const ScopesOverlay: React.FC<{ canvasRef: React.RefObject<HTMLCanvasElement | null> }> = ({ canvasRef }) => {
  const scopeRef = useRef<HTMLCanvasElement>(null);
  /*
    The scopes read pixels back off the GPU, and where they read them
    from is the whole cost of this component.

    It used to call `getImageData(0, 0, source.width, source.height)` on
    the PROGRAM canvas — the full frame, 2560x1662 on a screen recording,
    which is 17MB of readback eight times a second, each one a hard
    pipeline stall while the GPU finishes everything queued. It also
    asked that canvas for a `willReadFrequently` context, which is a
    request to take the program canvas off the GPU permanently. The
    comment above it read "downsample by reading a strided slice"; the
    code did not do that and never had.

    So the frame is scaled DOWN onto a 160x90 scratch first — one
    `drawImage` the GPU does at native speed — and 57KB is read back off
    that instead. The scopes are sampling at 160x90 either way; the only
    thing the full-size read ever bought was the stall.
  */
  const sampleRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let frame = 0;
    let lastRun = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - lastRun < 120) return;
      lastRun = now;

      const source = canvasRef.current;
      const target = scopeRef.current;
      if (!source || !target) return;
      if (source.width === 0 || source.height === 0) return;

      const tctx = target.getContext('2d');
      if (!tctx) return;

      const SAMPLE_W = 160;
      const SAMPLE_H = 90;

      if (!sampleRef.current) {
        const c = document.createElement('canvas');
        c.width = SAMPLE_W;
        c.height = SAMPLE_H;
        sampleRef.current = c;
      }
      const sample = sampleRef.current;
      const sctx = sample.getContext('2d', { willReadFrequently: true });
      if (!sctx) return;

      let data: ImageData;
      try {
        sctx.drawImage(source, 0, 0, SAMPLE_W, SAMPLE_H);
        data = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
      } catch {
        return; // tainted canvas (cross-origin media). Scopes unavailable
      }

      const W = target.width;
      const H = target.height;
      tctx.clearRect(0, 0, W, H);
      tctx.fillStyle = 'rgba(8,9,12,0.88)';
      tctx.fillRect(0, 0, W, H);

      /* Every pixel of the sample, because the sample IS the downsample.
         The stride this used to walk was over the full-size frame, which
         is no longer what was read back. */
      tctx.globalCompositeOperation = 'lighter';

      const pixels = data.data;
      for (let y = 0; y < SAMPLE_H; y++) {
        for (let x = 0; x < SAMPLE_W; x++) {
          const i = (y * SAMPLE_W + x) * 4;
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          const px = (x / SAMPLE_W) * W;

          const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          tctx.fillStyle = 'rgba(120,220,160,0.14)';
          tctx.fillRect(px, H - luma * H, 1, 1.4);

          tctx.fillStyle = 'rgba(255,70,70,0.09)';
          tctx.fillRect(px, H - (r / 255) * H, 1, 1);
          tctx.fillStyle = 'rgba(70,255,120,0.09)';
          tctx.fillRect(px, H - (g / 255) * H, 1, 1);
          tctx.fillStyle = 'rgba(80,150,255,0.09)';
          tctx.fillRect(px, H - (b / 255) * H, 1, 1);
        }
      }

      tctx.globalCompositeOperation = 'source-over';

      // IRE reference lines.
      tctx.strokeStyle = 'rgba(255,255,255,0.12)';
      tctx.lineWidth = 1;
      for (const ire of [0, 0.25, 0.5, 0.75, 1]) {
        tctx.beginPath();
        tctx.moveTo(0, H - ire * H + 0.5);
        tctx.lineTo(W, H - ire * H + 0.5);
        tctx.stroke();
      }
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [canvasRef]);

  return (
    <div className="absolute top-2.5 right-2.5 z-30 rounded-squircle-sm overflow-hidden shadow-pop">
      <div className="px-2 h-5 flex items-center bg-spectrum-panelHeader border-b border-line text-micro font-semibold text-spectrum-textDim uppercase tracking-[0.08em]">
        Waveform / Parade
      </div>
      <canvas ref={scopeRef} width={200} height={110} className="block bg-spectrum-sunken" />
    </div>
  );
};
