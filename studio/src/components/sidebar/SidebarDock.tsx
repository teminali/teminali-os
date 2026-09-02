import React from "react";
import { ResizeHandle } from "../layout/ResizeHandle";
import type { SidebarTabId } from "./ActivityBar";
import { Sidebar } from "./Sidebar";
import type { UseUpdatesResult } from "../../hooks/useUpdates";

/**
 * The left dock — one panel, flush against the window edge.
 *
 * This was a 48px icon rail plus the panel it drove. Cursor's agent window has
 * no rail: a single 259px sidebar carries the traffic lights, the nav rows, the
 * repository list and the account footer, and its right edge is the only
 * structural divider in the shell. Splitting that into rail + panel put two
 * vertical seams where the reference has one, and no amount of recolouring
 * would have made the result read as Cursor.
 *
 * So the dock is now just the panel: one flat `--rail-*` fill, one hairline on
 * the right, and the resize edge. Choosing a view moved into the panel itself,
 * where a nav row does the job the rail's icons used to.
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
}) => {
  if (collapsed) return null;

  return (
    <>
      <aside
        className="flex-shrink-0 flex flex-col min-h-0 border-r border-edge-chrome bg-rail-mid"
        style={{ width }}
        aria-label="Sidebar"
      >
        <Sidebar
          tab={tab}
          onSelectTab={onSelectTab}
          activeView={activeView}
          onNewChat={onNewChat}
          onOpenCustomize={onOpenCustomize}
          onOpenSettings={onOpenSettings}
          onConnectGitHub={onConnectGitHub}
          updates={updates}
          onOpenUpdate={onOpenUpdate}
        />
      </aside>

      <ResizeHandle onResize={onResize} onDoubleClick={onResetWidth} orientation="vertical" />
    </>
  );
};
