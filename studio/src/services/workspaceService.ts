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

export class WorkspaceService {
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
}
