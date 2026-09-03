import React from "react";
import { ResizeHandle } from "../layout/ResizeHandle";
import { ActivityBar, type SidebarTabId } from "./ActivityBar";
import { Sidebar } from "./Sidebar";
import type { UseUpdatesResult } from "../../hooks/useUpdates";

/**
 * The left dock: the activity bar, and the panel it drives.
 *
 * This was a rail plus a panel, then a single panel with labelled nav rows,
 * and it is a rail plus a panel again — the operator asked for "the left
 * sidebar buttons only so it gets thinner", answered as VS Code's shape. The
 * argument the single-panel version was built on still stands and was traded
 * away knowingly: Cursor's agent window has one vertical seam, and this has
 * two. What it buys is that the switch costs 48px instead of 212, that Media,
 * Skills, Explorer, Search and Chats all fit in it without wrapping, and that
 * the panel can be dismissed without losing the way back to it.
 *
 * The rail is not hidden when the panel is collapsed. That is the difference
 * between collapsing and closing: with the glyphs still there, a collapsed
 * sidebar is one click from being open on any view, and ⌘B stops being the
 * only way back.
 */

export interface SidebarDockProps {
  tab: SidebarTabId;
  onSelectTab: (tab: SidebarTabId) => void;
  width: number;
  collapsed: boolean;
  onSetCollapsed: (collapsed: boolean) => void;
  onResize: (delta: number) => void;
  onResetWidth: () => void;
  onNewChat: () => void;
  onOpenCustomize: () => void;
  onOpenSettings: () => void;
  onConnectGitHub: () => void;
  updates: UseUpdatesResult;
  onOpenUpdate: () => void;
  activeView: string;
}

export const SidebarDock: React.FC<SidebarDockProps> = ({
  tab,
  onSelectTab,
  width,
  collapsed,
  onSetCollapsed,
  onResize,
  onResetWidth,
  onNewChat,
  onOpenCustomize,
  onOpenSettings,
  onConnectGitHub,
  updates,
  onOpenUpdate,
  activeView,
}) => (
  <>
    <ActivityBar
      tab={tab}
      onSelectTab={onSelectTab}
      collapsed={collapsed}
      onSetCollapsed={onSetCollapsed}
      onNewChat={onNewChat}
      onOpenCustomize={onOpenCustomize}
      activeView={activeView}
    />

    {!collapsed && (
      <>
        <aside
          className="flex-shrink-0 flex flex-col min-h-0 border-r border-edge-chrome bg-rail-mid"
          style={{ width }}
          aria-label="Sidebar"
        >
          <Sidebar
            tab={tab}
            activeView={activeView}
            onOpenSettings={onOpenSettings}
            onConnectGitHub={onConnectGitHub}
            updates={updates}
            onOpenUpdate={onOpenUpdate}
          />
        </aside>

        <ResizeHandle onResize={onResize} onDoubleClick={onResetWidth} orientation="vertical" />
      </>
    )}
  </>
);
