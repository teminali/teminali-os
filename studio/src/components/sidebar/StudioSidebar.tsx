import React, { useEffect, useMemo, useState } from "react";
import { FolderGit2, FolderOpen, House, ListFilter } from "lucide-react";
import { WorkspaceService, type ProjectEntry } from "../../services/workspaceService";
import { useStudioStore, type ChatSession } from "../../store/studioStore";
import { SectionLabel, SidebarRow, IconButton } from "../ui";

/**
 * The chats view: repositories, and the conversations nested under them.
 *
 * The nav rows that used to sit above this moved up into `Sidebar` when the
 * activity rail was folded away — they belong to every view now, not just this
 * one. What is left is exactly what Cursor shows under its four nav rows: a
 * "Repositories" label with a filter and an open-folder control, one row per
 * repository, and each repository's conversations indented beneath it with
 * their age on the right.
 *
 * Repositories come from the gateway's project list rather than a hardcoded
 * array, so what is shown is what is actually on disk.
 */

export interface StudioSidebarProps {
  activeView: string;
}

/** Compact relative age, the way Cursor shows it: "1m", "21h", "2d". */
function age(iso: string): string {
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

export const StudioSidebar: React.FC<StudioSidebarProps> = () => {
  const { chatSessions, activeSessionId, switchSession, workspacePath } = useStudioStore();
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [current, setCurrent] = useState<ProjectEntry | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    WorkspaceService.listProjects(controller.signal)
      .then((response) => {
        setCurrent(response.current);
        setProjects(response.recent);
        setProjectError(null);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        // A missing gateway must not blank the sidebar; say so and carry on.
        setProjectError((failure as Error).message);
      });
    return () => controller.abort();
  }, [workspacePath]);

  /** Conversations grouped under the repository they belong to. */
  const grouped = useMemo(() => {
    const byWorkspace = new Map<string, ChatSession[]>();
    for (const session of chatSessions) {
      const key = session.workspace || "No Repo";
      const list = byWorkspace.get(key) ?? [];
      list.push(session);
      byWorkspace.set(key, list);
    }
    return byWorkspace;
  }, [chatSessions]);

  const repositories = useMemo(() => {
    const names = new Set<string>();
    if (current) names.add(current.name);
    for (const project of projects) names.add(project.name);
    for (const key of grouped.keys()) names.add(key);
    return Array.from(names);
  }, [current, projects, grouped]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <SectionLabel
        trailing={
          <>
            <IconButton title="Filter" size={22}>
              <ListFilter size={15} strokeWidth={1.7} />
            </IconButton>
            <IconButton title="Open a project" size={22}>
              <FolderOpen size={15} strokeWidth={1.7} />
            </IconButton>
          </>
        }
      >
        Repositories
      </SectionLabel>

      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        {projectError && (
          <p className="mx-4 mb-2 text-2xs text-ink-disabled leading-relaxed">
            Projects are unavailable — {projectError}
          </p>
        )}

        {repositories.map((name) => {
          const sessions = grouped.get(name) ?? [];
          const isNoRepo = name === "No Repo";
          return (
            <div key={name} className="mb-2">
              <SidebarRow
                icon={
                  isNoRepo ? (
                    <House size={16} strokeWidth={1.7} />
                  ) : (
                    <FolderGit2 size={16} strokeWidth={1.7} />
                  )
                }
                className="w-[calc(100%-16px)]"
              >
                {name}
              </SidebarRow>

              {sessions.map((session) => (
                <SidebarRow
                  key={session.id}
                  indent
                  active={session.id === activeSessionId}
                  trailing={age(session.timestamp)}
                  onClick={() => switchSession(session.id)}
                  className="w-[calc(100%-16px)]"
                >
                  {session.title}
                </SidebarRow>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};
