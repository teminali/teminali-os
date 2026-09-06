import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  Maximize2,
  Minimize2,
  MonitorSmartphone,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Plus,
  X,
} from "lucide-react";
import { isDesktopShell } from "./WindowControls";
import { TrafficLights, IconButton, Menu, type MenuItem } from "../ui";
import { PANEL_DEFAULTS, usePanelStore, type PanelKind } from "../../store/panelStore";
import { PanelGlyph } from "../workspace/PanelGlyph";
import { useStudioStore } from "../../store/studioStore";
import { PlatformService } from "../../services/platformService";
import { ACTIVITY_BAR_WIDTH } from "../sidebar/ActivityBar";
import { useProjectStore } from "../../video/store/projectStore";

/**
 * The window chrome, in three regions that line up with the three panes below:
 * sidebar controls on the left, the conversation title in the middle, and the
 * panel tab strip on the right. Keeping the strip up here — rather than inside
 * the panel — is what lets the panel itself be nothing but content.
 */

export interface StudioTitleBarProps {
  title: string;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenIde?: () => void;
}

export const StudioTitleBar: React.FC<StudioTitleBarProps> = ({
  title,
  sidebarWidth,
  sidebarCollapsed,
  onToggleSidebar,
  onOpenIde,
}) => {
  const {
    panels,
    activePanelId,
    isOpen,
    isExpanded,
    width,
    isAddMenuOpen,
    activate,
    close,
    focusOrOpen,
    open,
    toggleOpen,
    toggleExpanded,
    setAddMenuOpen,
  } = usePanelStore();

  const { sessionHistory, sessionHistoryIndex, goBackSession, goForwardSession } = useStudioStore();
  const [isAdmin, setIsAdmin] = useState(false);
  /*
    The overflow button's own copy of the panel menu.

    Its own state rather than the store's `isAddMenuOpen`, because that flag is
    the tab strip's `+` and one flag driving two anchored popovers would draw
    both at once. What they share is `addItems` — the same list, from the same
    place, so the two entry points cannot come to offer different panels.
  */
  const [overflowOpen, setOverflowOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void PlatformService.me(controller.signal).then((identity) => {
      if (!controller.signal.aborted) setIsAdmin(Boolean(identity?.isAdmin));
    });
    return () => controller.abort();
  }, []);
  const canGoBack = sessionHistoryIndex > 0;
  const canGoForward = sessionHistoryIndex >= 0 && sessionHistoryIndex < sessionHistory.length - 1;

  const desktop = isDesktopShell();
  // The left region spans both halves of the dock — the activity bar and the
  // panel — so this border lands on the same pixel as the panel's own. When the
  // panel is collapsed the region shrinks to just enough room for the traffic
  // lights and the toggle, which then sit over the canvas with the rail's
  // glyphs beneath them.
  const railWidth = sidebarCollapsed ? "auto" : `${ACTIVITY_BAR_WIDTH + sidebarWidth}px`;

  // Administrator-only panels are omitted rather than shown disabled: an
  // operator who is not an admin has no use for a row that always refuses. The
  // routes behind them re-check regardless — this is presentation, not the gate.
  const adminOnly = new Set<PanelKind>(["release", "arena"]);
  const kinds = (["file", "terminal", "browser", "canvas", "video", "side", "claude", "codex", "usage", "arena", "release", "guardian"] as PanelKind[])
    .filter((kind) => !adminOnly.has(kind) || isAdmin);

  const addItems: MenuItem[] = kinds.map((kind) => ({
    id: kind,
    label: PANEL_DEFAULTS[kind].label,
    shortcut: PANEL_DEFAULTS[kind].shortcut,
    icon: <PanelGlyph kind={kind} size={14} />,
    // A terminal, a side chat and a browser are cheap to have several of — a
    // browser tab is its own page with its own history, like any browser's. A
    // canvas or an agent is not: an agent tab holds a live CLI session, and a
    // second one starts a conversation with an agent that remembers nothing.
    onSelect: () =>
      kind === "terminal" || kind === "side" || kind === "browser" ? open({ kind }) : focusOrOpen({ kind }),
  }));

  return (
    <header
      className="flex items-stretch flex-shrink-0 select-none"
      style={{ height: "var(--titlebar-h)", WebkitAppRegion: "drag" } as React.CSSProperties}
      onDoubleClick={() => void window.teminali?.window.toggleMaximize()}
    >
      {/* ── Sidebar region ─────────────────────────────────────────────── */}
      <div
        // No border while the panel is collapsed: the region is then wider than
        // the 48px rail beneath it, and a rule at ~90px would cross the canvas
        // a finger's width from the rail's own edge. Nothing to divide, no line.
        className={`flex items-center gap-3 pl-[11px] pr-2 flex-shrink-0 ${
          sidebarCollapsed ? "" : "border-r border-edge-chrome"
        }`}
        style={{ width: railWidth, WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {desktop ? (
          <TrafficLights
            onClose={() => void window.teminali?.window.close()}
            onMinimize={() => void window.teminali?.window.minimize()}
            onMaximize={() => void window.teminali?.window.toggleMaximize()}
          />
        ) : null}

        <IconButton onClick={onToggleSidebar} active={!sidebarCollapsed} title="Toggle sidebar (⌘B)">
          <PanelLeft size={15} />
        </IconButton>

        <div className="flex-1" />

        {/* Back and forward through the chats you have visited, where Cursor
            puts them. They were left out originally because there was no
            history behind them; there is now, and a disabled arrow is honest
            about having nowhere to go rather than being absent. */}
        <IconButton onClick={goBackSession} disabled={!canGoBack} title="Back" size={24}>
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton onClick={goForwardSession} disabled={!canGoForward} title="Forward" size={24}>
          <ArrowRight size={15} />
        </IconButton>
      </div>

      {/* ── Conversation region ────────────────────────────────────────── */}
      {!isExpanded && (
      <div className="flex-1 min-w-0 flex items-center gap-3 px-4">
        <span className="text-sm text-ink-faint truncate">{title}</span>
        {title && <MonitorSmartphone size={13} className="text-ink-placeholder flex-shrink-0" />}

        <div className="flex-1" />

        <div
          className="flex items-center gap-3 font-mono text-xs text-ink-muted"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {/*
            The editor sits beside the IDE because the two are the same kind of
            verb — "take this conversation somewhere it can be worked on" — and
            it is built the same way: the word, then the glyph that says where
            it goes. IDE's arrow means another application; the clapperboard
            means a panel here, and it is the only thing distinguishing two
            neighbours that would otherwise both just say "editor".

            The glyph was on the left and the label read "Video Editor", which
            put a three-word label and a leading icon next to a three-letter
            one — two shapes in a strip that wants one. `focusOrOpen` means a
            second press focuses the editor already open rather than stacking
            a second one.
          */}
          <button
            type="button"
            onClick={() => focusOrOpen({ kind: "video" })}
            title={`${PANEL_DEFAULTS.video.label} (${PANEL_DEFAULTS.video.shortcut})`}
            aria-label={PANEL_DEFAULTS.video.label}
            className="flex items-center gap-1.5 hover:text-ink-high transition-colors duration-ds ease-ds"
          >
            {PANEL_DEFAULTS.video.label}
            <PanelGlyph kind="video" size={11} />
          </button>
          {/* The two are neighbours, not a pair: one opens a panel here, the
              other leaves for another application. A hairline says so without
              spending a label on it. */}
          <span className="w-px h-3 bg-edge-strong flex-shrink-0" aria-hidden="true" />
          <button
            type="button"
            onClick={onOpenIde}
            className="flex items-center gap-1.5 hover:text-ink-high transition-colors duration-ds ease-ds"
          >
            IDE
            <ExternalLink size={11} />
          </button>
          {/*
            The same menu as the tab strip's `+`.

            It used to open the command palette, which is a search dialog — and
            the sidebar already has search as a whole view, so this was a second
            door to it wearing an unrelated glyph. ⌘K and ⌘P still open the
            palette. What this button is for is the one thing the strip's `+`
            cannot do while the panel region is hidden: open a panel.
          */}
          <div className="relative flex-shrink-0">
            <IconButton
              onClick={() => setOverflowOpen((previous) => !previous)}
              active={overflowOpen}
              title="Open a panel"
              size={24}
            >
              <MoreHorizontal size={15} />
            </IconButton>
            <Menu
              open={overflowOpen}
              onClose={() => setOverflowOpen(false)}
              items={addItems}
              anchor="top-8 right-0"
              width={264}
            />
          </div>
          <IconButton onClick={toggleOpen} active={isOpen} title="Toggle panels" size={24}>
            <PanelRight size={15} />
          </IconButton>
        </div>
      </div>
      )}

      {/* ── Panel tab strip ────────────────────────────────────────────── */}
      {isOpen && (
        <div
          className={`flex items-center gap-1.5 px-3 min-w-0 relative ${
            isExpanded ? "flex-1" : "flex-shrink-0"
          } ${(!isExpanded || sidebarCollapsed) ? "border-l border-edge-chrome" : ""}`}
          style={{
            width: isExpanded ? undefined : width,
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties}
        >
          <div className="flex items-center gap-1 min-w-0 overflow-x-auto no-scrollbar">
            {panels.map((panel) => {
              const active = panel.id === activePanelId;
              return (
                <div
                  key={panel.id}
                  role="tab"
                  aria-selected={active}
                  tabIndex={0}
                  onClick={() => activate(panel.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") activate(panel.id);
                  }}
                  title={panel.private ? `${panel.label} — private` : panel.label}
                  aria-label={panel.private ? `${panel.label}, private tab` : panel.label}
                  className={`group flex items-center justify-center h-7 rounded-sm cursor-pointer text-xs whitespace-nowrap transition-all duration-ds ease-ds ${
                    active
                      ? "gap-2 px-2 bg-surface-tab text-ink-strong"
                      : "w-7 text-ink-muted hover:text-ink-dim hover:bg-surface-hover"
                  }`}
                >
                  <PanelGlyph kind={panel.kind} size={13} private={panel.private} />
                  {/* Square icon tiles, because the strip has to hold a growing
                      set of tools — the video editor is only the first. Just
                      the active tile spends width on its label, which is what
                      keeps three tabs called "File" tellable apart; the rest
                      carry theirs in the tooltip. */}
                  {active && (
                    <>
                      <span className="max-w-[120px] truncate">{panel.label}</span>
                      <button
                        type="button"
                        aria-label={`Close ${panel.label}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          close(panel.id);
                        }}
                        className="opacity-60 hover:opacity-100 transition-opacity duration-ds ease-ds"
                      >
                        <X size={12} />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <IconButton
            onClick={(event) => {
              event.stopPropagation();
              setAddMenuOpen(!isAddMenuOpen);
            }}
            active={isAddMenuOpen}
            title="Open a panel"
            size={26}
          >
            <Plus size={15} />
          </IconButton>

          <Menu
            open={isAddMenuOpen}
            onClose={() => setAddMenuOpen(false)}
            items={addItems}
            anchor="top-[38px] left-2"
            width={264}
          />

          <div className="flex-1" />

          <IconButton
            onClick={toggleExpanded}
            active={isExpanded}
            title={isExpanded ? "Minimize panel" : "Widen panel"}
            size={24}
          >
            {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </IconButton>
          <IconButton onClick={toggleOpen} title="Hide panels" size={24}>
            <PanelRight size={14} />
          </IconButton>
        </div>
      )}
    </header>
  );
};
