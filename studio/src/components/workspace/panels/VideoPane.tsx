import React, { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { useMeasure } from "../../../video/hooks/useMeasure";
import { PreviewPlayer } from "../../../video/components/preview/PreviewPlayer";
import { InspectorPanel } from "../../../video/components/inspector/InspectorPanel";
import { Timeline } from "../../../video/components/timeline/Timeline";

/* ── The Cut's own numbers ──────────────────────────────────────────────────
   Read off `teminaliCut/src/store/layoutStore.ts` and its editor shell in
   `teminaliCut/src/App.tsx`, not estimated. The first version of this pane
   guessed 300px / 46% / 220px, which is close enough to look right and wrong
   enough that the two editors drift apart the first time either is tuned.
   ───────────────────────────────────────────────────────────────────────── */

/** `layoutStore` DEFAULTS.inspectorWidth. Its own clamp is 240–520. */
const INSPECTOR_W = 296;
/** `layoutStore` DEFAULTS.timelineHeight, and the value its splitter resets to. */
const TIMELINE_H = 291;
/** `setTimelineHeight`'s lower clamp — below this the lanes stop being legible. */
const TIMELINE_MIN_H = 140;
/** `.editor-program`'s `min-w-[280px]`. The monitor is never thinner than this. */
const MONITOR_MIN_W = 280;

/**
 * The width at which the Cut's two-column upper band can exist at all.
 *
 * This is the number the measurement actually turned up, and it is the reason
 * this pane needed more than new constants: **576px is wider than the 452px
 * this workspace panel opens at**. In the Cut the inspector is a column you
 * can collapse; here it has to start collapsed and be summoned, because there
 * is no honest way to seat a 296px inspector and a 280px monitor in 452px.
 */
const TWO_COLUMN_MIN_W = INSPECTOR_W + MONITOR_MIN_W;

/**
 * The video editor pane — the Teminali Cut editor, mounted as a panel.
 *
 * Three regions, which is the layout the Cut itself uses and the one every
 * NLE uses: the program monitor and the inspector share the upper band, and
 * the timeline takes the floor across the full width. The timeline is the
 * only one with a fixed height, because it is the only one whose content has
 * a natural one — a lane is 30px and you want four or five without thinking.
 *
 * Unlike the Cut, this pane does not own splitters. The panel's own left edge
 * is already a resize handle, and the tab strip's expand button already swaps
 * 452px for 736px, so the pane reads its width instead of storing one: past
 * `TWO_COLUMN_MIN_W` the inspector is a column, under it a summonable overlay.
 *
 * `.video-workspace` is load-bearing, not decorative. Every ported class and
 * every ported CSS variable is scoped to it, so the editor cannot leak its
 * `.card`, `.chip` or `--line` into the rest of the shell, and the shell's
 * own values keep winning inside it wherever the two systems overlap.
 *
 * The two sheets this pane depends on — `src/video/video-tokens.css` and
 * `src/video/video-components.css` — are imported from `src/index.css`, not
 * from here: the component sheet uses `@apply`, which only resolves in the
 * file carrying the `@tailwind` directives.
 *
 * The slice reaches for no Electron IPC at all — 54 files, zero references to
 * `electronAPI` — which is why it can mount here unchanged. Import, export
 * and recording stay in Teminali Cut for now; those are the parts that
 * genuinely need the host process.
 */
export const VideoPane: React.FC = () => {
  const [paneRef, { width, height }] = useMeasure<HTMLDivElement>();
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // `width` is 0 for the single layout pass before the observer reports, and
  // 452px is the panel's default — so treat unmeasured as narrow. Guessing
  // wide there is what would flash a 151px monitor on every tab switch.
  const twoColumn = width >= TWO_COLUMN_MIN_W;

  // The Cut keeps the timeline at a fixed 291px and lets the monitor take the
  // rest. That only holds while the monitor still has somewhere to be; in a
  // short pane the timeline yields rather than pushing the monitor to nothing.
  const timelineHeight =
    height > 0
      ? Math.max(TIMELINE_MIN_H, Math.min(TIMELINE_H, Math.round(height * 0.55)))
      : TIMELINE_H;

  const showInspector = twoColumn || inspectorOpen;

  return (
    <div ref={paneRef} className="video-workspace">
      <div className="flex-1 flex min-h-0 relative">
        <div className="flex-1 flex min-w-0 min-h-0">
          <PreviewPlayer />
        </div>

        {showInspector && (
          <div
            className={
              twoColumn
                ? "flex-shrink-0 min-h-0"
                : // No room for a column, so the inspector visits instead of
                  // living here. It covers the monitor rather than crushing it,
                  // which is the same trade the Cut makes at its own minimum.
                  "absolute right-0 top-0 bottom-0 z-20 shadow-pop"
            }
            style={{ width: Math.min(INSPECTOR_W, Math.max(0, width - 24)) }}
          >
            <InspectorPanel />
          </div>
        )}

        {/* The collapse affordance. The Cut puts this at the monitor's top
            corner, but the ported monitor bar already owns both of its top
            corners, so it sits on the seam instead — the one edge in this band
            that has nothing on it at any width. */}
        {!twoColumn && (
          <button
            type="button"
            onClick={() => setInspectorOpen((open) => !open)}
            title={inspectorOpen ? "Hide the inspector" : "Show the inspector"}
            className="pro-btn absolute top-1/2 -translate-y-1/2 z-30 w-3.5 h-14 !px-0 bg-spectrum-panel/90"
            style={{ right: inspectorOpen ? Math.min(INSPECTOR_W, Math.max(0, width - 24)) : 0 }}
          >
            {inspectorOpen ? (
              <ChevronRight className="w-3 h-3" />
            ) : (
              <ChevronLeft className="w-3 h-3" />
            )}
          </button>
        )}
      </div>

      <div className="flex-shrink-0 min-h-0" style={{ height: timelineHeight }}>
        <Timeline />
      </div>
    </div>
  );
};
