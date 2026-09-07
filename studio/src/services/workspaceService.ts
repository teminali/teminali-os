import { GatewayClient } from "./gatewayClient.ts";
import type { FileItem } from "../types";

/** One file or folder found outside the workspace. */
export interface MachineSearchResult {
  path: string;
  name: string;
  directory: boolean;
}

export interface MachineSearchResponse {
  /** False where the platform has no index to ask; `reason` says why. */
  available: boolean;
  reason: string | null;
  results: MachineSearchResult[];
}

export interface WorkspaceTreeResponse {
  rootName: string;
  files: FileItem[];
  truncated: boolean;
  entryCount: number;
}

export interface WorkspaceFileResponse {
  path: string;
  name: string;
  content: string;
  encoding: "utf8" | "base64";
  mimeType: string;
  size: number;
  modified: string;
}

export type ProjectKind = "code" | "video";

export interface ProjectEntry {
  path: string;
  name: string;
  openedAt?: string;
  /**
   * Classified by the gateway from the marker file on disk, not stored by the
   * client. A directory is `"video"` when it holds a `project.json` carrying
   * `teminali-video-project`; everything else is `"code"`.
   */
  kind?: ProjectKind;
}

export interface ProjectsResponse {
  current: ProjectEntry;
  recent: ProjectEntry[];
}

export class WorkspaceService {
  /** Current project root plus the recently opened list. */
  static async listProjects(signal?: AbortSignal): Promise<ProjectsResponse> {
    const response = await GatewayClient.request("/api/workspace/projects", { method: "GET", signal });
    await GatewayClient.expectOk(response);
    return (await response.json()) as ProjectsResponse;
  }

  /** Switches the workspace root every workspace and terminal route is bound to. */
  static async openProject(path: string, signal?: AbortSignal): Promise<ProjectsResponse> {
    const response = await GatewayClient.request("/api/workspace/open", {
      method: "POST",
      signal,
      body: JSON.stringify({ path }),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as ProjectsResponse;
  }

  /**
   * Records a project as recently opened WITHOUT rebinding the workspace root.
   *
   * The route a video project uses. `openProject` switches the root every
   * workspace and terminal route is bounded to, which is right for a code
   * project and wrong for a timeline — opening one must not repoint the file
   * tree and the terminals at the folder that holds it.
   */
  static async rememberProject(path: string, signal?: AbortSignal): Promise<{ recent: ProjectEntry[] }> {
    const response = await GatewayClient.request("/api/workspace/projects/remember", {
      method: "POST",
      signal,
      body: JSON.stringify({ path }),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as { recent: ProjectEntry[] };
  }

  static async forgetProject(path: string, signal?: AbortSignal): Promise<{ recent: ProjectEntry[] }> {
    const response = await GatewayClient.request("/api/workspace/projects/forget", {
      method: "POST",
      signal,
      body: JSON.stringify({ path }),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as { recent: ProjectEntry[] };
  }

  static async listFiles(signal?: AbortSignal): Promise<WorkspaceTreeResponse> {
    const response = await GatewayClient.request("/api/workspace/tree", { method: "GET", signal });
    await GatewayClient.expectOk(response);
    return (await response.json()) as WorkspaceTreeResponse;
  }

  static async readFile(path: string, signal?: AbortSignal): Promise<WorkspaceFileResponse> {
    const response = await GatewayClient.request("/api/workspace/file", {
      method: "POST",
      signal,
      body: JSON.stringify({ path }),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as WorkspaceFileResponse;
  }

  static async writeFile(path: string, content: string, expectedModified?: string | null, signal?: AbortSignal): Promise<WorkspaceFileResponse> {
    const response = await GatewayClient.request("/api/workspace/write", {
      method: "POST",
      signal,
      body: JSON.stringify({ path, content, ...(expectedModified !== undefined ? { expectedModified } : {}) }),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as WorkspaceFileResponse;
  }

  /**
   * Removes a file. The only caller is rejecting a proposed change to a file
   * the assistant created — see `store/changeStore.ts`.
   */
  static async deleteFile(path: string, signal?: AbortSignal): Promise<{ path: string; deleted: boolean }> {
    const response = await GatewayClient.request("/api/workspace/delete", {
      method: "POST",
      signal,
      body: JSON.stringify({ path }),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as { path: string; deleted: boolean };
  }

  static async createDirectory(path: string, signal?: AbortSignal): Promise<{ path: string }> {
    const response = await GatewayClient.request("/api/workspace/mkdir", {
      method: "POST",
      signal,
      body: JSON.stringify({ path }),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as { path: string };
  }

  /**
   * Searches the workspace on disk.
   *
   * The gateway walks the real tree; this is not a scan of whatever happens to
   * be open in the editor. That distinction is the whole point — a search that
   * quietly excludes unopened files answers "no matches" for strings that are
   * plainly there on disk.
   */
  /**
   * Files and folders on the machine, outside the workspace.
   *
   * A different question from `search`, with a different answer: that one walks
   * the project on disk, this one asks Spotlight, which is why it is macOS
   * only and says so in `available` rather than failing. It returns paths and
   * names — never contents — and opening one still goes through the workspace
   * boundary. See server/machine-search.js.
   */
  static async searchMachine(query: string, signal?: AbortSignal): Promise<MachineSearchResponse> {
    const response = await GatewayClient.request(
      `/api/workspace/machine-search?q=${encodeURIComponent(query)}`,
      { method: "GET", signal },
    );
    await GatewayClient.expectOk(response);
    return (await response.json()) as MachineSearchResponse;
  }

  static async search(query: string, options: WorkspaceSearchOptions = {}): Promise<WorkspaceSearchResponse> {
    const { signal, ...flags } = options;
    const response = await GatewayClient.request("/api/workspace/search", {
      method: "POST",
      signal,
      body: JSON.stringify({ query, ...flags }),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as WorkspaceSearchResponse;
  }
}

/** One hit inside a file. Line and column are 1-based, as an editor counts. */
export interface WorkspaceSearchMatch {
  line: number;
  column: number;
  text: string;
  match: string;
}

export interface WorkspaceSearchFile {
  path: string;
  name: string;
  matches: WorkspaceSearchMatch[];
}

export interface WorkspaceSearchResponse {
  query: string;
  files: WorkspaceSearchFile[];
  totalMatches: number;
  filesScanned: number;
  /** True when a bound was hit — the result set is real but incomplete. */
  truncated: boolean;
}

export interface WorkspaceSearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  signal?: AbortSignal;
}
