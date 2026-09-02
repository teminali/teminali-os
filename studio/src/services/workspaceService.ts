import { GatewayClient } from "./gatewayClient";
import type { FileItem } from "../types";

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

export interface ProjectEntry {
  path: string;
  name: string;
  openedAt?: string;
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
   * Searches the workspace on disk.
   *
   * The gateway walks the real tree; this is not a scan of whatever happens to
   * be open in the editor. That distinction is the whole point — a search that
   * quietly excludes unopened files answers "no matches" for strings that are
   * plainly there on disk.
   */
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
