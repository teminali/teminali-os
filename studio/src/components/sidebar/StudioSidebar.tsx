import React, { useMemo, useState } from "react";
import {
  Clapperboard,
  Copy,
  FolderGit2,
  FolderOpen,
  House,
  ListFilter,
  MoreHorizontal,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { WorkspaceService, type ProjectEntry } from "../../services/workspaceService";
import { useProjectLibrary } from "../../hooks/useProjectLibrary";
import { usePanelStore } from "../../store/panelStore";
import { useStudioStore, type ChatSession } from "../../store/studioStore";
// One vocabulary for "how long ago": the browser's Recent list says "2d" too,
// and two lists describing the same span differently is two lists to read.
import { relativeAge as age } from "../../utils/siteMark";
import { SectionLabel, SidebarRow, IconButton, Menu, type MenuItem } from "../ui";

/**
 * The chats view: past conversations, grouped by the project they belong to.
 *
 * The nav rows that used to sit above this moved up into `Sidebar` when the
 * activity rail was folded away — they belong to every view now, not just this
 * one. What is left is a filter and a new-chat control, one row per repository,
 * and each repository's conversations indented beneath it with their age on
 * the right.
 *
 * ## It is chat history, not a repository browser
 *
 * The label read "Repositories" for as long as this panel existed, which is
 * what the eye sees first and so what the panel appeared to be — a list of
 * checkouts that happened to have chats under it. The content was always the
 * other way round: the chats are the subject and the repository is only how
 * they are filed. Naming it "Chat history" costs nothing and stops the panel
 * claiming to be the one thing it is not; the repository rows stay exactly
 * where they were, because filing chats under their project is the point.
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
  const { current, recent, error: projectError, openEntry, reload } = useProjectLibrary();
  const focusOrOpen = usePanelStore((state) => state.focusOrOpen);
  const [filter, setFilter] = useState<string | null>(null);
  /** Which project row has its action menu open, by name. One at a time. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** What went wrong with the last action, said once, above the list. */
  const [notice, setNotice] = useState<string | null>(null);

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

  /**
   * Stop listing a project. The disk is not touched.
   *
   * This is the verb the platform already had — `forgetProject` has existed in
   * `workspaceService` the whole time with nothing in the interface calling it,
   * so tidying the list was possible and unreachable.
   */
  const forgetEntry = async (entry: ProjectEntry) => {
    setNotice(null);
    try {
      await WorkspaceService.forgetProject(entry.path);
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : `Could not remove ${entry.name} from the list.`);
    }
  };

  /**
   * Send the project folder to the Trash, then stop listing it.
   *
   * The confirmation is raised by the main process, not here — see
   * `electron/main.cjs`. A dialog drawn in the renderer is one the renderer can
   * decide not to draw, and this is the only control in the product that takes
   * something off the operator's disk. Cancelling is a normal outcome and says
   * nothing; only a refusal explains itself.
   */
  const trashEntry = async (entry: ProjectEntry) => {
    const bridge = window.teminali?.projects;
    if (!bridge?.moveToTrash) return;
    setNotice(null);
    try {
      const result = await bridge.moveToTrash(entry.path);
      if (result.cancelled) return;
      if (!result.trashed) {
        setNotice(result.reason ?? `Could not move ${entry.name} to the Trash.`);
        return;
      }
      // The folder has gone; a list still offering to open it would be lying.
      await forgetEntry(entry);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : `Could not move ${entry.name} to the Trash.`);
    }
  };

  /**
   * The menu behind a project row's ⋯ button.
   *
   * Every item does something — the rule this panel was rebuilt around. The two
   * that need the desktop shell are disabled rather than hidden in a browser
   * build, so the menu has one shape and the reason a thing is unavailable is
   * visible instead of inferred from an absence.
   */
  const projectActions = (entry: ProjectEntry): MenuItem[] => {
    const bridge = window.teminali?.projects;
    return [
      {
        id: "open",
        label: "Open project",
        icon: <FolderOpen size={14} strokeWidth={1.7} />,
        onSelect: () => openRepository(entry),
      },
      {
        id: "reveal",
        label: "Reveal in Finder",
        icon: <FolderGit2 size={14} strokeWidth={1.7} />,
        disabled: !bridge?.reveal,
        onSelect: () => void bridge?.reveal?.(entry.path),
      },
      {
        id: "copy",
        label: "Copy path",
        icon: <Copy size={14} strokeWidth={1.7} />,
        onSelect: () => void navigator.clipboard?.writeText(entry.path),
      },
      {
        id: "forget",
        label: "Remove from Teminali",
        icon: <X size={14} strokeWidth={1.7} />,
        onSelect: () => void forgetEntry(entry),
      },
      {
        id: "trash",
        label: "Move to Trash…",
        icon: <Trash2 size={14} strokeWidth={1.7} />,
        disabled: !bridge?.moveToTrash,
        onSelect: () => void trashEntry(entry),
      },
    ];
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
        Chat history
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
            placeholder="Filter chats and projects"
            aria-label="Filter chats and projects"
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

        {notice && (
          <p className="mx-4 mb-2 text-2xs text-ink-disabled leading-relaxed">{notice}</p>
        )}

        {repositories.map(({ name, entry }) => {
          const sessions = grouped.get(name) ?? [];
          const isNoRepo = name === "No Repo";
          return (
            // `space-y-1` is the 4px between a project and its chats, and
            // between one chat and the next. The rows were flush before, which
            // is what made a dense list read as a single block of text.
            <div key={name} className="mb-2 space-y-1">
              {/*
                The row and its actions are siblings, not parent and child:
                `SidebarRow` is a `<button>`, and a button inside a button is
                not a thing the browser will render. So the ⋯ sits over the
                row, absolutely placed, and the click never reaches the row
                underneath because it never passes through it.
              */}
              <div className="relative group">
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
                  // Room for the ⋯ so a long project name is truncated by the
                  // button rather than sliding underneath it.
                  className={`w-[calc(100%-16px)] ${entry ? "group-hover:pr-8" : ""}`}
                >
                  {name}
                </SidebarRow>

                {/*
                  Only a real project has actions. A heading over orphaned chats
                  has nothing to open, reveal, or throw away.

                  Kept mounted while its own menu is open, or dismissing the
                  menu by clicking the item it belongs to would fight itself.
                */}
                {entry && (
                  <div
                    className={`absolute right-3 top-1/2 -translate-y-1/2 transition-opacity duration-ds ease-ds ${
                      menuFor === name
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    }`}
                  >
                    <IconButton
                      title={`Actions for ${name}`}
                      aria-label={`Actions for ${name}`}
                      size={22}
                      active={menuFor === name}
                      onClick={() => setMenuFor((open) => (open === name ? null : name))}
                    >
                      <MoreHorizontal size={15} strokeWidth={1.7} />
                    </IconButton>
                  </div>
                )}

                {entry && (
                  <Menu
                    open={menuFor === name}
                    onClose={() => setMenuFor(null)}
                    items={projectActions(entry)}
                    anchor="top-8 right-3"
                    width={210}
                  />
                )}
              </div>

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
