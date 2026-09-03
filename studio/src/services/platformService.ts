import { GatewayClient } from "./gatewayClient";

/**
 * Who you are, and whether the studio is up to date.
 *
 * Both answers come from the gateway rather than the renderer: identity is a
 * GitHub lookup and the update check shells out to `gh`, and neither belongs in
 * a browser context. The admin flag returned here decides what the interface
 * offers, but it never decides what the server allows — the privileged routes
 * re-check it themselves.
 */

export interface Identity {
  connected: boolean;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  admins: string[];
  lockedAdmins: string[];
  /** True only while the studio has no administrator at all. */
  canClaim: boolean;
  reason: string | null;
}

export interface UpdateStatus {
  version: string | null;
  latest: {
    tag: string;
    name: string;
    publishedAt: string | null;
    url: string | null;
    prerelease: boolean;
    notes: string;
  } | null;
  /** The file this machine should take. Null when the release has none for it. */
  asset: { name: string; size: number | null; url: string } | null;
  updateAvailable: boolean;
  checkedAt: string;
  /** Set when the check could not run — distinct from "up to date". */
  error: string | null;
}

/** One published release, as the version control in the corner sees it. */
export interface ReleaseOption {
  tag: string;
  /** The tag without its `v`, which is how a version is written in the UI. */
  version: string;
  name: string;
  publishedAt: string | null;
  url: string | null;
  prerelease: boolean;
  /** Null when that release shipped nothing this machine can install. */
  asset: { name: string; size: number | null; url: string } | null;
  /** True for the build that is running. */
  current: boolean;
  /** True for a build older than the running one — a rollback candidate. */
  older: boolean;
}

export interface ReleaseList {
  version: string | null;
  releases: ReleaseOption[];
  checkedAt: string;
  error: string | null;
}

export type UpdateDownloadEvent =
  | { type: "progress"; received: number; total: number | null }
  | { type: "done"; path: string; bytes: number }
  | { type: "error"; code: string; message: string };

export type ReleaseEvent =
  | { type: "step"; id: string; label: string; status: "running" | "passed" | "failed"; durationMs?: number; detail?: string | null }
  | { type: "output"; id: string; kind: "stdout" | "stderr"; text: string }
  | { type: "error"; code: string; message: string }
  | { type: "done"; ok: boolean; version: string; dryRun: boolean; notes: string }
  | { type: "finished"; ok: boolean; durationMs: number; completed: { id: string; ok: boolean; durationMs: number }[] };

export class PlatformService {
  public static async me(signal?: AbortSignal): Promise<Identity | null> {
    try {
      const response = await GatewayClient.request("/api/me", { method: "GET", signal });
      if (!response.ok) return null;
      return (await response.json()) as Identity;
    } catch {
      return null;
    }
  }

  /** Only possible while no administrator exists; the route enforces that. */
  public static async claimAdmin(): Promise<Identity> {
    const response = await GatewayClient.request("/api/admin/claim", { method: "POST" });
    await GatewayClient.expectOk(response);
    return (await response.json()) as Identity;
  }

  public static async setAdmins(admins: string[]): Promise<Identity> {
    const response = await GatewayClient.request("/api/admin/admins", {
      method: "POST",
      body: JSON.stringify({ admins }),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as Identity;
  }

  public static async checkForUpdate(signal?: AbortSignal): Promise<UpdateStatus | null> {
    try {
      const response = await GatewayClient.request("/api/updates/check", { method: "GET", signal });
      if (!response.ok) return null;
      return (await response.json()) as UpdateStatus;
    } catch {
      return null;
    }
  }

  /**
   * Every release this machine could install, newest first.
   *
   * Read on demand rather than polled: it is a round trip to GitHub for a menu
   * most sessions never open, and the answer only matters once somebody is
   * looking at it.
   */
  public static async listReleases(signal?: AbortSignal): Promise<ReleaseList | null> {
    try {
      const response = await GatewayClient.request("/api/updates/releases", { method: "GET", signal });
      if (!response.ok) return null;
      return (await response.json()) as ReleaseList;
    } catch {
      return null;
    }
  }

  /**
   * Downloads the installer for this machine, reporting progress.
   *
   * Progress is not decoration here: the asset is well over a hundred
   * megabytes, and a control that looks inert for two minutes is one people
   * press a second time.
   */
  public static async downloadUpdate(
    asset: { url: string; name: string },
    onEvent: (event: UpdateDownloadEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await GatewayClient.request("/api/updates/download", {
      method: "POST",
      signal,
      body: JSON.stringify(asset),
    });
    await GatewayClient.expectOk(response);
    if (!response.body) throw new Error("The gateway returned no download stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        onEvent(JSON.parse(line) as UpdateDownloadEvent);
      } catch {
        /* A malformed line is not worth failing a download over. */
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    consume(buffer);
  }

  /**
   * Cuts a release, streaming each step.
   *
   * `dryRun` defaults to true on the server as well: publishing to GitHub is
   * the kind of thing that should require saying so, not merely forgetting to
   * say otherwise.
   */
  public static async publishRelease(
    request: { version: string; notes?: string; dryRun?: boolean },
    onEvent: (event: ReleaseEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await GatewayClient.request("/api/updates/publish", {
      method: "POST",
      signal,
      body: JSON.stringify(request),
    });
    await GatewayClient.expectOk(response);
    if (!response.body) throw new Error("The gateway returned no release stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        onEvent(JSON.parse(line) as ReleaseEvent);
      } catch {
        /* A partial line at the tail; the next read completes it. */
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) consume(buffer);
  }
}
