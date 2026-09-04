import React from "react";
import { MonitorDot } from "lucide-react";

import { useMeasure } from "../../video/hooks/useMeasure";
import { DensityProvider, densityFor } from "../../video/hooks/useDensity";
import { Toasts } from "../../video/components/ui/Overlays";
import { RecorderPanel } from "../../video/components/recorder/RecorderPanel";
import { usePanelStore } from "../../store/panelStore";
import { useRecorderDialogStore } from "../../store/recorderDialogStore";
import { Modal } from "../ui/Modal";

/**
 * The screen recorder, as a dialog.
 *
 * ## Why a dialog and not a workspace panel
 *
 * It was a panel, and a panel was the wrong shape for it. A workspace panel
 * is a place you keep something — it persists across sessions, it sits in
 * the tab strip, it splits the window with the conversation. Recording is
 * none of those: it is a thing you start, watch, and finish, and while you
 * are choosing a display the conversation behind it is not what you are
 * looking at. It also wants width, and the panel gave it 452px — under the
 * 568px the options rail needs before it can be a column, so the rail was
 * summoned as an overlay on the recorder's own most common surface.
 *
 * The dialog answers all three: it is modal so it does not compete, it is
 * not persisted so a restored session does not open onto it, and it is wide
 * enough that the options rail seats without being summoned.
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
 * The recorder's own shape wants 568px before the options rail can be a
 * column. The width is measured here, once, and handed down, so the dialog
 * answers that question in one place rather than having the stylesheet
 * re-ask it against a different box. It is still measured rather than
 * assumed: `max-w-5xl` is a ceiling, and on a narrow window the dialog is
 * narrower than it.
 *
 * ## Why the panel switch is here and not in the recorder
 *
 * Everything under `src/video/` is workspace-agnostic — it knows about
 * tracks and clips, never about which tabs the shell has open. Opening the
 * video panel on a finished build is a workspace decision, so the recorder
 * reports that it built something and this wrapper, which is app-side
 * already, is what reaches for `panelStore`.
 */
export const RecorderModal: React.FC = () => {
  const isOpen = useRecorderDialogStore((state) => state.isOpen);
  const close = useRecorderDialogStore((state) => state.close);
  const [paneRef, { width, height }] = useMeasure<HTMLDivElement>();
  const density = densityFor(width, height);
  const focusOrOpen = usePanelStore((state) => state.focusOrOpen);

  /*
    Unmounted rather than hidden when it is shut, which is what makes
    `RecorderPanel`'s mount effect the thing that opens a session and its
    cleanup the thing that closes one. `Modal` already returns null when
    `isOpen` is false, so this is the same decision said twice — but it is
    said here because the measurement hook would otherwise run against a
    box that is not laid out.
  */
  if (!isOpen) return null;

  return (
    <Modal
      isOpen
      onClose={close}
      title="Record Screen"
      subtitle="A display or a window, with the camera and the microphone you choose."
      icon={<MonitorDot className="w-4 h-4 text-ink-muted" />}
      size="xl"
      /* A height, because the recorder is a fixed-chrome tool: the source
         grid scrolls inside it and the footer stays put. Without one the
         dialog grows and shrinks as the phase changes, and the Start button
         moves under the cursor between one frame and the next. */
      className="h-[78vh]"
      bodyClassName="flex-1 min-h-0 flex flex-col"
    >
      <DensityProvider width={width} height={height}>
        <div
          ref={paneRef}
          className="video-workspace flex-1 min-h-0 flex flex-col"
          data-tier={density.tier}
          data-vtier={density.vTier}
        >
          <RecorderPanel
            width={width}
            onOpenedOnTimeline={() => {
              /* The take is on the timeline, so the recorder has nothing
                 left to say. Closing first means the editor is not opening
                 behind a scrim the operator then has to dismiss. */
              close();
              focusOrOpen({ kind: "video" });
            }}
          />
          <Toasts />
        </div>
      </DensityProvider>
    </Modal>
  );
};
