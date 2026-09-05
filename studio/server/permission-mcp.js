/**
 * The MCP server spec for the permission prompt tool.
 *
 * Mirrors `video-mcp.js`, and for the same reason: the CLI spawns MCP servers
 * itself, so the only way to hand one a secret is through the config file it
 * is named in. The file is written 0600 and rewritten on every spawn.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PERMISSION_SERVER_NAME = "teminali_permissions";
export const PERMISSION_TOOL = `mcp__${PERMISSION_SERVER_NAME}__approve`;

export function permissionShimPath() {
  return path.join(here, "..", "electron", "permissionMcpStdio.cjs");
}

export function permissionMcpServerSpec(runId, token, { execPath = process.execPath, port } = {}) {
  return {
    command: execPath,
    args: [permissionShimPath()],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      FRONTIER_GATEWAY_PORT: String(port ?? process.env.FRONTIER_GATEWAY_PORT ?? 4310),
      TEMINALI_PERMISSION_RUN: String(runId),
      TEMINALI_PERMISSION_TOKEN: String(token ?? ""),
    },
  };
}

/**
 * The flags that put the tool in front of the CLI's permission checks.
 *
 * `--allowedTools` pre-approves the prompt tool itself. Without it the first
 * thing needing approval would be the thing that asks for approval, and the
 * turn would deadlock on its own gate.
 */
export function permissionMcpArgs(runId, token, { execPath = process.execPath, tmpDir = os.tmpdir(), port } = {}) {
  if (!runId || !token) return { args: [] };
  const spec = permissionMcpServerSpec(runId, token, { execPath, port });
  const file = path.join(tmpDir, `teminali-code-mcp-permissions-${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { [PERMISSION_SERVER_NAME]: spec } }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    file,
    args: [
      "--mcp-config", file,
      "--allowedTools", `mcp__${PERMISSION_SERVER_NAME}`,
      "--permission-prompt-tool", PERMISSION_TOOL,
    ],
  };
}
