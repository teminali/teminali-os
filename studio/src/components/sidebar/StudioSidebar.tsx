import React, { useMemo, useState } from "react";
import { Clapperboard, FolderGit2, House, ListFilter, SquarePen } from "lucide-react";
import { type ProjectEntry } from "../../services/workspaceService";
import { useProjectLibrary } from "../../hooks/useProjectLibrary";
import { usePanelStore } from "../../store/panelStore";
import { useStudioStore, type ChatSession } from "../../store/studioStore";
// One vocabulary for "how long ago": the browser's Recent list says "2d" too,
// and two lists describing the same span differently is two lists to read.
import { relativeAge as age } from "../../utils/siteMark";
import { SectionLabel, SidebarRow, IconButton } from "../ui";

/**
 * The chats view: repositories, and the conversations nested under them.
 *
 * The nav rows that used to sit above this moved up into `Sidebar` when the
 * activity rail was folded away — they belong to every view now, not just this
 * one. What is left is exactly what Cursor shows under its four nav rows: a
 * "Repositories" label with a filter and a new-chat control, one row per
 * repository, and each repository's conversations indented beneath it with
 * their age on the right.
 *
 * Repositories come from the gateway's project list rather than a hardcoded
 * array, so what is shown is what is actually on disk.
 *
 * ## Every row in here does something
 *
 * It did not. The repository rows were rendered with no `onClick` at all and
 * the two header buttons with no handler, so the operator clicked a list of
 * their own projects and watched nothing happen — twice over, because a chat
 * row moved the highlight and left the transcript alone (`switchSession`).
 * A row that looks pressable and is not is the worst thing a sidebar can
 * contain: it teaches that the whole panel is decoration.
 *
 * So a repository row opens that project, by the same route and in the same
 * order as `ProjectsPanel` — video projects bring the editor up first,
 * because the load reports through the video pane's own toasts. A group with
 * no project behind it is a heading and is not pressable, which is the honest
 * shape for "these chats belong to a repository you no longer have open".
 */

export interface StudioSidebarProps {
  activeView: string;
}


export const StudioSidebar: React.FC<StudioSidebarProps> = () => {
  const { chatSessions, activeSessionId, switchSession, newChatSession } = useStudioStore();
  /*
    The same hook the composer's recents row and My Projects read, rather than
    a third copy of the fetch. It is also what carries `path` and `kind`, which
    the rows here had no access to — and a row that does not know where a
    project is cannot open one, which is most of why none of them did.
  */
  const { current, recent, error: projectError, openEntry } = useProjectLibrary();
  const focusOrOpen = usePanelStore((state) => state.focusOrOpen);
  const [filter, setFilter] = useState<string | null>(null);

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

  /**
   * One row per repository, carrying the project behind it when there is one.
   *
   * A name can reach this list three ways: it is the project that is open, it
   * is a recent project, or it is only the label a chat was stamped with. The
   * first two have a `ProjectEntry` and are openable; the third is a heading
   * over chats whose repository is not in the list any more.
   */
  const repositories = useMemo(() => {
    const rows = new Map<string, ProjectEntry | null>();
    if (current) rows.set(current.name, current);
    for (const project of recent) if (!rows.has(project.name)) rows.set(project.name, project);
    for (const key of grouped.keys()) if (!rows.has(key)) rows.set(key, null);
    const all = Array.from(rows, ([name, entry]) => ({ name, entry }));
    const needle = filter?.trim().toLowerCase();
    if (!needle) return all;
    // A repository matches on its own name or on any chat filed under it —
    // filtering a tree by the branch alone hides the thing being looked for.
    return all.filter(
      ({ name }) =>
        name.toLowerCase().includes(needle) ||
        (grouped.get(name) ?? []).some((session) => session.title.toLowerCase().includes(needle)),
    );
  }, [current, recent, grouped, filter]);

  const openRepository = (entry: ProjectEntry) => {
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
            <IconButton
              title={filter === null ? "Filter chats" : "Clear filter"}
              size={22}
              onClick={() => setFilter((value) => (value === null ? "" : null))}
            >
              <ListFilter size={15} strokeWidth={1.7} />
            </IconButton>
            <IconButton title="New chat" size={22} onClick={() => newChatSession()}>
              <SquarePen size={15} strokeWidth={1.7} />
            </IconButton>
          </>
        }
      >
        Repositories
      </SectionLabel>

      {filter !== null && (
        <div className="px-4 pb-2">
          <input
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setFilter(null);
            }}
            placeholder="Filter repositories and chats"
            aria-label="Filter repositories and chats"
            className="w-full h-7 px-2 rounded-md bg-surface-chip border border-edge-popover text-2xs text-ink-high placeholder:text-ink-disabled outline-none focus-visible:border-edge-strong"
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        {projectError && (
          <p className="mx-4 mb-2 text-2xs text-ink-disabled leading-relaxed">
            Projects are unavailable — {projectError}
          </p>
        )}

        {repositories.map(({ name, entry }) => {
          const sessions = grouped.get(name) ?? [];
          const isNoRepo = name === "No Repo";
          return (
            <div key={name} className="mb-2">
              <SidebarRow
                title={entry ? entry.path : undefined}
                active={Boolean(entry) && entry?.path === current?.path}
                // Only a row with a project behind it is pressable. The rest
                // are headings, and `SidebarRow` draws them as such.
                onClick={entry ? () => openRepository(entry) : undefined}
                icon={
                  isNoRepo ? (
                    <House size={16} strokeWidth={1.7} />
                  ) : entry?.kind === "video" ? (
                    <Clapperboard size={16} strokeWidth={1.7} />
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
