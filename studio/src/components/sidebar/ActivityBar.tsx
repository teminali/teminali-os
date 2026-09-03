import React from "react";
import {
  Boxes,
  Files,
  MessagesSquare,
  Search,
  SlidersHorizontal,
  SquarePen,
  type LucideIcon,
} from "lucide-react";

/**
 * The activity bar: the 48px column of glyphs that switches the sidebar.
 *
 * This file has now been written twice, and the second version is the first
 * one again — so the reasoning is worth keeping. It began as a rail, was folded
 * into labelled nav rows when the shell was cut to match Cursor's agent window
 * (one seam, no rail), and is a rail again by the operator's call: *"make the
 * left sidebar buttons only so it gets thinner"*, answered as **"just like the
 * VS Code left sidebar"**.
 *
 * What that buys is width. Labelled rows priced the sidebar at 260px because
 * "Explorer" and "Customize" had to fit inside it; glyphs price the switch at
 * 48 and let the panel beside them open at 212 — the same 260px of shell as
 * before, with the labels' width handed back to whatever the panel is showing.
 * The cost is the second vertical seam the previous version was written to
 * remove, and it is a deliberate trade: five destinations cannot ride a
 * horizontal strip without either wrapping or eating the width the change was
 * made to recover.
 *
 * The names did not disappear, they moved into `title` and `aria-label`. A
 * label one hover away costs no pixels; a label in the layout costs 212 of
 * them on every view that never needed it.
 */

/** The rail's fixed width. The title bar reads this to line its edge up. */
export const ACTIVITY_BAR_WIDTH = 48;

export type SidebarTabId = "chats" | "files" | "search" | "skills";

export interface SidebarTabDef {
  id: SidebarTabId;
  label: string;
  shortcut?: string;
  icon: LucideIcon;
}

/**
 * Every view the sidebar can host, in rail order.
 *
 * There is one list now, not the `PRIMARY_NAV` / `WORKSPACE_NAV` pair the rows
 * were split into. That split existed to keep the top of the sidebar reading
 * exactly like Cursor's four labelled rows while this studio's own views
 * arrived underneath a section label. A rail of glyphs has no such reading to
 * protect — the reference for the shape is VS Code's activity bar, where every
 * destination is one tile in one column — so the two groups collapsed into
 * this.
 *
 * Media used to be a fifth tile here, on the reasoning that the approval gate
 * needed an always-mounted host. It did not: the gate's subscriber is
 * `MediaConsentModal`, which `App.tsx` mounts at the top level for exactly
 * that reason. The media pool now lives only in the video editor's own rail,
 * which is where an operator reaches for a clip. See `src/video/P3-import-gate.md`.
 */
export const SIDEBAR_TABS: readonly SidebarTabDef[] = [
  { id: "chats", label: "Chats", shortcut: "⌘L", icon: MessagesSquare },
  { id: "files", label: "Explorer", shortcut: "⇧⌘E", icon: Files },
  { id: "search", label: "Search", shortcut: "⇧⌘F", icon: Search },
  { id: "skills", label: "Skills", icon: Boxes },
];

/* ── One tile ─────────────────────────────────────────────────────────────── */

const RailTile: React.FC<{
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick: () => void;
}> = ({ icon: Icon, label, shortcut, active = false, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    title={shortcut ? `${label} (${shortcut})` : label}
    aria-label={label}
    aria-current={active ? "page" : undefined}
    className={`relative h-11 flex items-center justify-center transition-colors duration-ds ease-ds ${
      active ? "text-ink-strong" : "text-ink-muted hover:text-ink-high"
    }`}
  >
    {/* Selection is a bar at the window edge, not a fill. That is VS Code's own
        signal, and at 48px it is the one that survives: a rounded fill behind an
        18px glyph leaves 4px of breathing room and reads as a button that is
        stuck down rather than as a place you are. */}
    <span
      aria-hidden
      className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-r-full bg-ink-strong transition-opacity duration-ds ease-ds ${
        active ? "opacity-100" : "opacity-0"
      }`}
    />
    <Icon size={18} strokeWidth={1.7} />
  </button>
);

/* ── The rail ─────────────────────────────────────────────────────────────── */

export interface ActivityBarProps {
  tab: SidebarTabId;
  onSelectTab: (tab: SidebarTabId) => void;
  /** The panel beside the rail. The rail itself is never hidden. */
  collapsed: boolean;
  onSetCollapsed: (collapsed: boolean) => void;
  onNewChat: () => void;
  onOpenCustomize: () => void;
  /** Which non-tab view the shell is showing, for the Customize tile. */
  activeView: string;
}

export const ActivityBar: React.FC<ActivityBarProps> = ({
  tab,
  onSelectTab,
  collapsed,
  onSetCollapsed,
  onNewChat,
  onOpenCustomize,
  activeView,
}) => {
  /**
   * VS Code's rule, and the Cut's: the tile you are already on closes the
   * panel, any other tile opens it. Without the first half a rail is a switch
   * with no off — the panel could only be dismissed from the title bar, which
   * is not where you just clicked.
   */
  const select = (id: SidebarTabId) => {
    if (collapsed) {
      onSelectTab(id);
      onSetCollapsed(false);
      return;
    }
    if (id === tab) {
      onSetCollapsed(true);
      return;
    }
    onSelectTab(id);
  };

  return (
    <nav
      className="flex-shrink-0 flex flex-col border-r border-edge-chrome bg-rail-mid py-1.5"
      style={{ width: ACTIVITY_BAR_WIDTH }}
      aria-label="Activity bar"
    >
      {/* An action, never a destination, so it never lights up — the same rule
          the labelled rows held it to. The hairline is what says so. */}
      <RailTile icon={SquarePen} label="New Chat" onClick={onNewChat} />
      <div className="mx-3.5 my-1.5 h-px bg-edge" aria-hidden />

      {SIDEBAR_TABS.map((item) => (
        <RailTile
          key={item.id}
          icon={item.icon}
          label={item.label}
          shortcut={item.shortcut}
          active={tab === item.id && !collapsed}
          onClick={() => select(item.id)}
        />
      ))}

      <div className="flex-1" />

      <RailTile
        icon={SlidersHorizontal}
        label="Customize"
        active={activeView === "customize"}
        onClick={onOpenCustomize}
      />
    </nav>
  );
};
