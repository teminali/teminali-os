import React, { useMemo } from "react";
import { Clapperboard, FolderGit2, FolderOpen, RefreshCw } from "lucide-react";

import { useProjectLibrary } from "../../hooks/useProjectLibrary";
import { usePanelStore } from "../../store/panelStore";
import { openVideoProject } from "../../video/project/io";
import { EmptyState, IconButton, SectionLabel, SidebarRow } from "../ui";
import type { ProjectEntry } from "../../services/workspaceService";

/**
 * My Projects — everything this machine has been working on, code and video in
 * one list.
 *
 * Two lists side by side was the alternative and it was rejected: an operator
 * looking for "the thing I had open on Tuesday" does not remember which of the
 * two editors it belonged to, and a split forces them to guess before they can
 * look. The glyph carries the kind, and the row's behaviour is what actually
 * differs — see `useProjectLibrary`.
 *
 * The kind is re-classified from disk on every read, so a folder that loses
 * its `project.json` comes back as a code project without anything having to
 * invalidate a cache.
 */

/** Compact relative age, matching `StudioSidebar`: "now", "21h", "2d". */
function age(iso?: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

export const ProjectsPanel: React.FC = () => {
  const { current, recent, error, loading, reload, openEntry } = useProjectLibrary();
  const focusOrOpen = usePanelStore((state) => state.focusOrOpen);

  /* The current root is a project like any other, and showing it twice would
     make the list disagree with itself about how many there are. */
  const entries = useMemo<ProjectEntry[]>(() => {
    const seen = new Set<string>();
    const list: ProjectEntry[] = [];
    for (const entry of [...(current ? [current] : []), ...recent]) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      list.push(entry);
    }
    return list;
  }, [current, recent]);

  const open = (entry: ProjectEntry) => {
    // The video editor has to be on screen before the load runs: it reports
    // through the video pane's own toasts, which render nowhere else.
    if (entry.kind === "video") focusOrOpen({ kind: "video" });
    void openEntry(entry);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <SectionLabel
        trailing={
          <>
            <IconButton title="Refresh" size={22} onClick={reload}>
              <RefreshCw size={14} strokeWidth={1.7} />
            </IconButton>
            <IconButton
              title="Open a video project"
              size={22}
              onClick={() => {
                focusOrOpen({ kind: "video" });
                void openVideoProject();
              }}
            >
              <FolderOpen size={15} strokeWidth={1.7} />
            </IconButton>
          </>
        }
      >
        My Projects
      </SectionLabel>

      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        {error && (
          <p className="mx-4 mb-2 text-2xs text-ink-disabled leading-relaxed">
            Projects are unavailable — {error}
          </p>
        )}

        {entries.map((entry) => (
          <SidebarRow
            key={entry.path}
            title={entry.path}
            active={entry.path === current?.path}
            onClick={() => open(entry)}
            trailing={age(entry.openedAt)}
            icon={
              entry.kind === "video" ? (
                <Clapperboard size={16} strokeWidth={1.7} />
              ) : (
                <FolderGit2 size={16} strokeWidth={1.7} />
              )
            }
            className="w-[calc(100%-16px)]"
          >
            {entry.name}
          </SidebarRow>
        ))}

        {!loading && entries.length === 0 && !error && (
          <EmptyState
            icon={<FolderGit2 size={22} strokeWidth={1.5} />}
            title="No projects yet"
            detail="Repositories you open and video projects you save both land here."
            action={{
              label: "Open a video project",
              onClick: () => {
                focusOrOpen({ kind: "video" });
                void openVideoProject();
              },
            }}
          />
        )}
      </div>
    </div>
  );
};
