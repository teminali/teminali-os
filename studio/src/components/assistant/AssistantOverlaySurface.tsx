import React, { useEffect, useRef, useState } from "react";
import { X, ArrowLeft, MousePointer2 } from "lucide-react";

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

interface AssistantBridge {
  onOverlay?: (fn: (state: OverlayState) => void) => () => void;
  overlayState?: () => Promise<OverlayState>;
  hideOverlay?: () => Promise<void>;
  focusStudio?: () => Promise<void>;
  setOverlayInteractive?: (interactive: boolean) => Promise<void>;
}

export const AssistantOverlaySurface: React.FC = () => {
  const [state, setState] = useState<OverlayState>(EMPTY);
  const dismissTimerRef = useRef<number | null>(null);

  const getBridge = (): AssistantBridge | undefined =>
    (window as unknown as { teminali?: { assistant?: AssistantBridge } }).teminali?.assistant;

  useEffect(() => {
    // The window itself is painted by the compositor; anything opaque here
    // would show up as a grey sheet over the operator's screen.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const bridge = getBridge();

    // Pulled as well as pushed. The first push happens the instant the window
    // is created, which is before this effect exists to hear it.
    void bridge?.overlayState?.().then((current) => {
      setState((previous) => (previous.visible ? previous : { ...EMPTY, ...current }));
    });
    return bridge?.onOverlay?.((next) => {
      setState({ ...EMPTY, ...next });
    });
  }, []);

  useEffect(() => {
    let wasInteractive = false;
    const handleMouseMove = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const isInteractive = Boolean(target?.closest?.('[data-interactive="true"]'));
      if (isInteractive !== wasInteractive) {
        wasInteractive = isInteractive;
        void getBridge()?.setOverlayInteractive?.(isInteractive);
      }
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  // Auto-dismiss caption after 8 seconds if the user doesn't interact with it
  useEffect(() => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    if (state.caption && !state.acting) {
      dismissTimerRef.current = window.setTimeout(() => {
        handleDismiss();
      }, 8000);
    }
    return () => {
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
      }
    };
  }, [state.caption, state.acting]);

  const handleDismiss = () => {
    const bridge = getBridge();
    void bridge?.setOverlayInteractive?.(false);
    void bridge?.hideOverlay?.();
    setState(EMPTY);
  };

  const handleBackToStudio = () => {
    const bridge = getBridge();
    void bridge?.setOverlayInteractive?.(false);
    void bridge?.focusStudio?.();
    void bridge?.hideOverlay?.();
    setState(EMPTY);
  };

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
          className="absolute animate-overlayTarget pointer-events-none"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        >
          {/* The outer stroke is the dark one. Drawing it outside the light
              stroke is what makes the ring readable on a white background,
              where a single near-white ring would disappear. */}
          <span className="absolute -inset-px rounded-xl border-2 border-frame-mid/70" />
          <span
            className={`absolute inset-0 rounded-xl border-2 transition-colors duration-200 ${
              state.acting ? "border-warning ring-4 ring-warning/30 animate-pulse" : "border-accent"
            }`}
          />

          {/* Ripple animation when actively clicking */}
          {state.acting && (
            <span className="absolute -inset-3 rounded-2xl border border-warning/50 animate-ping pointer-events-none" />
          )}

          {/* Center target cursor dot */}
          <span
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full ${
              state.acting ? "bg-warning ring-2 ring-white scale-125" : "bg-accent/80 ring-1 ring-white/50"
            } transition-transform duration-150`}
          />

          {/* The label sits above the control, or below it when the control is
              at the top of the screen and there is no room. */}
          <span
            className={`absolute left-0 whitespace-nowrap max-w-[420px] truncate rounded-lg bg-surface/95 backdrop-blur-sm border border-edge-popover shadow-lg px-2.5 py-1 text-xs text-ink-bright font-medium flex items-center gap-1.5 ${
              box.top > 34 ? "-top-9" : "top-full mt-2"
            }`}
          >
            {state.acting ? (
              <MousePointer2 size={12} className="text-warning animate-bounce" />
            ) : null}
            {state.step && (
              <span className="text-ink-faint font-mono">
                {state.step.index}/{state.step.total}
              </span>
            )}
            <span>{target.label}</span>
          </span>
        </div>
      )}

      {/* Floating caption with interactive controls and dismiss */}
      {state.caption && (
        <div
          data-interactive="true"
          onMouseEnter={() => {
            if (dismissTimerRef.current !== null) {
              window.clearTimeout(dismissTimerRef.current);
              dismissTimerRef.current = null;
            }
            void getBridge()?.setOverlayInteractive?.(true);
          }}
          onMouseLeave={() => {
            void getBridge()?.setOverlayInteractive?.(false);
            if (!state.acting) {
              dismissTimerRef.current = window.setTimeout(handleDismiss, 5000);
            }
          }}
          className="absolute left-1/2 bottom-12 -translate-x-1/2 max-w-[640px] w-full mx-auto px-4 pointer-events-auto"
        >
          <div className="rounded-2xl bg-surface/95 backdrop-blur-md border border-edge-popover shadow-2xl p-4 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <p className="text-md text-ink-prose leading-snug font-medium text-left flex-1">
                {state.caption}
              </p>
              <button
                type="button"
                onClick={handleDismiss}
                className="rounded-full p-1 text-ink-faint hover:text-ink-high hover:bg-surface-hover transition-colors flex-shrink-0"
                title="Dismiss message"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-edge/60">
              <span className="text-2xs text-ink-faint">Teminali Screen Assistant</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleBackToStudio}
                  className="px-3 py-1.5 rounded-lg bg-accent text-frame-top text-xs font-semibold hover:opacity-90 transition-opacity flex items-center gap-1.5 shadow-sm"
                >
                  <ArrowLeft size={12} />
                  Back to Teminali Code
                </button>
                <button
                  type="button"
                  onClick={handleDismiss}
                  className="px-3 py-1.5 rounded-lg bg-surface-hover text-ink-muted hover:text-ink-high text-xs font-medium transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
