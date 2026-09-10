import React from "react";

import { resolveChromeStyle, type ResolvedChromeStyle } from "../../services/appearance";
import { useStudioStore } from "../../store/studioStore";

/**
 * Small shared pieces the redesign leans on repeatedly. They live together
 * because each is a handful of lines and splitting them into files of their own
 * would be filing, not structure.
 */

/* ── Keycap ───────────────────────────────────────────────────────────────── */

export const Kbd: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <span className={`font-mono text-2xs text-ink-faint ${className}`}>{children}</span>
);

/* ── Inline code ──────────────────────────────────────────────────────────── */

/** Inline code: #f0f0f0 on a flush #262626 chip, no ring. Measured. */
export const InlineCode: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <code
    className={`font-mono text-xs text-accent-code bg-accent-codeBg border border-accent-codeBorder rounded-lg px-1.5 py-0.5 ${className}`}
  >
    {children}
  </code>
);

/* ── Meta chip ────────────────────────────────────────────────────────────── */

/** Neutral pill for counts and labels ("4 lines", "Expand"). */
export const Chip: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { as?: "button" | "span"; active?: boolean }
> = ({ as = "span", active = false, className = "", children, ...props }) => {
  const shared = `inline-flex items-center gap-1.5 font-mono text-2xs rounded-lg px-2 py-1 transition-colors duration-ds ease-ds ${
    active ? "bg-surface-hover text-ink-high" : "bg-surface-chip text-ink-dim"
  } ${className}`;
  if (as === "span") return <span className={shared}>{children}</span>;
  return (
    <button type="button" className={`${shared} hover:bg-surface-hover hover:text-ink-high cursor-pointer`} {...props}>
      {children}
    </button>
  );
};

/* ── Icon button ──────────────────────────────────────────────────────────── */

export const IconButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; size?: number }
> = ({ active = false, size = 28, className = "", children, ...props }) => (
  <button
    type="button"
    style={{ width: size, height: size }}
    className={`flex items-center justify-center rounded-md flex-shrink-0 transition-colors duration-ds ease-ds ${
      active ? "bg-surface-tab text-accent" : "text-ink-muted hover:bg-surface-hover hover:text-ink-high"
    } disabled:opacity-35 disabled:hover:bg-transparent ${className}`}
    {...props}
  >
    {children}
  </button>
);

/* ── Traffic lights ───────────────────────────────────────────────────────── */

/**
 * macOS window controls. Rendered by the app rather than the OS because the
 * Electron shell runs with a hidden title bar — see electron/main.cjs.
 */
export const TrafficLights: React.FC<{
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  /** Native lights are already drawn; reserve the space without painting. */
  placeholder?: boolean;
  /** Zoom becomes Restore, and says so — the platform swaps the glyph, not the disc. */
  isMaximized?: boolean;
  /** macOS greys the lights when the window is not key. */
  dimmed?: boolean;
}> = ({ onClose, onMinimize, onMaximize, placeholder = false, isMaximized = false, dimmed = false }) => {
  if (placeholder) return <div className="w-[59px] flex-shrink-0" aria-hidden />;
  /* The glyph ink is a dark tint of each disc rather than one neutral: on
     macOS the × is a deep red, not a black. Values read off the reference. */
  const lights = [
    { color: "var(--tl-close)", ink: "#5c0d08", action: onClose, label: "Close",
      glyph: <path d="M4.2 4.2l3.6 3.6M7.8 4.2l-3.6 3.6" /> },
    { color: "var(--tl-min)", ink: "#603d02", action: onMinimize, label: "Minimise",
      glyph: <path d="M3.9 6h4.2" /> },
    {
      color: "var(--tl-max)", ink: "#0a4715", action: onMaximize,
      label: isMaximized ? "Restore" : "Zoom",
      glyph: isMaximized
        // Restore: two arrows folding inward.
        ? <path d="M7.6 4.4L5.2 6.8M7.6 4.4H5.9M7.6 4.4v1.7M4.4 7.6l2.4-2.4M4.4 7.6h1.7M4.4 7.6V5.9" />
        // Zoom: two arrows pushing outward.
        : <path d="M4.3 7.7l3.4-3.4M4.3 7.7V6M4.3 7.7H6M7.7 4.3V6M7.7 4.3H6" />,
    },
  ];
  return (
    /* 13px discs on a 23px pitch, first centre at x=17.5 — measured off the
       reference rather than assumed, because these are the first thing the eye
       lands on and a 2px error in the pitch is visible next to a real window. */
    <div
      className={`group/lights flex items-center gap-[10px] flex-shrink-0 transition-opacity duration-200 ${
        dimmed ? "opacity-45" : "opacity-100"
      }`}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {lights.map((light) => (
        <button
          key={light.label}
          type="button"
          aria-label={light.label}
          title={light.label}
          onClick={light.action}
          className="w-[13px] h-[13px] rounded-full grid place-items-center transition-opacity duration-ds ease-ds hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
          style={{ background: light.color }}
        >
          {/* Glyphs stay hidden until the cluster is hovered, as on macOS: at
              rest these are three coloured dots, and the mark appearing is the
              confirmation that the pointer is on target. */}
          <svg
            viewBox="0 0 12 12"
            aria-hidden="true"
            className="w-full h-full opacity-0 transition-opacity duration-ds ease-ds group-hover/lights:opacity-100"
            stroke={light.ink}
            strokeWidth={1.4}
            strokeLinecap="round"
            fill="none"
          >
            {light.glyph}
          </svg>
        </button>
      ))}
    </div>
  );
};

/* ── macOS close button ───────────────────────────────────────────────────── */

/**
 * The macOS close control: a red disc that only reveals its glyph on hover.
 *
 * One implementation for the window and for every dialog, because a close
 * button that looks different depending on what it closes is a small, constant
 * source of hesitation. The glyph appearing on hover is the platform behaviour
 * — at rest it is a coloured dot, and the × is the confirmation that the
 * pointer is on target.
 */
export const MacCloseButton: React.FC<{
  onClose: () => void;
  /** Diameter in pixels. 13 matches the window chrome. */
  size?: number;
  label?: string;
  className?: string;
}> = ({ onClose, size = 13, label = "Close", className = "" }) => (
  <button
    type="button"
    onClick={onClose}
    aria-label={label}
    title={label}
    style={{ width: size, height: size, background: "var(--tl-close)", WebkitAppRegion: "no-drag" } as React.CSSProperties}
    className={`group relative rounded-full flex-shrink-0 flex items-center justify-center transition-opacity duration-ds ease-ds hover:opacity-90 focus-visible:opacity-90 ${className}`}
  >
    <svg
      viewBox="0 0 12 12"
      aria-hidden
      className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-fast ease-ds"
      style={{ width: size * 0.62, height: size * 0.62 }}
    >
      <path
        d="M3.2 3.2 L8.8 8.8 M8.8 3.2 L3.2 8.8"
        stroke="rgba(0,0,0,.55)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  </button>
);

/* ── Dialog close ─────────────────────────────────────────────────────────── */

/**
 * The resolved window-control dialect, for a component that must draw one.
 *
 * `services/appearance.ts` deliberately knows nothing about the store so the
 * recorder-bar window can call `resolveChromeStyle` too. This is the other
 * half: the subscription, for the React tree that does have a store, so a
 * change in Settings > Appearance repaints every dialog at once rather than at
 * the next reload.
 */
export const useChromeStyle = (): ResolvedChromeStyle => {
  const chromeStyle = useStudioStore((state) => state.appearance.chromeStyle);
  return resolveChromeStyle(chromeStyle);
};

/**
 * A dialog's close control, in whichever dialect the operator chose.
 *
 * It used to be `MacCloseButton` unconditionally, which meant an operator who
 * had set the window chrome to Windows got three flat caption buttons on the
 * title bar and a macOS traffic light on every dialog. Two dialects in one
 * window is not a style, it is a bug you look at all day.
 *
 * What the setting transfers is the DIALECT, not the placement. A dialog has
 * no minimise and no maximise, is not draggable chrome, and its control sits
 * where the dialog's own layout puts it — top right, in every dialect. The
 * title-bar side rule (`CHROME_SIDE`) governs the window, which is the thing
 * that setting's description is about.
 *
 * `flush` is for a header that lets the control take its full height: on
 * Windows the caption button is a rectangle hard against the corner with no
 * gap and no rounding, and 46px is the real width. Everywhere else — an
 * absolutely-positioned control over a custom dialog body — the compact box
 * is right, because there is no corner to be flush with.
 */
export const DialogCloseButton: React.FC<{
  onClose: () => void;
  /** Diameter of the macOS disc in pixels. 13 matches the window chrome. */
  size?: number;
  label?: string;
  className?: string;
  /** Let the control take the header's full height, hard against the corner. */
  flush?: boolean;
  /** Force a dialect. Omitted, it follows Settings > Appearance. */
  style?: ResolvedChromeStyle;
}> = ({ onClose, size = 13, label = "Close", className = "", flush = false, style }) => {
  const resolved = useChromeStyle();
  const dialect = style ?? resolved;

  if (dialect === "macos") {
    const disc = <MacCloseButton onClose={onClose} size={size} label={label} className={className} />;
    return flush ? <span className="flex items-center px-4">{disc}</span> : disc;
  }

  if (dialect === "windows") {
    return (
      <button
        type="button"
        onClick={onClose}
        aria-label={label}
        title={label}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        className={`group flex flex-shrink-0 items-center justify-center text-ink-muted transition-colors duration-ds ease-ds hover:bg-[var(--chrome-win-close)] hover:text-white ${
          flush ? "h-full w-[46px]" : "h-7 w-9 rounded-md"
        } ${className}`}
      >
        {/* The ✕ is the one caption glyph that must NOT be crisp-edged: an
            unantialiased diagonal is a staircase. Same call as WindowChrome. */}
        <svg viewBox="0 0 10 10" width={10} height={10} aria-hidden="true" fill="none"
             stroke="currentColor" strokeWidth={1} shapeRendering="geometricPrecision">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    );
  }

  /* GNOME shows its glyph at rest — the circle is only a target, so the
     symbol carries the meaning and the fill never has to. */
  const button = (
    <button
      type="button"
      onClick={onClose}
      aria-label={label}
      title={label}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      className={`grid h-6 w-6 flex-shrink-0 place-items-center rounded-full text-ink-high transition-colors duration-ds ease-ds bg-[var(--chrome-gnome-btn)] hover:bg-[var(--chrome-gnome-btn-hover)] ${className}`}
    >
      <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden="true" fill="none"
           stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
      </svg>
    </button>
  );
  return flush ? <span className="flex items-center px-3">{button}</span> : button;
};

/* ── Empty state ──────────────────────────────────────────────────────────── */

export const EmptyState: React.FC<{
  icon?: React.ReactNode;
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
}> = ({ icon, title, detail, action }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-3 text-ink-ghost px-6 text-center">
    {icon && <div className="text-ink-disabled">{icon}</div>}
    <div className="text-sm">{title}</div>
    {detail && <div className="text-xs text-ink-disabled max-w-xs">{detail}</div>}
    {action && (
      <button
        type="button"
        onClick={action.onClick}
        className="lit lit-inner mt-1 text-xs text-ink-muted -strong rounded-full px-4 py-1.5 hover:bg-surface-raised hover:text-ink-high transition-colors duration-ds ease-ds"
      >
        {action.label}
      </button>
    )}
  </div>
);

/* ── Status dot ───────────────────────────────────────────────────────────── */

export const StatusDot: React.FC<{
  tone?: "success" | "accent" | "warning" | "danger" | "reason" | "muted";
  pulse?: boolean;
}> = ({ tone = "success", pulse = false }) => {
  const colors = {
    success: "bg-success",
    accent: "bg-accent",
    // Guardian grades severity across three levels, so the dot has to as well;
    // collapsing warning into danger would make every advisory look critical.
    warning: "bg-warning",
    danger: "bg-danger",
    reason: "bg-reason",
    muted: "bg-ink-disabled",
  } as const;
  return <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${colors[tone]} ${pulse ? "animate-pulseDot" : ""}`} />;
};

/* ── Section label ────────────────────────────────────────────────────────── */

/**
 * "Repositories", "Open Tabs", "On Home". Sentence case at body size, one step
 * down the text ramp — Cursor never sets a section label in uppercase mono, and
 * never rules it off from what follows.
 *
 * Its 14px indent is deliberately *less* than a row's 38px text indent: the
 * label hangs to the left of the column its rows form, which is what makes the
 * rows read as belonging to it without needing a box around them.
 */
export const SectionLabel: React.FC<{ children: React.ReactNode; trailing?: React.ReactNode }> = ({
  children,
  trailing,
}) => (
  <div className="flex items-center justify-between h-7 pl-3.5 pr-2 text-sm text-ink-faint">
    <span className="truncate">{children}</span>
    {trailing && <div className="flex items-center gap-0.5 flex-shrink-0">{trailing}</div>}
  </div>
);

/* ── Sidebar row ──────────────────────────────────────────────────────────── */

/**
 * One row in the sidebar — a nav item, a repository, a conversation.
 *
 * Every clickable line in Cursor's sidebar is this same object, and the
 * measurements are not approximate: a 30px row inset 8px from each edge, an 8px
 * corner, a 16px glyph whose box starts at x=14, and the label at x=38. Rows of
 * different kinds differ only in whether they carry an icon and what sits on
 * the right — a nested conversation drops the icon and keeps the 38px indent,
 * which is why `indent` exists rather than a second component.
 *
 * The three states are the whole visual vocabulary: rest is muted text on
 * nothing, hover adds #242424, selected is #252525 with the label at full
 * strength. There is no marker, no left bar, no accent — on a list this dense,
 * Cursor lets the fill alone say "you are here".
 */
export const SidebarRow: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: React.ReactNode;
    active?: boolean;
    /** Aligns a row with no icon under rows that have one. */
    indent?: boolean;
    trailing?: React.ReactNode;
  }
> = ({ icon, active = false, indent = false, trailing, children, className = "", ...props }) => (
  <button
    type="button"
    className={`mx-2 h-row rounded-md flex items-center gap-2 pr-2 text-sm text-left transition-colors duration-ds ease-ds ${
      indent ? "pl-[30px]" : "pl-1.5"
    } ${
      active ? "bg-surface-active text-ink-strong" : "text-ink-muted hover:bg-surface-hover hover:text-ink-body"
    } ${className}`}
    {...props}
  >
    {icon && <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">{icon}</span>}
    <span className="flex-1 min-w-0 truncate">{children}</span>
    {trailing && <span className="flex-shrink-0 text-2xs text-ink-soft">{trailing}</span>}
  </button>
);
