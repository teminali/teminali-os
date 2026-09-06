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
  onOverlayCursor?: (fn: (point: { x: number; y: number }) => void) => () => void;
}

/**
 * How big the drawn pointer is, in points.
 *
 * Chosen against the system arrow rather than against the screen: at 64 it is
 * roughly three times the size of the real cursor, which is the point at which
 * the eye can follow it crossing a 27-inch display without it covering the
 * control it is about to click.
 */
const CURSOR_SIZE = 64;

export const AssistantOverlaySurface: React.FC = () => {
  const [state, setState] = useState<OverlayState>(EMPTY);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
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
    const stopState = bridge?.onOverlay?.((next) => {
      setState({ ...EMPTY, ...next });
    });
    const stopCursor = bridge?.onOverlayCursor?.((point) => {
      setCursor(point);
    });
    return () => {
      stopState?.();
      stopCursor?.();
    };
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

  // Window-relative, because the window covers one display and the pointer is
  // reported in global screen points like every other coordinate here.
  const pointer = cursor
    ? { left: cursor.x - state.origin.x, top: cursor.y - state.origin.y }
    : null;

  return (
    <div className="fixed inset-0 pointer-events-none select-none font-sans">
      {/* The assistant's own pointer, drawn over the operating system's.
          Same doctrine as the ring: a dark stroke outside a light fill, so it
          reads over a white document and over a black terminal without a glow,
          a blur or a gradient — none of which this design system has. The tip
          of the arrow sits exactly on the real hot spot, which is why the SVG
          is anchored at its top-left corner and not centred. */}
      {pointer && (
        <div
          className="absolute pointer-events-none transition-transform duration-100"
          style={{
            left: pointer.left,
            top: pointer.top,
            width: CURSOR_SIZE,
            height: CURSOR_SIZE,
            transform: state.acting ? "scale(1.15)" : "scale(1)",
            transformOrigin: "top left",
          }}
        >
          {/* A halo behind the arrow, so the eye catches the movement itself
              rather than having to find the arrow first. */}
          <span
            className={`absolute rounded-full ${
              state.acting ? "bg-warning/25 animate-ping" : "bg-accent/15"
            }`}
            style={{
              left: -CURSOR_SIZE * 0.35,
              top: -CURSOR_SIZE * 0.35,
              width: CURSOR_SIZE * 0.9,
              height: CURSOR_SIZE * 0.9,
            }}
          />
          <svg
            width={CURSOR_SIZE}
            height={CURSOR_SIZE}
            viewBox="0 0 24 24"
            className="absolute inset-0"
            aria-hidden="true"
          >
            {/* Drawn twice, dark first: the outer stroke is what keeps the
                arrow visible on a white page, where a white-edged one would
                vanish. Painting it underneath rather than over means the fill
                stays the colour it is supposed to be. */}
            <path
              d="M4 2 L4 19 L8.6 14.8 L11.4 21.4 L14.6 20 L11.9 13.6 L18 13.3 Z"
              fill="none"
              stroke="rgba(0,0,0,0.55)"
              strokeWidth={3.2}
              strokeLinejoin="round"
            />
            <path
              d="M4 2 L4 19 L8.6 14.8 L11.4 21.4 L14.6 20 L11.9 13.6 L18 13.3 Z"
              className={state.acting ? "fill-warning" : "fill-accent"}
              stroke="white"
              strokeWidth={1.1}
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}

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
                  Back to Teminali OS
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
