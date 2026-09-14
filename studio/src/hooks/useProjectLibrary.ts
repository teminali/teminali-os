/*
  The project library: one list, two kinds.

  Both surfaces that show recent projects — the row under the empty composer
  and the sidebar's My Projects view — read this hook rather than the gateway
  directly, because the interesting part is not the fetch. It is that a code
  project and a video project are opened by two completely different routes,
  and the list must not make the operator care which:

    code   `POST /api/workspace/open` rebinds the root every workspace and
           terminal route reads, and the shell follows it.
    video  `POST /api/workspace/projects/remember` records it and rebinds
           NOTHING — a timeline is not a workspace, and opening one must not
           repoint the file tree at the folder that holds it.

  The kind is classified by the gateway from the marker on disk on every read,
  never stored, so a directory that stops being a video project stops being
  offered as one.
*/

import { useCallback, useEffect } from "react";
import { create } from "zustand";

import { WorkspaceService, type ProjectEntry } from "../services/workspaceService";
import { useStudioStore } from "../store/studioStore";
import { workspaceLabel } from "../utils/chatSessions";
import { openVideoProjectAt } from "../video/project/io";

export interface ProjectLibrary {
  current: ProjectEntry | null;
  recent: ProjectEntry[];
  /** Non-null when the gateway could not be reached; the surfaces stay drawn. */
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** Opens `entry` by its kind. Resolves once the switch has actually happened. */
  openEntry: (entry: ProjectEntry) => Promise<void>;
}

interface ProjectLibraryStore {
  current: ProjectEntry | null;
  recent: ProjectEntry[];
  error: string | null;
  loading: boolean;
  setProjects: (current: ProjectEntry | null, recent: ProjectEntry[]) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  fetchProjects: () => Promise<void>;
}

export const useProjectLibraryStore = create<ProjectLibraryStore>((set) => ({
  current: null,
  recent: [],
  error: null,
  loading: true,
  setProjects: (current, recent) => set({ current, recent, error: null, loading: false }),
  setError: (error) => set({ error, loading: false }),
  setLoading: (loading) => set({ loading }),
  fetchProjects: async () => {
    try {
      const response = await WorkspaceService.listProjects();
      set({ current: response.current, recent: response.recent, error: null, loading: false });
    } catch (failure: unknown) {
      set({
        error: failure instanceof Error ? failure.message : "Projects are unavailable.",
        loading: false,
      });
    }
  },
}));

if (typeof window !== "undefined") {
  (window as unknown as { __projectLibraryStore?: typeof useProjectLibraryStore }).__projectLibraryStore =
    useProjectLibraryStore;
}

export function useProjectLibrary(): ProjectLibrary {
  const current = useProjectLibraryStore((state) => state.current);
  const recent = useProjectLibraryStore((state) => state.recent);
  const error = useProjectLibraryStore((state) => state.error);
  const loading = useProjectLibraryStore((state) => state.loading);
  const fetchProjects = useProjectLibraryStore((state) => state.fetchProjects);
  const setProjects = useProjectLibraryStore((state) => state.setProjects);

  const workspacePath = useStudioStore((state) => state.workspacePath);
  const setWorkspacePath = useStudioStore((state) => state.setWorkspacePath);

  useEffect(() => {
    void fetchProjects();
  }, [workspacePath, fetchProjects]);

  const reload = useCallback(() => {
    void fetchProjects();
  }, [fetchProjects]);

  const openEntry = useCallback(
    async (entry: ProjectEntry) => {
      if (entry.kind === "video") {
        // `openVideoProjectAt` remembers the project itself, and reports its
        // own failures through the editor's toasts.
        await openVideoProjectAt(entry.path);
        reload();
        return;
      }
      try {
        const response = await WorkspaceService.openProject(entry.path);
        setWorkspacePath(response.current.path);
        setProjects(response.current, response.recent);
      } catch (failure: unknown) {
        useProjectLibraryStore.getState().setError(
          failure instanceof Error ? failure.message : "That project could not be opened.",
        );
      }
    },
    [reload, setProjects, setWorkspacePath],
  );

  // Compute effective current project: if workspacePath is set, it always aligns with it
  const effectiveCurrent: ProjectEntry | null =
    current && (!workspacePath || current.path === workspacePath)
      ? current
      : workspacePath
        ? recent.find((r) => r.path === workspacePath) || {
            path: workspacePath,
            name: workspaceLabel(workspacePath),
            kind: "code" as const,
          }
        : current;

  return {
    current: effectiveCurrent,
    recent,
    error,
    loading,
    reload,
    openEntry,
  };
}

