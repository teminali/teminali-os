import { useEffect, useState } from "react";
import { GitHubService, type GitHubStatus } from "../services/modelService";

/**
 * Shared GitHub connection status.
 *
 * Several places in the shell need to know whether GitHub is connected — the
 * sidebar's getting-started card, the empty state's call to action, the
 * settings pane. Each of them mounting its own fetch would mean three requests
 * on load and three sources of truth that drift apart the moment one of them
 * connects. So the status lives in one module-level cache with subscribers, and
 * whoever changes it calls `refreshGitHubStatus` to push the new value to all
 * of them at once.
 */

type Listener = (status: GitHubStatus | null) => void;

let cached: GitHubStatus | null = null;
let inFlight: Promise<GitHubStatus | null> | null = null;
const listeners = new Set<Listener>();

function publish(status: GitHubStatus | null): void {
  cached = status;
  for (const listener of listeners) listener(status);
}

/** Re-read the connection. Call after connecting, disconnecting or cloning. */
export async function refreshGitHubStatus(): Promise<GitHubStatus | null> {
  // Coalesce concurrent callers: three components mounting together should
  // produce one request, not three.
  if (inFlight) return inFlight;
  inFlight = GitHubService.status()
    .then((status) => {
      publish(status);
      return status;
    })
    .catch(() => {
      // A gateway that is still starting is not "disconnected from GitHub" —
      // it is unknown, and the interface should not claim otherwise.
      publish(null);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useGitHubStatus(): { status: GitHubStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<GitHubStatus | null>(cached);

  useEffect(() => {
    listeners.add(setStatus);
    if (cached === null && !inFlight) void refreshGitHubStatus();
    return () => {
      listeners.delete(setStatus);
    };
  }, []);

  return { status, refresh: () => void refreshGitHubStatus() };
}
