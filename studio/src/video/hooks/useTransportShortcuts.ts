import { useEffect } from 'react';
import { useTimelineStore } from '../store/timelineStore';
import { useProjectStore } from '../store/projectStore';

/**
 * The keyboard half of the transport.
 *
 * Every one of these keys was already ADVERTISED by the transport buttons —
 * `title="Play / pause (Space)"`, `"Go to start (Home)"`, `"Add marker (M)"`
 * and the rest — and none of them was bound anywhere in `src/`. DESIGN.md
 * forbids an affordance that does nothing, so the labels are read here as the
 * specification they always claimed to be: this hook binds exactly the eight
 * keys the buttons name, and nothing they do not. `O` for the out point is a
 * a standard NLE key and is deliberately absent, because no control offers it.
 *
 * Each key runs the SAME call its button runs — `stepPlayheadByFrames` is
 * shared with `PlaybackControls` rather than reimplemented — so the two input
 * paths cannot drift into disagreeing about what a frame step or a rewind is.
 *
 * ## When the editor owns a keystroke
 *
 * The listener is on `window`, because the pane's own subtree only sees keys
 * once something inside it has focus, and a freshly opened editor has focus on
 * nothing. `WorkspacePanel` mounts exactly one pane at a time, so while this
 * hook is alive the video editor IS the workspace. It still stands down when:
 *
 *   - a modal owns the screen (`[role="dialog"]` anywhere in the document);
 *   - the keystroke is being typed into a field, or a `<select>` — which is
 *     also what keeps the rate picker's own arrow handling intact;
 *   - focus sits on something outside the pane, such as the sidebar or the
 *     chat composer, since the editor is beside those, not over them;
 *   - a modifier is held, so the shell's own ⌘-shortcuts still land.
 *
 * Space and Enter activate a focused button natively; when the target is one,
 * the key is left to the browser rather than double-firing the transport.
 */

/** Fields that own their own keys. `select` also covers the rate picker. */
const TYPING_TAGS = /^(input|textarea|select)$/i;

const isTypingTarget = (el: Element | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || TYPING_TAGS.test(el.tagName);
};

/** Something the browser will itself activate on Space. */
const isActivatable = (el: Element | null): boolean =>
  el instanceof HTMLElement && el.closest('button, [role="button"], a[href]') !== null;

/**
 * Step the playhead by whole frames, clamped to the program.
 *
 * Exported because the ← / → buttons in `PlaybackControls` run it too — the
 * store's own `nudgePlayhead` clamps only at zero, which would let the keys
 * walk the playhead past the end where the buttons stop.
 *
 * **It counts in frames, not milliseconds, and lands on the boundary.** Adding
 * `frames * (1000 / fps)` is the obvious version and it is wrong at 30fps: the
 * store rounds the playhead to whole milliseconds, so one step from zero
 * stores 33ms, and `formatTimecode` floors 33ms against a 33.333ms frame and
 * reads it back as frame 0. Pressing → once appeared to do nothing. Rounding
 * to the current frame and taking the ceiling of the target's start puts the
 * playhead just inside the frame it names, which is what the readout agrees
 * with, and stepping back returns to exactly the value it came from.
 */
export function stepPlayheadByFrames(frames: number): void {
  const { fps, durationMs } = useProjectStore.getState().project;
  const { playheadMs, setPlayheadMs } = useTimelineStore.getState();
  const frameMs = 1000 / fps;
  const target = Math.max(0, Math.round(playheadMs / frameMs) + frames);
  setPlayheadMs(Math.min(durationMs, Math.ceil(target * frameMs)));
}

export function useTransportShortcuts(
  paneRef: React.RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const root = paneRef.current;
      if (!root) return;
      if (document.querySelector('[role="dialog"]')) return;

      const target = event.target as Element | null;
      if (isTypingTarget(target)) return;
      // Focus is either inside the editor, or on nothing at all.
      if (target && target !== document.body && !root.contains(target)) return;

      // Holding ← or → scrubs; every other key fires once per press.
      if (event.repeat && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

      const timeline = useTimelineStore.getState();
      const { durationMs } = useProjectStore.getState().project;

      switch (event.key) {
        case ' ':
          // A focused button is the browser's to activate.
          if (isActivatable(target)) return;
          if (useProjectStore.getState().isExporting) return;
          timeline.togglePlay(durationMs);
          break;
        case 'Home':
          timeline.setPlayheadMs(timeline.inPointMs ?? 0);
          break;
        case 'End':
          timeline.setPlayheadMs(timeline.outPointMs ?? durationMs);
          break;
        case 'ArrowLeft':
          stepPlayheadByFrames(-1);
          break;
        case 'ArrowRight':
          stepPlayheadByFrames(1);
          break;
        case 'm':
        case 'M':
          timeline.addMarker(timeline.playheadMs);
          break;
        case 'i':
        case 'I':
          timeline.setInPoint(timeline.inPointMs === null ? timeline.playheadMs : null);
          break;
        case 'l':
        case 'L':
          timeline.toggleLoop();
          break;
        default:
          return;
      }

      // Only reached when a key was handled — Space must not scroll the pane,
      // and Home/End must not jump a scroller inside it.
      event.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [paneRef]);
}
