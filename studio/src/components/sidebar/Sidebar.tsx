import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, Check, LoaderCircle, RefreshCw, Search as SearchIcon } from "lucide-react";
import { SKILLS_LIST, useStudioStore } from "../../store/studioStore";
import { WorkspaceService } from "../../services/workspaceService";
import { GlobalSearchView } from "../search/GlobalSearchView";
import { EmptyState, IconButton, Input, SectionLabel, SidebarRow } from "../ui";
import { FileTreeItem } from "./FileTree";
import { StudioSidebar } from "./StudioSidebar";
import { SidebarFooter } from "./SidebarFooter";
import type { UseUpdatesResult } from "../../hooks/useUpdates";
import { PRIMARY_NAV, WORKSPACE_NAV, type SidebarTabId } from "./ActivityBar";

/**
 * The sidebar panel: nav rows on top, the chosen view below, the account at the
 * foot. All three are always on screen.
 *
 * The nav used to belong to the chats view alone, because the rail beside it
 * was doing the switching. With the rail folded away the rows *are* the switch,
 * so they were hoisted here — which is also what Cursor does: New Chat, Search,
 * Automations and Customize stay put no matter which view is open, and only the
 * region under them changes. A view that scrolled the nav off the top would
 * strand anyone who opened Explorer and wanted back out.
 *
 * Each tab is a view that already existed somewhere in the shell; this file
 * does not re-implement any of them, it only decides which one is on screen.
 */

/* ── Shared panel head ────────────────────────────────────────────────────── */

/**
 * Cursor has no uppercase mono panel headers. A section is named in the same
 * 13px it uses everywhere else, sentence case, one step down the text ramp, and
 * it is separated from what follows by space rather than by a rule.
 */
const PanelHeader: React.FC<{ title: string; trailing?: React.ReactNode }> = ({ title, trailing }) => (
  <header className="h-8 flex-shrink-0 flex items-center justify-between gap-2 pl-3.5 pr-2">
    <span className="text-sm text-ink-faint truncate">{title}</span>
    {trailing && <div className="flex items-center gap-0.5 flex-shrink-0">{trailing}</div>}
  </header>
);

/**
 * Host for a view that brings its own chrome. It strips the fixed width and
 * right border those views were written with, so they fill a resizable panel
 * instead of fighting it.
 */
const ViewHost: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex-1 min-h-0 flex flex-col overflow-hidden [&>*]:min-w-0 [&>*]:flex-1">{children}</div>
);

/* ── Explorer ─────────────────────────────────────────────────────────────── */

const ExplorerPanel: React.FC = () => {
  const { files, setFiles } = useStudioStore();
  const [rootName, setRootName] = useState("workspace");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [entryCount, setEntryCount] = useState(0);
  const [isTruncated, setIsTruncated] = useState(false);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      setError("");
      try {
        const workspace = await WorkspaceService.listFiles(signal);
        setFiles(workspace.files);
        setRootName(workspace.rootName);
        setEntryCount(workspace.entryCount);
        setIsTruncated(workspace.truncated);
      } catch (requestError) {
        if (signal?.aborted) return;
        setError(requestError instanceof Error ? requestError.message : "Workspace unavailable.");
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
    },
    [setFiles],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const visibleFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return files;
    return files.filter(
      (item) =>
        item.path.toLowerCase().includes(query) ||
        item.children?.some((child) => child.path.toLowerCase().includes(query)),
    );
  }, [files, filter]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PanelHeader
        title="Explorer"
        trailing={
          <IconButton
            onClick={() => void refresh()}
            disabled={isLoading}
            title="Refresh workspace"
            aria-label="Refresh workspace"
            size={24}
          >
            {isLoading ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </IconButton>
        }
      />

      <div className="px-2 pt-2">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter files"
          aria-label="Filter workspace files"
          icon={<SearchIcon size={13} />}
          clearable
          onClear={() => setFilter("")}
        />
      </div>

      {/* The root reads as a label rather than a row: it is not clickable, and
          the count is the honest measure of what the tree below is showing. */}
      <div className="flex items-center justify-between gap-2 px-4 pt-2.5 pb-1.5">
        <span className="font-mono text-3xs uppercase tracking-wider text-ink-faint truncate">{rootName}</span>
        <span className="font-mono text-3xs text-ink-disabled flex-shrink-0">
          {entryCount}
          {isTruncated ? "+" : ""} entries · read only
        </span>
      </div>

      {error && (
        <p className="mx-2 mb-2 rounded-md bg-surface-sunken px-3 py-2 text-2xs text-danger leading-relaxed" role="alert">
          {error}
        </p>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto pb-2 pr-1" aria-label={`${rootName} files`}>
        {!isLoading && visibleFiles.length === 0 && !error && (
          <EmptyState title="Nothing here" detail="No supported files match this filter." />
        )}
        {visibleFiles.map((item) => (
          <FileTreeItem key={item.id} item={item} filter={filter} onError={setError} />
        ))}
      </div>
    </div>
  );
};

/* ── Skills ───────────────────────────────────────────────────────────────── */

/**
 * The same skill packs the modal mounts, in a column. Clicking the mounted one
 * unmounts it — in a panel that stays open there has to be a way back out, and
 * the store already models "no skill" as null.
 */
const SkillsPanel: React.FC = () => {
  const { activeSkill, setSkill } = useStudioStore();

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PanelHeader title="Skills" />
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
        {SKILLS_LIST.map((skill) => {
          const isActive = activeSkill?.id === skill.id;
          return (
            <button
              key={skill.id}
              type="button"
              onClick={() => setSkill(isActive ? null : skill)}
              aria-pressed={isActive}
              className={`lit lit-inner w-full text-left rounded-lg p-2.5 flex flex-col gap-1.5 transition-colors duration-ds ease-ds ${
                isActive ? "bg-reason/10" : "bg-surface-sunken hover:bg-surface"
              }`}
            >
              <span className="flex items-center gap-2">
                <Boxes size={14} className={isActive ? "text-reason flex-shrink-0" : "text-ink-muted flex-shrink-0"} />
                <span className="flex-1 min-w-0 truncate text-xs text-ink-high">{skill.name}</span>
                {isActive && (
                  <span className="flex items-center gap-1 font-mono text-3xs uppercase tracking-wider text-reason flex-shrink-0">
                    <Check size={11} />
                    Mounted
                  </span>
                )}
              </span>
              <span className="block text-2xs text-ink-muted leading-relaxed">{skill.tagline}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

/* ── The panel ────────────────────────────────────────────────────────────── */

export interface SidebarProps {
  tab: SidebarTabId;
  onSelectTab: (tab: SidebarTabId) => void;
  /** Which non-tab view the shell is showing, for nav highlighting. */
  activeView: string;
  onNewChat: () => void;
  onOpenCustomize: () => void;
  onOpenSettings: () => void;
  onConnectGitHub: () => void;
  updates: UseUpdatesResult;
  onOpenUpdate: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  tab,
  onSelectTab,
  activeView,
  onNewChat,
  onOpenCustomize,
  onOpenSettings,
  onConnectGitHub,
  updates,
  onOpenUpdate,
}) => {
  const primaryAction: Record<string, () => void> = {
    "new-chat": () => {
      onNewChat();
      onSelectTab("chats");
    },
    // One action, not two. This used to select the search view *and* open the
    // command palette over it, so the view was covered the moment it appeared.
    search: () => onSelectTab("search"),
    customize: onOpenCustomize,
  };

  // "New Chat" is an action, never a destination, so it never lights up.
  const primaryActive: Record<string, boolean> = {
    "new-chat": false,
    search: tab === "search",
    customize: activeView === "customize",
  };

  const view = () => {
    switch (tab) {
      case "files":
        return <ExplorerPanel />;
      case "search":
        return (
          <ViewHost>
            <GlobalSearchView />
          </ViewHost>
        );
      case "skills":
        return <SkillsPanel />;
      case "chats":
      default:
        return <StudioSidebar activeView={activeView} />;
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ── Nav ──────────────────────────────────────────────────────────
          Cursor's four, then this studio's three. The gap between the groups
          is the only thing separating them; a rule here would be the first
          horizontal line in a sidebar that has none. */}
      <nav className="flex-shrink-0 flex flex-col gap-px pt-1.5" aria-label="Views">
        {PRIMARY_NAV.map((item) => (
          <SidebarRow
            key={item.id}
            icon={<item.icon size={16} strokeWidth={1.7} />}
            active={primaryActive[item.id]}
            onClick={primaryAction[item.id]}
          >
            {item.label}
          </SidebarRow>
        ))}

        <div className="mt-4">
          <SectionLabel>Workspace</SectionLabel>
        </div>
        {WORKSPACE_NAV.map((item) => (
          <SidebarRow
            key={item.id}
            icon={<item.icon size={16} strokeWidth={1.7} />}
            active={tab === item.id}
            title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
            onClick={() => onSelectTab(item.id)}
          >
            {item.label}
          </SidebarRow>
        ))}
      </nav>

      {/* ── The chosen view ──────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col mt-4">{view()}</div>

      <SidebarFooter
        onConnectGitHub={onConnectGitHub}
        onOpenSettings={onOpenSettings}
        updates={updates}
        onOpenUpdate={onOpenUpdate}
      />
    </div>
  );
};
