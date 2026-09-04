/* ═══════════════════════════════════════════════════════════════════
   Timeline toolbar.

   THE RULE HERE IS "NOTHING IS EVER CLIPPED". This row used to be a
   hand-written sequence of buttons with fixed labels, which is fine at
   1200px and a bug at the 452px the panel opens at: "Duplicate" became
   "Du", the zoom slider and its readout overlapped, and the Add-track
   button fell off the end entirely. A control you cannot see is a
   feature you do not have.

   So the row is now a LIST, not markup. Every tool declares the tier
   from which it earns a seat on the bar; below that tier it moves into
   the overflow menu, still reachable, still labelled, still carrying
   its shortcut. Nothing is removed at any size — the 16 tools that
   exist at 1200px all exist at 400px, and the only thing that changes
   is whether you reach one in one click or two.

   Labels follow the same rule one step later: they appear at `lg`,
   because a label is the first thing worth spending width on and the
   first thing worth giving back.
   ═══════════════════════════════════════════════════════════════════ */

import React from 'react';
import { BASE_PX_PER_MS, MIN_ZOOM, MAX_ZOOM, useTimelineStore, getContentEndMs } from '../../store/timelineStore';
import { useProjectStore } from '../../store/projectStore';
import { useUiStore, type ContextMenuItem } from '../../store/uiStore';
import { detectBeats } from '../../engine/beatDetect';
import { useDensity, type Tier } from '../../hooks/useDensity';
import { useAnchoredMenu } from '../ui/Overlays';
import {
  Scissors, Trash2, Copy, Magnet, ZoomIn, ZoomOut, Plus, ArrowLeftRight, Snowflake,
  RotateCcw, Unlink, Flag, Layers, Music4, Maximize, DotsThree,
} from '../ui/icons';

interface TimelineToolbarProps {
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

/** A tool on the bar, or in the menu when the bar cannot afford it. */
interface Tool {
  id: string;
  label: string;
  /** The tooltip, which is also the menu row's accessible name. */
  title: string;
  shortcut?: string;
  icon: React.ElementType;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Sticky mode rather than a one-shot action — drawn as a switch. */
  on?: boolean;
  /** The narrowest tier at which this tool gets a seat on the bar. */
  from: Tier;
  /** A count pinned to the corner, e.g. how many markers exist. */
  badge?: number;
  /** Starts a new visual group on the bar. */
  groupStart?: boolean;
}

const RANK: Record<Tier, number> = { xs: 0, sm: 1, md: 2, lg: 3 };

export const TimelineToolbar: React.FC<TimelineToolbarProps> = ({ scrollRef }) => {
  const density = useDensity();
  const openMenu = useAnchoredMenu();

  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const snappingEnabled = useTimelineStore((s) => s.snappingEnabled);
  const rippleEditMode = useTimelineStore((s) => s.rippleEditMode);
  const zoomLevel = useTimelineStore((s) => s.zoomLevel);
  const markerCount = useTimelineStore((s) => s.markers.length);

  const splitAtPlayhead = useTimelineStore((s) => s.splitAtPlayhead);
  const deleteSelected = useTimelineStore((s) => s.deleteSelected);
  const duplicateClip = useTimelineStore((s) => s.duplicateClip);
  const toggleSnapping = useTimelineStore((s) => s.toggleSnapping);
  const toggleRippleEdit = useTimelineStore((s) => s.toggleRippleEdit);
  const setZoomLevel = useTimelineStore((s) => s.setZoomLevel);
  const zoomToFit = useTimelineStore((s) => s.zoomToFit);
  const addTrack = useTimelineStore((s) => s.addTrack);
  const addMarker = useTimelineStore((s) => s.addMarker);
  const setBeatMarkers = useTimelineStore((s) => s.setBeatMarkers);
  const groupSelected = useTimelineStore((s) => s.groupSelected);
  const freezeFrame = useTimelineStore((s) => s.freezeFrame);
  const reverseClip = useTimelineStore((s) => s.reverseClip);
  const detachAudio = useTimelineStore((s) => s.detachAudio);

  const pushToast = useUiStore((s) => s.pushToast);
  const project = useProjectStore((s) => s.project);

  /* One pixel is worth this many milliseconds at the current zoom. */
  const pxPerMs = BASE_PX_PER_MS * zoomLevel;

  const hasSelection = selectedClipIds.length > 0;
  const primaryId = selectedClipIds[0];

  const handleZoomFit = React.useCallback(() => {
    const el = scrollRef.current;
    const state = useTimelineStore.getState();
    const contentEnd = Math.max(getContentEndMs(state.tracks), project.durationMs);
    if (el && contentEnd > 0) zoomToFit(el.clientWidth - 40, contentEnd);
  }, [scrollRef, project.durationMs, zoomToFit]);

  const handleDetectBeats = React.useCallback(async () => {
    const state = useTimelineStore.getState();
    const audioClip = state.tracks
      .filter((t) => t.type === 'audio')
      .flatMap((t) => t.clips)
      .find((c) => c.mediaUrl);

    if (!audioClip?.mediaUrl) {
      pushToast({ kind: 'error', title: 'No audio to analyse', detail: 'Add a music clip to an audio track first.' });
      return;
    }

    const id = pushToast({ kind: 'progress', title: 'Detecting beats…', progress: 20 });
    try {
      const result = await detectBeats(audioClip.mediaUrl, audioClip.startTimeMs);
      setBeatMarkers(result.beatsMs);
      useUiStore.getState().dismissToast(id);
      pushToast({
        kind: 'success',
        title: `${result.beatsMs.length} beats detected`,
        detail: `≈ ${Math.round(result.bpm)} BPM. Markers added to the timeline.`,
      });
    } catch (err) {
      useUiStore.getState().dismissToast(id);
      pushToast({ kind: 'error', title: 'Beat detection failed', detail: (err as Error).message });
    }
  }, [pushToast, setBeatMarkers]);

  /*
    The tools, in bar order.

    `from` is the editorial decision this file exists to make, and the
    order is CapCut's: cut and remove first, because they are 80% of an
    edit; the modes next, because they change what the first two do;
    then the transforms; then the analysis. Duplicate is `sm` rather
    than `xs` for the same reason ⌘D exists — it is the one of the three
    with a keyboard route everyone already knows.
  */
  const tools: Tool[] = React.useMemo(() => [
    { id: 'split', label: 'Split', title: 'Split at playhead', shortcut: 'S', icon: Scissors, run: splitAtPlayhead, from: 'xs' },
    { id: 'delete', label: 'Delete', title: 'Delete selection', shortcut: '⌫', icon: Trash2, run: deleteSelected, disabled: !hasSelection, danger: true, from: 'xs' },
    { id: 'duplicate', label: 'Duplicate', title: 'Duplicate clip', shortcut: '⌘D', icon: Copy, run: () => primaryId && duplicateClip(primaryId), disabled: !hasSelection, from: 'sm' },

    { id: 'snap', label: 'Snap', title: 'Magnetic snapping', shortcut: 'N', icon: Magnet, run: toggleSnapping, on: snappingEnabled, from: 'xs', groupStart: true },
    { id: 'ripple', label: 'Ripple', title: 'Ripple edit, downstream clips follow', shortcut: 'R', icon: ArrowLeftRight, run: toggleRippleEdit, on: rippleEditMode, from: 'sm' },

    { id: 'freeze', label: 'Freeze frame', title: 'Freeze frame at playhead', icon: Snowflake, run: () => primaryId && freezeFrame(primaryId, useTimelineStore.getState().playheadMs), disabled: !hasSelection, from: 'md', groupStart: true },
    { id: 'reverse', label: 'Reverse', title: 'Reverse clip', icon: RotateCcw, run: () => primaryId && reverseClip(primaryId), disabled: !hasSelection, from: 'md' },
    { id: 'detach', label: 'Detach audio', title: 'Detach audio from video', icon: Unlink, run: () => primaryId && detachAudio(primaryId), disabled: !hasSelection, from: 'md' },
    { id: 'group', label: 'Group', title: 'Group selected clips', shortcut: '⌘G', icon: Layers, run: groupSelected, disabled: selectedClipIds.length < 2, from: 'lg' },

    { id: 'marker', label: 'Add marker', title: 'Add marker', shortcut: 'M', icon: Flag, run: () => addMarker(useTimelineStore.getState().playheadMs), badge: markerCount || undefined, from: 'sm', groupStart: true },
    { id: 'beats', label: 'Detect beats', title: 'Detect beats from the music track', icon: Music4, run: () => { void handleDetectBeats(); }, from: 'md' },

    { id: 'addtrack', label: 'Add track', title: 'Add a new track', icon: Plus, run: () => addTrack('video'), from: 'md', groupStart: true },
  ], [
    splitAtPlayhead, deleteSelected, duplicateClip, toggleSnapping, toggleRippleEdit,
    freezeFrame, reverseClip, detachAudio, groupSelected, addMarker, addTrack,
    handleDetectBeats, hasSelection, primaryId, snappingEnabled, rippleEditMode,
    selectedClipIds.length, markerCount,
  ], );

  const onBar = tools.filter((t) => RANK[t.from] <= density.rank);
  const inMenu = tools.filter((t) => RANK[t.from] > density.rank);

  /* The zoom cluster is the same idea applied to one control: the slider
     is the first thing to go, because [−] and [+] do its whole job in
     less than a quarter of its width, and the ms/px readout is the
     second, because it is a diagnostic rather than a control. */
  const showZoomSlider = density.rank >= RANK.md;
  const showZoomReadout = density.rank >= RANK.lg;

  const menuItems: ContextMenuItem[] = [
    ...inMenu.map((t) => ({
      id: t.id,
      label: t.on !== undefined ? `${t.label}${t.on ? ' · on' : ''}` : t.label,
      shortcut: t.shortcut,
      icon: t.icon,
      danger: t.danger,
      disabled: t.disabled,
      separatorBefore: t.groupStart,
      onSelect: t.run,
    })),
    ...(showZoomSlider ? [] : [{
      id: 'zoomfit',
      label: 'Zoom to fit sequence',
      shortcut: '⇧Z',
      icon: Maximize,
      separatorBefore: inMenu.length > 0,
      onSelect: handleZoomFit,
    }]),
  ];

  return (
    <div className="editor-timeline-toolbar flex items-center justify-between gap-2 flex-shrink-0">
      {/* The bar itself. `min-w-0` plus `overflow-hidden` is the promise
          that this row can never push the zoom cluster off the end — if
          the arithmetic above is ever wrong, the failure is a hidden
          button, not a broken layout. */}
      <div className="editor-toolbar-tools flex items-center gap-1 min-w-0 overflow-hidden">
        {onBar.map((tool) => (
          <React.Fragment key={tool.id}>
            {tool.groupStart && <Sep />}
            <ToolButton tool={tool} showLabel={density.hasLabels} />
          </React.Fragment>
        ))}

        {menuItems.length > 0 && (
          <>
            <Sep />
            <button
              onClick={(e) => openMenu(e, menuItems, 'left')}
              className="pro-btn editor-tool-btn"
              title={`${menuItems.length} more tools`}
              aria-label={`${menuItems.length} more tools`}
              aria-haspopup="menu"
            >
              <DotsThree className="w-4 h-4" weight="bold" />
            </button>
          </>
        )}
      </div>

      {/* Zoom */}
      <div className="editor-toolbar-zoom flex items-center gap-1 flex-shrink-0">
        {showZoomSlider && (
          <button onClick={handleZoomFit} className="pro-btn editor-tool-btn" title="Zoom to fit sequence (⇧Z)" aria-label="Zoom to fit sequence (⇧Z)">
            <Maximize className="w-3.5 h-3.5" />
          </button>
        )}
        <button onClick={() => setZoomLevel(zoomLevel / 1.4)} className="pro-btn editor-tool-btn" title="Zoom out (−)" aria-label="Zoom out (−)">
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        {showZoomSlider && (
          <input
            type="range"
            /* Logarithmic, and its ends are the store's real limits rather
               than two numbers that used to match them. */
            min={Math.log10(MIN_ZOOM)}
            max={Math.log10(MAX_ZOOM)}
            step={0.01}
            value={Math.log10(zoomLevel)}
            onChange={(e) => setZoomLevel(Math.pow(10, Number(e.target.value)))}
            className="editor-zoom-slider range-accent"
            title={`Timeline zoom · ${zoomLevel.toFixed(2)}×`}
            aria-label="Timeline zoom"
          />
        )}
        <button onClick={() => setZoomLevel(zoomLevel * 1.4)} className="pro-btn editor-tool-btn" title="Zoom in (+)" aria-label="Zoom in (+)">
          <ZoomIn className="w-3.5 h-3.5" />
        </button>

        {/*
          What one pixel is worth at this zoom, and the frame it lands in.
          `msPerPx` is the honest number — a frame at this project's fps is
          1000/fps ms, and the readout says which frame the playhead is
          actually on rather than implying that a video frame exists
          between two frames.

          At `md` and below this collapses to the frame number alone, and
          the ms/px figure survives as the cluster's tooltip. The readout
          was 96px of the 452px the panel opens at.
        */}
        <span
          className="well editor-zoom-readout flex items-center gap-1.5 font-mono flex-shrink-0"
          title={`${(1 / pxPerMs).toFixed(3)} ms per pixel at ${zoomLevel.toFixed(2)}×`}
        >
          {showZoomReadout && (
            <>
              <span className="text-ui-xs text-spectrum-text tabular">{(1 / pxPerMs).toFixed(1)}</span>
              <span className="text-micro text-spectrum-textFaint">ms/px</span>
              <span className="w-px h-3 bg-line" />
            </>
          )}
          <PlayheadFrameBadge fps={project.fps} />
        </span>
      </div>
    </div>
  );
};

const PlayheadFrameBadge: React.FC<{ fps: number }> = React.memo(({ fps }) => {
  const playheadMs = useTimelineStore((s) => s.playheadMs);
  const frameAtPlayhead = Math.floor((playheadMs / 1000) * fps);
  return <span className="text-ui-xs text-spectrum-textDim tabular">f{frameAtPlayhead}</span>;
});

/* ── Buttons ────────────────────────────────────────────────────── */

const Sep: React.FC = () => <div className="editor-toolbar-sep" aria-hidden="true" />;

/**
 * One tool.
 *
 * A sticky mode and a one-shot action are DIFFERENT SHAPES, not the same
 * shape in two colours: a mode that is on carries a filled surface and a
 * hairline it keeps, an action carries neither. That distinction used to
 * be made by putting the modes in a `.seg-group` and the actions outside
 * it, which worked until the group was the thing that had to collapse.
 */
const ToolButton: React.FC<{ tool: Tool; showLabel: boolean }> = ({ tool, showLabel }) => {
  const Icon = tool.icon;
  const isMode = tool.on !== undefined;
  return (
    <button
      onClick={tool.run}
      disabled={tool.disabled}
      className={`${isMode ? 'pro-btn' : 'pro-btn-filled'} editor-tool-btn relative ${
        tool.on ? 'pro-btn-active' : ''
      } ${showLabel ? 'has-label' : ''}`}
      title={tool.shortcut ? `${tool.title} (${tool.shortcut})` : tool.title}
      aria-label={tool.title}
      aria-pressed={isMode ? tool.on : undefined}
    >
      <Icon
        className={`w-3.5 h-3.5 flex-shrink-0 ${tool.danger ? 'text-spectrum-red/85' : ''}`}
        weight={tool.on ? 'fill' : 'regular'}
      />
      {showLabel && <span className="truncate">{tool.label}</span>}
      {tool.badge !== undefined && tool.badge > 0 && (
        <span className="pro-badge">{tool.badge > 99 ? '99+' : tool.badge}</span>
      )}
    </button>
  );
};
