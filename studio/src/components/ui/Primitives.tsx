import React from "react";

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
}> = ({ onClose, onMinimize, onMaximize, placeholder = false }) => {
  if (placeholder) return <div className="w-[59px] flex-shrink-0" aria-hidden />;
  const lights = [
    { color: "var(--tl-close)", action: onClose, label: "Close" },
    { color: "var(--tl-min)", action: onMinimize, label: "Minimise" },
    { color: "var(--tl-max)", action: onMaximize, label: "Zoom" },
  ];
  return (
    /* 13px discs on a 23px pitch, first centre at x=17.5 — measured off the
       reference rather than assumed, because these are the first thing the eye
       lands on and a 2px error in the pitch is visible next to a real window. */
    <div className="flex items-center gap-[10px] flex-shrink-0" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      {lights.map((light) => (
        <button
          key={light.label}
          type="button"
          aria-label={light.label}
          onClick={light.action}
          className="w-[13px] h-[13px] rounded-full transition-opacity duration-ds ease-ds hover:opacity-80"
          style={{ background: light.color }}
        />
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
