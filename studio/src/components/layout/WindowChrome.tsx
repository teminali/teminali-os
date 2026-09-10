import React, { useEffect, useState } from "react";

import type { ResolvedChromeStyle } from "../../services/appearance";
import { TrafficLights } from "../ui/Primitives";

/**
 * The window's own controls, in three platform dialects.
 *
 * The shell runs `frame: false` on every platform (`electron/main.cjs`), so
 * none of this is native integration — there is no `titleBarStyle`, no
 * `titleBarOverlay` and no per-platform `BrowserWindow` branch. Which style
 * renders comes from `resolveChromeStyle`, and an operator can override it
 * to any of the three; that override is also the only way all three are
 * testable on one machine.
 *
 * Measurements come from the reference windows, not from taste — see
 * `docs/SETTINGS_AND_CHROME_PLAN.md` §4.3. Colours come from `tokens.css`;
 * there is no raw hex here except the two Windows glyph inks, which are
 * `currentColor` flips rather than palette entries.
 */

/**
 * Everything a control cluster needs from the window, in one place so the
 * three dialects cannot drift on what "maximised" means.
 *
 * Focus is tracked because macOS dims its lights when the window is not key,
 * and a cluster that stays bright is chrome lying about which window has the
 * keyboard. `isMaximized` comes from main rather than from our own click, so
 * a window zoomed by a double-click on the bar, or by the OS, still shows the
 * restore glyph.
 */
export const useWindowState = () => {
  const bridge = typeof window !== "undefined" ? window.teminali : undefined;
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFocused, setIsFocused] = useState(true);

  useEffect(() => {
    if (!bridge) return;
    void bridge.window.isMaximized().then(setIsMaximized).catch(() => {});
    return bridge.window.onMaximizeChange(setIsMaximized);
  }, [bridge]);

  useEffect(() => {
    const focus = () => setIsFocused(true);
    const blur = () => setIsFocused(false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, []);

  return {
    isMaximized,
    isFocused,
    minimize: () => void bridge?.window.minimize(),
    close: () => void bridge?.window.close(),
    toggleMaximize: () => void bridge?.window.toggleMaximize().then(setIsMaximized),
  };
};

/* ── Windows 11 ───────────────────────────────────────────────────────────── */

/**
 * Three flat caption buttons, flush to the corner.
 *
 * 46px wide, and the full height of the caption area rather than the 32px of a
 * default Windows title bar: on Windows the buttons take the caption height,
 * so a 32px button in our 40px bar would leave an 8px strip at the very corner
 * that hover does not fill — the one pixel-level tell that these are drawn by
 * an app. No gap, no rounding, no inset; the corner is the target.
 */
const WindowsButton: React.FC<{
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}> = ({ label, onClick, destructive = false, children }) => (
  <button
    type="button"
    onClick={onClick}
    onDoubleClick={(event) => event.stopPropagation()}
    aria-label={label}
    title={label}
    className={`group/win flex h-full w-[46px] flex-shrink-0 items-center justify-center transition-colors duration-ds ease-ds ${
      destructive
        ? "text-ink-high hover:bg-[var(--chrome-win-close)] hover:text-white"
        : "text-ink-high hover:bg-[var(--chrome-win-hover)]"
    }`}
  >
    {children}
  </button>
);

/**
 * 10px hairline glyphs on a half-pixel grid, which is what keeps them crisp.
 *
 * `crispEdges` is what stops a 1px axis-aligned stroke landing across two
 * device pixels as a 2px blur — but it also turns antialiasing off, and an
 * unantialiased diagonal is a staircase. So it is opt-out: on for the bar and
 * the squares, off for the ✕.
 */
const winGlyph = (path: React.ReactNode, crisp = true) => (
  <svg viewBox="0 0 10 10" width={10} height={10} aria-hidden="true" fill="none"
       stroke="currentColor" strokeWidth={1} shapeRendering={crisp ? "crispEdges" : "geometricPrecision"}>
    {path}
  </svg>
);

const WindowsCluster: React.FC = () => {
  const { isMaximized, minimize, close, toggleMaximize } = useWindowState();
  return (
    <div
      className="flex h-full items-stretch flex-shrink-0"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <WindowsButton label="Minimize" onClick={minimize}>
        {winGlyph(<path d="M0.5 5.5h9" />)}
      </WindowsButton>
      <WindowsButton label={isMaximized ? "Restore Down" : "Maximize"} onClick={toggleMaximize}>
        {isMaximized
          // Restore is the two-square overlap, not a pair of arrows: the front
          // square, then the two exposed edges of the one behind it.
          ? winGlyph(
              <>
                <path d="M0.5 3.5h6v6h-6z" />
                <path d="M2.5 3.5v-3h6v6h-3" />
              </>,
            )
          : winGlyph(<path d="M0.5 0.5h9v9h-9z" />)}
      </WindowsButton>
      <WindowsButton label="Close" onClick={close} destructive>
        {winGlyph(<path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />, false)}
      </WindowsButton>
    </div>
  );
};

/* ── Linux (GNOME / Adwaita) ──────────────────────────────────────────────── */

/**
 * Three 24px circles on a 6px gap. Unlike macOS, GNOME shows the glyph at
 * rest — the circle is only a target, so the symbol carries the meaning and
 * the fill never has to.
 *
 * Close is not red at rest here: Adwaita reserves colour for destructive
 * *actions*, and the window's own close button is not one of them.
 *
 * All three are always shown. Some GNOME setups hide minimise by default,
 * but that is a distro decision about a compositor we are not running, and a
 * frameless window with no minimise is a window the operator cannot get out
 * of the way.
 */
const GnomeButton: React.FC<{
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    onDoubleClick={(event) => event.stopPropagation()}
    aria-label={label}
    title={label}
    className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full text-ink-high transition-colors duration-ds ease-ds bg-[var(--chrome-gnome-btn)] hover:bg-[var(--chrome-gnome-btn-hover)]"
  >
    {children}
  </button>
);

const gnomeGlyph = (path: React.ReactNode) => (
  <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden="true" fill="none"
       stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    {path}
  </svg>
);

const GnomeCluster: React.FC = () => {
  const { isMaximized, minimize, close, toggleMaximize } = useWindowState();
  return (
    <div
      className="flex h-full items-center gap-[6px] px-[6px] flex-shrink-0"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <GnomeButton label="Minimize" onClick={minimize}>
        {gnomeGlyph(<path d="M4 11h8" />)}
      </GnomeButton>
      <GnomeButton label={isMaximized ? "Unmaximize" : "Maximize"} onClick={toggleMaximize}>
        {isMaximized
          ? gnomeGlyph(
              <>
                <rect x="3" y="6" width="7" height="7" rx="1" />
                <path d="M6 6V4a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1h-2" />
              </>,
            )
          : gnomeGlyph(<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />)}
      </GnomeButton>
      <GnomeButton label="Close" onClick={close}>
        {gnomeGlyph(<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />)}
      </GnomeButton>
    </div>
  );
};

/* ── macOS ────────────────────────────────────────────────────────────────── */

/**
 * The traffic lights themselves live in `ui/Primitives` beside `MacCloseButton`
 * — one disc implementation for the window and for every dialog. What this
 * adds is the window state they cannot see from there.
 */
const MacCluster: React.FC = () => {
  const { isMaximized, isFocused, minimize, close, toggleMaximize } = useWindowState();
  return (
    <div onDoubleClick={(event) => event.stopPropagation()}>
      <TrafficLights
        onClose={close}
        onMinimize={minimize}
        onMaximize={toggleMaximize}
        isMaximized={isMaximized}
        dimmed={!isFocused}
      />
    </div>
  );
};

/* ── The cluster ──────────────────────────────────────────────────────────── */

/**
 * Renders the resolved dialect. Renders nothing in a browser tab, where the
 * browser supplies real chrome and a second set of controls would close the
 * wrong thing.
 */
export const WindowChrome: React.FC<{ style: ResolvedChromeStyle }> = ({ style }) => {
  if (typeof window === "undefined" || !window.teminali) return null;
  if (style === "windows") return <WindowsCluster />;
  if (style === "linux") return <GnomeCluster />;
  return <MacCluster />;
};
