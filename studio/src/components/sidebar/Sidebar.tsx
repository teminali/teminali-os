import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, Check, FilePlus, Folder, FolderOpen, FolderPlus, LoaderCircle, RefreshCw, Search as SearchIcon, X } from "lucide-react";
import { SKILLS_LIST, useStudioStore } from "../../store/studioStore";
import { usePanelStore } from "../../store/panelStore";
import { WorkspaceService } from "../../services/workspaceService";
import { GlobalSearchView } from "../search/GlobalSearchView";
import { EmptyState, IconButton, Input, SectionLabel } from "../ui";
import { FileTreeItem } from "./FileTree";
import { ProjectsPanel } from "./ProjectsPanel";
import { StudioSidebar } from "./StudioSidebar";
import { SidebarFooter } from "./SidebarFooter";
import type { UseUpdatesResult } from "../../hooks/useUpdates";
import type { SpecialistSkill } from "../../types";
import type { SidebarTabId } from "./ActivityBar";

/**
 * The sidebar panel: the chosen view, with the account at its foot.
 *
 * The nav rows that used to sit on top are gone — the switch moved back out to
 * `ActivityBar`, which is a rail of glyphs again by the operator's call. What
 * that leaves here is a panel that shows one view and nothing else, which is
 * the whole point of the change: nothing in this file has to be narrow enough
 * to sit beside a label any more, so the panel opens 48px thinner than it did.
 *
 * Each tab is a view that already existed somewhere in the shell; this file
 * does not re-implement any of them, it only decides which one is on screen.
 * Media is no longer among them: its pool is the video editor's own rail now,
 * and the approval gate never depended on this panel — see `ActivityBar`.
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
  const { files, setFiles, openFile, setWorkspacePath } = useStudioStore();
  const workspacePath = useStudioStore((state) => state.workspacePath);
  const focusOrOpen = usePanelStore((state) => state.focusOrOpen);
  const [rootName, setRootName] = useState("workspace");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [entryCount, setEntryCount] = useState(0);
  const [isTruncated, setIsTruncated] = useState(false);

  const [creationKind, setCreationKind] = useState<"file" | "folder" | null>(null);
  const [creationName, setCreationName] = useState("");
  const [isSubmittingCreation, setIsSubmittingCreation] = useState(false);
  const creationInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creationKind) {
      setTimeout(() => creationInputRef.current?.focus(), 50);
    }
  }, [creationKind]);

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

  // `workspacePath` is a dependency and not decoration: the tree route reads
  // whatever root the gateway is bound to, so opening a project from My
  // Projects changes what `listFiles` returns without changing this component.
  // Without it the Explorer keeps drawing the previous repository.
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh, workspacePath]);

  const handleChooseFolder = async () => {
    try {
      const bridge = window.teminali?.projects;
      if (bridge?.chooseFolder) {
        const chosen = await bridge.chooseFolder();
        if (chosen) {
          const response = await WorkspaceService.openProject(chosen);
          setWorkspacePath(response.current.path);
          await refresh();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open folder.");
    }
  };

  const handleCommitCreation = async () => {
    const target = creationName.trim();
    if (!target) {
      setCreationKind(null);
      return;
    }
    setIsSubmittingCreation(true);
    setError("");
    try {
      if (creationKind === "file") {
        const written = await WorkspaceService.writeFile(target, "");
        setCreationKind(null);
        setCreationName("");
        await refresh();
        openFile({
          path: written.path,
          name: written.name,
          content: "",
        });
        focusOrOpen({ kind: "file" });
      } else {
        await WorkspaceService.createDirectory(target);
        setCreationKind(null);
        setCreationName("");
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Creation failed.");
    } finally {
      setIsSubmittingCreation(false);
    }
  };

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
          <>
            <IconButton
              onClick={() => {
                setCreationKind("file");
                setCreationName("");
              }}
              title="New File (⌘N)"
              aria-label="New File"
              size={24}
            >
              <FilePlus size={13} strokeWidth={1.8} />
            </IconButton>
            <IconButton
              onClick={() => {
                setCreationKind("folder");
                setCreationName("");
              }}
              title="New Folder"
              aria-label="New Folder"
              size={24}
            >
              <FolderPlus size={13} strokeWidth={1.8} />
            </IconButton>
            <IconButton
              onClick={() => void handleChooseFolder()}
              title="Open Folder…"
              aria-label="Open Folder"
              size={24}
            >
              <FolderOpen size={13} strokeWidth={1.8} />
            </IconButton>
            <IconButton
              onClick={() => void refresh()}
              disabled={isLoading}
              title="Refresh workspace"
              aria-label="Refresh workspace"
              size={24}
            >
              {isLoading ? <LoaderCircle size={13} className="animate-spin" /> : <RefreshCw size={13} strokeWidth={1.8} />}
            </IconButton>
          </>
        }
      />

      <div className="px-2 pt-1 pb-1">
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

      {/* Prominently displayed active project root with live item count */}
      <div
        className="flex items-center justify-between gap-2 px-3 pt-2 pb-1 select-none"
        title={workspacePath || rootName}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Folder size={12} className="text-accent flex-shrink-0" />
          <span className="font-mono text-2xs font-semibold tracking-wide text-ink-bright truncate">
            {rootName}
          </span>
        </div>
        <span className="font-mono text-3xs text-ink-faint flex-shrink-0 tabular-nums">
          {entryCount}
          {isTruncated ? "+" : ""} files
        </span>
      </div>

      {/* Inline File / Folder Creation Row */}
      {creationKind && (
        <div className="mx-2 my-1.5 p-1.5 rounded-lg border border-accent/40 bg-surface-sunken flex items-center gap-2 shadow-sm">
          {creationKind === "file" ? (
            <FilePlus size={13} className="text-accent flex-shrink-0 ml-0.5" />
          ) : (
            <FolderPlus size={13} className="text-warning flex-shrink-0 ml-0.5" />
          )}
          <input
            ref={creationInputRef}
            type="text"
            value={creationName}
            onChange={(e) => setCreationName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCommitCreation();
              else if (e.key === "Escape") setCreationKind(null);
            }}
            placeholder={creationKind === "file" ? "filename.ts or dir/file.ts" : "folder-name"}
            className="flex-1 bg-transparent text-xs text-ink-bright placeholder:text-ink-disabled outline-none"
            disabled={isSubmittingCreation}
          />
          {isSubmittingCreation ? (
            <LoaderCircle size={12} className="animate-spin text-ink-faint mr-0.5" />
          ) : (
            <button
              type="button"
              onClick={() => setCreationKind(null)}
              className="text-ink-faint hover:text-ink-high p-0.5"
              title="Cancel (Esc)"
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="mx-2 my-1.5 rounded-md bg-surface-sunken px-3 py-2 text-2xs text-danger leading-relaxed" role="alert">
          {error}
        </p>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto pb-2 pr-1" aria-label={`${rootName} files`}>
        {!isLoading && visibleFiles.length === 0 && !error && (
          <div className="px-4 py-8 text-center space-y-3">
            <p className="text-xs text-ink-muted">No files match this filter.</p>
            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={() => void handleChooseFolder()}
                className="w-full py-1.5 px-3 rounded-lg border border-edge bg-surface-sunken hover:border-accent/40 text-xs text-ink-bright transition-colors"
              >
                Open Project Folder…
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreationKind("file");
                  setCreationName("");
                }}
                className="w-full py-1.5 px-3 rounded-lg border border-edge bg-surface-sunken hover:border-accent/40 text-xs text-ink-bright transition-colors"
              >
                + Create New File
              </button>
            </div>
          </div>
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
 * The skill catalogue, in a column: one list, not two.
 *
 * The IDE skills and the video skills were separate ideas until the operator
 * asked for them combined, and combining them is not cosmetic — "which skills
 * do I have" should be one question with one answer no matter which half of
 * the app you are standing in. They are grouped by the `category` each entry
 * carries rather than interleaved, because a section label is cheaper to skim
 * than a badge repeated on every row.
 *
 * Clicking the mounted one unmounts it — in a panel that stays open there has
 * to be a way back out, and the store already models "no skill" as null.
 */

const SKILL_GROUPS: readonly { id: SpecialistSkill["category"]; label: string }[] = [
  { id: "code", label: "Code" },
  { id: "video", label: "Video" },
];

const SkillsPanel: React.FC = () => {
  const { activeSkill, setSkill } = useStudioStore();

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PanelHeader title="Skills" />
      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        {SKILL_GROUPS.map((group) => {
          const skills = SKILLS_LIST.filter((skill) => skill.category === group.id);
          // A label over nothing teaches that a group can be empty. Drop it.
          if (skills.length === 0) return null;

          return (
            <section key={group.id}>
              <SectionLabel>{group.label}</SectionLabel>
              <div className="px-2 pb-1 space-y-1.5">
                {skills.map((skill) => {
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
                        <Boxes
                          size={14}
                          className={isActive ? "text-reason flex-shrink-0" : "text-ink-muted flex-shrink-0"}
                        />
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
            </section>
          );
        })}
      </div>
    </div>
  );
};

/* ── The panel ────────────────────────────────────────────────────────────── */

export interface SidebarProps {
  tab: SidebarTabId;
  /** Which non-tab view the shell is showing. Read by the chats view. */
  activeView: string;
  onOpenSettings: () => void;
  onConnectGitHub: () => void;
  updates: UseUpdatesResult;
  onOpenUpdate: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  tab,
  activeView,
  onOpenSettings,
  onConnectGitHub,
  updates,
  onOpenUpdate,
}) => {
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
      case "projects":
        return <ProjectsPanel />;
      case "skills":
        return <SkillsPanel />;
      case "chats":
      default:
        return <StudioSidebar activeView={activeView} />;
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* The view starts at the top now. There is no nav above it to scroll
          past, and the rail beside it is what says which one this is. */}
      <div className="flex-1 min-h-0 flex flex-col pt-1.5">{view()}</div>

      <SidebarFooter
        onConnectGitHub={onConnectGitHub}
        onOpenSettings={onOpenSettings}
        updates={updates}
        onOpenUpdate={onOpenUpdate}
      />
    </div>
  );
};
