import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Maximize2,
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
  onOpenOverflow?: () => void;
}

export const StudioTitleBar: React.FC<StudioTitleBarProps> = ({
  title,
  sidebarWidth,
  sidebarCollapsed,
  onToggleSidebar,
  onOpenIde,
  onOpenOverflow,
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
  // The rail is gone, so the title bar's left region is the sidebar and nothing
  // else. When the sidebar is hidden the region collapses to just enough room
  // for the traffic lights and the toggle, which then sit over the canvas —
  // which is what Cursor does too.
  const railWidth = sidebarCollapsed ? "auto" : `${sidebarWidth}px`;

  // Administrator-only panels are omitted rather than shown disabled: an
  // operator who is not an admin has no use for a row that always refuses. The
  // routes behind them re-check regardless — this is presentation, not the gate.
  const adminOnly = new Set<PanelKind>(["release", "arena"]);
  const kinds = (["file", "terminal", "browser", "canvas", "side", "claude", "codex", "usage", "arena", "release", "guardian"] as PanelKind[])
    .filter((kind) => !adminOnly.has(kind) || isAdmin);

  const addItems: MenuItem[] = kinds.map((kind) => ({
    id: kind,
    label: PANEL_DEFAULTS[kind].label,
    shortcut: PANEL_DEFAULTS[kind].shortcut,
    icon: <PanelGlyph kind={kind} size={14} />,
    // A terminal and a side chat are cheap to have several of; a browser or a
    // canvas is not, so those focus an existing one instead of stacking up.
    // A terminal and a side chat are cheap to have several of; a browser, a
    // canvas or an agent is not — an agent tab holds a live CLI session, and a
    // second one starts a conversation with an agent that remembers nothing.
    onSelect: () =>
      kind === "terminal" || kind === "side" ? open({ kind }) : focusOrOpen({ kind }),
  }));

  return (
    <header
      className="flex items-stretch flex-shrink-0 select-none"
      style={{ height: "var(--titlebar-h)", WebkitAppRegion: "drag" } as React.CSSProperties}
      onDoubleClick={() => void window.teminali?.window.toggleMaximize()}
    >
      {/* ── Sidebar region ─────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 pl-[11px] pr-2 border-r border-edge-chrome flex-shrink-0"
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
      <div className="flex-1 min-w-0 flex items-center gap-3 px-4">
        <span className="text-sm text-ink-faint truncate">{title}</span>
        {title && <MonitorSmartphone size={13} className="text-ink-placeholder flex-shrink-0" />}

        <div className="flex-1" />

        <div
          className="flex items-center gap-3 font-mono text-xs text-ink-muted"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={onOpenIde}
            className="flex items-center gap-1.5 hover:text-ink-high transition-colors duration-ds ease-ds"
          >
            IDE
            <ExternalLink size={11} />
          </button>
          <IconButton onClick={onOpenOverflow} title="More" size={24}>
            <MoreHorizontal size={15} />
          </IconButton>
          <IconButton onClick={toggleOpen} active={isOpen} title="Toggle panels" size={24}>
            <PanelRight size={15} />
          </IconButton>
        </div>
      </div>

      {/* ── Panel tab strip ────────────────────────────────────────────── */}
      {isOpen && (
        <div
          className="flex items-center gap-1.5 px-3 border-l border-edge-chrome flex-shrink-0 min-w-0 relative"
          style={{
            width: isExpanded ? "var(--panel-w-expanded)" : width,
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
                  className={`group flex items-center gap-2 h-7 px-2.5 rounded-sm cursor-pointer text-xs whitespace-nowrap transition-colors duration-ds ease-ds ${
                    active ? "bg-surface-tab text-ink-strong" : "text-ink-muted hover:text-ink-dim"
                  }`}
                >
                  <PanelGlyph kind={panel.kind} size={13} />
                  <span className="max-w-[120px] truncate">{panel.label}</span>
                  <button
                    type="button"
                    aria-label={`Close ${panel.label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      close(panel.id);
                    }}
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity duration-ds ease-ds"
                  >
                    <X size={12} />
                  </button>
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

          <IconButton onClick={toggleExpanded} active={isExpanded} title="Widen panel" size={24}>
            <Maximize2 size={14} />
          </IconButton>
          <IconButton onClick={toggleOpen} title="Hide panels" size={24}>
            <PanelRight size={14} />
          </IconButton>
        </div>
      )}
    </header>
  );
};
