/**
 * The workspace UI, as an MCP server the agent CLI can be pointed at.
 *
 * The agent already has a filesystem — it is a real process in the real
 * project. What it did not have was any way to reach the *application* around
 * that filesystem. It could edit `studio/src/App.tsx` and the operator's file
 * tree would sit there showing the folder it was showing before; asked to work
 * on another project, it could only describe the folder and wait to be shown
 * it. Every one of `WorkspaceService.openProject`'s callers was a human click.
 *
 * Sibling of `screen-mcp.js`, and deliberately the same shape: a config file
 * written 0600 per spawn, the run's own token, and `--allowedTools` naming
 * *individual* tools rather than the server.
 *
 * ## Which tools are pre-approved, and why that line is where it is
 *
 * The line is between showing and changing, not between quiet and loud.
 *
 * `reveal` opens folders in a tree the operator is already looking at, at a
 * path the gateway has already refused to let escape the workspace. It shows;
 * it does not change anything. It is pre-approved.
 *
 * `open_file` was added to the same side of that line, deliberately. It opens
 * an editor tab on a file the operator could open with one click, read back
 * through the same route that click uses, under the same size and format
 * limits; it writes nothing, and `openFile` leaves a tab with unsaved changes
 * alone. It is louder than `reveal` — it changes which tab is in front of them
 * — but loud and destructive are different things, and a confirmation dialog
 * in front of every file the agent wants to show would make the tool not worth
 * calling. That is what the model was working around when it drove the
 * application's own UI with the pointer instead.
 *
 * `open_project` rebinds `config.workspaceRoot`, which is what bounds every
 * workspace route, the search and every terminal. That is a change of ground
 * under the operator's feet and it goes through the CLI's permission prompt —
 * the same dialog in the same agent tab that gates a shell command.
 *
 * Codex gets nothing, for the same reason it gets no screen: it has no
 * `--permission-prompt-tool`, so `open_project` would be settled by its sandbox
 * flag with nobody asked, and a gate that cannot ask must not grant.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The server's name, and so the prefix on every tool the model sees:
 * `mcp__teminali-workspace__reveal`.
 *
 * It is **not** `workspace`, and must not be. Claude Code reserves that name:
 * a server declared as `workspace` in `--mcp-config` is dropped before it is
 * ever spawned — no warning on stderr, no entry in the CLI's own
 * `mcp_servers` list, nothing for the operator to see. The agent simply comes
 * up without a single one of these tools and, asked to switch projects, says
 * it cannot and offers to click the sidebar with the pointer instead. Every
 * other name this app uses (`screen`, `permissions`, `cut`) loads normally;
 * this one was a collision, and the brand prefix is what keeps it from
 * happening again. Measured against CLI 2.1.263 by declaring the identical
 * server under both names.
 */
export const WORKSPACE_SERVER_NAME = "teminali-workspace";

/**
 * The tools that only show or read. `open_project` is deliberately absent, and
 * so is `bookmark`: it writes a row the operator will see on their home page,
 * which is small, but it is a change and not a showing, and the line is the
 * line. `browse` is on this side for the same reason `open_file` is — it puts
 * a page in front of them that they could have opened with one click, and a
 * prompt before every page would make the tool not worth calling.
 */
export const WORKSPACE_READ_TOOLS = Object.freeze([
  `mcp__${WORKSPACE_SERVER_NAME}__reveal`,
  `mcp__${WORKSPACE_SERVER_NAME}__open_file`,
  `mcp__${WORKSPACE_SERVER_NAME}__browse`,
  `mcp__${WORKSPACE_SERVER_NAME}__bookmarks`,
  `mcp__${WORKSPACE_SERVER_NAME}__browsing_history`,
  `mcp__${WORKSPACE_SERVER_NAME}__downloads`,
]);

/**
 * The first of them, kept as a name because the tests and the design docs
 * quote it. Prefer `WORKSPACE_READ_TOOLS` for anything that has to enumerate.
 */
export const WORKSPACE_READ_TOOL = WORKSPACE_READ_TOOLS[0];

export function workspaceShimPath() {
  return path
    .join(here, "..", "electron", "workspaceMcpStdio.cjs")
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

export function workspaceMcpServerSpec(runId, token, { execPath = process.execPath, port } = {}) {
  return {
    command: execPath,
    args: [workspaceShimPath()],
    env: {
      // Harmless under plain node, load-bearing when execPath is Electron's
      // own binary — which it is in a packaged build.
      ELECTRON_RUN_AS_NODE: "1",
      FRONTIER_GATEWAY_PORT: String(port ?? process.env.FRONTIER_GATEWAY_PORT ?? 4310),
      TEMINALI_WORKSPACE_RUN: String(runId),
      TEMINALI_WORKSPACE_TOKEN: String(token ?? ""),
    },
  };
}

/**
 * The extra CLI arguments that let the agent drive the workspace UI, or `[]`.
 *
 * Rides the approval bridge's token exactly as the screen does: the token that
 * answers this run's prompts is the token that moves this run's file tree, so
 * the two share one lifetime and `closeRun` takes both away at once.
 */
export function workspaceMcpArgs(engine, runId, token, { execPath = process.execPath, tmpDir = os.tmpdir(), port } = {}) {
  if (engine !== "claude" || !runId || !token) return { args: [] };

  const spec = workspaceMcpServerSpec(runId, token, { execPath, port });
  const file = path.join(tmpDir, `teminali-os-mcp-workspace-${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { [WORKSPACE_SERVER_NAME]: spec } }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  /*
    Comma-separated in one value rather than two words after the flag. The CLI
    accepts both, but this list sits in the middle of an argv that goes on to
    carry the briefing and the prompt, and a variadic flag next to a positional
    is a footgun waiting for whoever adds the next argument.
  */
  return { file, args: ["--mcp-config", file, "--allowedTools", WORKSPACE_READ_TOOLS.join(",")] };
}
