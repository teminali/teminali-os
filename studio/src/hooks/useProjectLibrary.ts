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

import { useCallback, useEffect, useState } from "react";

import { WorkspaceService, type ProjectEntry } from "../services/workspaceService";
import { useStudioStore } from "../store/studioStore";
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

export function useProjectLibrary(): ProjectLibrary {
  const [current, setCurrent] = useState<ProjectEntry | null>(null);
  const [recent, setRecent] = useState<ProjectEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const workspacePath = useStudioStore((state) => state.workspacePath);
  const setWorkspacePath = useStudioStore((state) => state.setWorkspacePath);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    WorkspaceService.listProjects(controller.signal)
      .then((response) => {
        setCurrent(response.current);
        setRecent(response.recent);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        // A gateway that is down must not blank the surface — it says so and
        // the rest of the screen keeps working.
        setError(failure instanceof Error ? failure.message : "Projects are unavailable.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspacePath, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

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
        setCurrent(response.current);
        setRecent(response.recent);
        setError(null);
      } catch (failure: unknown) {
        setError(failure instanceof Error ? failure.message : "That project could not be opened.");
      }
    },
    [reload, setWorkspacePath],
  );

  return { current, recent, error, loading, reload, openEntry };
}
