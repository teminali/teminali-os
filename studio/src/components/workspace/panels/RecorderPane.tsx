import React from "react";

import { useMeasure } from "../../../video/hooks/useMeasure";
import { DensityProvider, densityFor } from "../../../video/hooks/useDensity";
import { Toasts } from "../../../video/components/ui/Overlays";
import { RecorderPanel } from "../../../video/components/recorder/RecorderPanel";
import { usePanelStore } from "../../../store/panelStore";

/**
 * The screen recorder, mounted as a workspace panel.
 *
 * ## Why this wrapper exists at all
 *
 * `.video-workspace` is load-bearing, not decorative. Every class the recorder
 * UI was ported wearing — `.seg-item`, `.pro-btn`, `.pro-input`, `.card` — is
 * scoped to it in `src/video/video-components.css`, and so are the ported CSS
 * variables. Outside that scope the panel is not "slightly off"; it is
 * unstyled.
 *
 * `<Toasts />` is the second half of the same fact. The recorder store pushes
 * to the video `useUiStore` — that is where its fault watchdog reports a take
 * that is recording nothing — and the toast surface only renders inside this
 * scope. Without it the one warning that can save a ruined recording is
 * invisible.
 *
 * ## The measurement
 *
 * The panel opens at 452px, and the recorder's own shape wants 568px before
 * the options rail can be a column. The width is measured here, once, and
 * handed down, so the pane answers that question in one place rather than
 * having the stylesheet re-ask it against a different box.
 *
 * ## Why the panel switch is here and not in the recorder
 *
 * Everything under `src/video/` is workspace-agnostic — it knows about
 * tracks and clips, never about which tabs the shell has open. Opening the
 * video panel on a finished build is a workspace decision, so the recorder
 * reports that it built something and this wrapper, which is app-side
 * already, is what reaches for `panelStore`.
 */
export const RecorderPane: React.FC = () => {
  const [paneRef, { width, height }] = useMeasure<HTMLDivElement>();
  const density = densityFor(width, height);
  const focusOrOpen = usePanelStore((state) => state.focusOrOpen);

  return (
    <DensityProvider width={width} height={height}>
      <div ref={paneRef} className="video-workspace" data-tier={density.tier} data-vtier={density.vTier}>
        <RecorderPanel width={width} onOpenedOnTimeline={() => focusOrOpen({ kind: "video" })} />
        <Toasts />
      </div>
    </DensityProvider>
  );
};
