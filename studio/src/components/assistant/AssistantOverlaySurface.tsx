import React, { useEffect, useState } from "react";

/**
 * The drawing on the screen.
 *
 * This is not part of the studio window. Electron mounts it in its own
 * transparent, click-through, always-on-top window sized to a display, and it
 * renders the same React and the same token sheet as everything else — which is
 * the reason it is a surface in `src/` rather than a hand-written HTML file in
 * `electron/`. A separate file would have needed its own copy of every colour,
 * and a copy of the token sheet is a copy that drifts.
 *
 * Two details carry the whole thing:
 *
 *  - **The ring is drawn twice.** A near-white stroke inside a dark one, so it
 *    is legible over a white document and over a black terminal without any
 *    glow, blur or gradient — none of which this design system has.
 *  - **Every coordinate here came from the accessibility API**, arriving as the
 *    frame of a real element. Nothing on this layer was estimated from a
 *    screenshot, which is why the ring lands on the control rather than near it.
 */

export interface OverlayTarget {
  /** In global screen points, exactly as the accessibility API reported it. */
  frame: { x: number; y: number; width: number; height: number };
  label: string;
}

export interface OverlayState {
  visible: boolean;
  /** The display this window covers, so frames can be made window-relative. */
  origin: { x: number; y: number };
  target: OverlayTarget | null;
  caption: string;
  /** "2 of 5", when a plan is being walked. */
  step: { index: number; total: number } | null;
  /** Drawn differently while something is actually being clicked. */
  acting: boolean;
}

const EMPTY: OverlayState = {
  visible: false,
  origin: { x: 0, y: 0 },
  target: null,
  caption: "",
  step: null,
  acting: false,
};

/** Padding around the element frame, so the ring never sits on the control. */
const HALO = 6;

export const AssistantOverlaySurface: React.FC = () => {
  const [state, setState] = useState<OverlayState>(EMPTY);

  useEffect(() => {
    // The window itself is painted by the compositor; anything opaque here
    // would show up as a grey sheet over the operator's screen.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const bridge = (window as unknown as {
      teminali?: {
        assistant?: {
          onOverlay?: (fn: (state: OverlayState) => void) => () => void;
          overlayState?: () => Promise<OverlayState>;
        };
      };
    }).teminali;

    // Pulled as well as pushed. The first push happens the instant the window
    // is created, which is before this effect exists to hear it.
    void bridge?.assistant?.overlayState?.().then((current) => {
      setState((previous) => (previous.visible ? previous : { ...EMPTY, ...current }));
    });
    return bridge?.assistant?.onOverlay?.((next) => setState({ ...EMPTY, ...next }));
  }, []);

  if (!state.visible) return null;

  const target = state.target;
  const box = target !== null
    ? {
        left: target.frame.x - state.origin.x - HALO,
        top: target.frame.y - state.origin.y - HALO,
        width: target.frame.width + HALO * 2,
        height: target.frame.height + HALO * 2,
      }
    : null;

  return (
    <div className="fixed inset-0 pointer-events-none select-none font-sans">
      {target && box && (
        <div
          key={`${box.left},${box.top},${box.width}`}
          className="absolute animate-overlayTarget"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        >
          {/* The outer stroke is the dark one. Drawing it outside the light
              stroke is what makes the ring readable on a white background,
              where a single near-white ring would disappear. */}
          <span className="absolute -inset-px rounded-xl border-2 border-frame-mid/70" />
          <span
            className={`absolute inset-0 rounded-xl border-2 ${state.acting ? "border-warning" : "border-accent"}`}
          />

          {/* The label sits above the control, or below it when the control is
              at the top of the screen and there is no room. */}
          <span
            className={`absolute left-0 whitespace-nowrap max-w-[420px] truncate rounded-lg bg-surface border border-edge-popover px-2 py-1 text-xs text-ink-bright ${
              box.top > 34 ? "-top-8" : "top-full mt-2"
            }`}
          >
            {state.step && (
              <span className="text-ink-faint mr-1.5 font-mono">
                {state.step.index}/{state.step.total}
              </span>
            )}
            {target.label}
          </span>
        </div>
      )}

      {/* What is being said, at the foot of the screen — the one place the eye
          can find it without knowing where to look. */}
      {state.caption && (
        <div className="absolute left-1/2 bottom-16 -translate-x-1/2 max-w-[640px] rounded-2xl bg-surface border border-edge-popover px-4 py-2.5">
          <p className="text-md text-ink-prose leading-snug text-center">{state.caption}</p>
        </div>
      )}
    </div>
  );
};
