/**
 * The camera, as an MCP server the agent CLI can be pointed at.
 *
 * Sibling of `screen-mcp.js` and `workspace-mcp.js`, and shaped the same way:
 * a config file written 0600 per spawn, the run's own token, and
 * `--allowedTools` naming individual tools rather than the server.
 *
 * ## Why this is not part of the screen server
 *
 * They answer the same-sounding question and are nothing alike. Asked *"can
 * you see me?"* the assistant looked at the screen and correctly explained
 * that it has no camera — which was true, and not what was wanted. The screen
 * is already in front of both of them; a camera is a room, and a person in it.
 *
 * They also have different gates. The screen tools attach only when
 * Accessibility is granted, because without it there is no element inventory
 * and every acting tool would fail on its first call. A camera has nothing to
 * do with Accessibility, and a machine with no screen grant still has a
 * webcam. Folding the camera into the screen server would have made the two
 * grants one, and taken the camera away from anyone who had not given the
 * other.
 *
 * ## Nothing here is pre-approved
 *
 * `WORKSPACE_READ_TOOLS` exists because showing a folder in a tree the
 * operator is already looking at changes nothing. This is the other case
 * entirely: `look_at_me` turns on a piece of hardware that is pointed at a
 * person, and sends what it sees to a model. There is no reading of it that
 * makes it a showing, so the export below is empty and the tool falls to the
 * CLI's own `--permission-prompt-tool` dialog — the same one that gates a
 * shell command, in the same pane, answerable by voice.
 *
 * "Always allow" is the operator's to give and lasts the run, which is what
 * makes a conversation with a camera in it bearable without making the first
 * frame free.
 *
 * Codex gets nothing, for the same reason it gets no screen and no workspace:
 * it has no `--permission-prompt-tool`, so this would be settled by its
 * sandbox flag with nobody asked, and a gate that cannot ask must not grant.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The server's name, and so the prefix on every tool the model sees:
 * `mcp__teminali-camera__look_at_me`.
 *
 * Brand-prefixed deliberately. `workspace` shipped as a bare name and was
 * silently discarded by the CLI, which reserves it — see
 * `WORKSPACE_SERVER_NAME` for what that cost. `camera` is not reserved today;
 * the prefix is what stops this one being the next to find out.
 */
export const CAMERA_SERVER_NAME = "teminali-camera";

/** The tool, named as the model sees it. */
export const CAMERA_TOOL = `mcp__${CAMERA_SERVER_NAME}__look_at_me`;

/**
 * Nothing on this server is pre-approved. Exported as an empty list rather
 * than left implicit, so a later reader has to delete a line that says why.
 */
export const CAMERA_READ_TOOLS = Object.freeze([]);

export function cameraShimPath() {
  return path
    .join(here, "..", "electron", "cameraMcpStdio.cjs")
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

export function cameraMcpServerSpec(runId, token, { execPath = process.execPath, port } = {}) {
  return {
    command: execPath,
    args: [cameraShimPath()],
    env: {
      // Harmless under plain node, load-bearing when execPath is Electron's
      // own binary — which it is in a packaged build.
      ELECTRON_RUN_AS_NODE: "1",
      FRONTIER_GATEWAY_PORT: String(port ?? process.env.FRONTIER_GATEWAY_PORT ?? 4310),
      TEMINALI_CAMERA_RUN: String(runId),
      TEMINALI_CAMERA_TOKEN: String(token ?? ""),
    },
  };
}

/**
 * The extra CLI arguments that let the agent look through the camera, or `[]`.
 *
 * Rides the approval bridge's token exactly as the screen and the workspace
 * do: the token that answers this run's prompts is the token that opens this
 * run's camera, so the two share one lifetime and `closeRun` takes both away
 * at once.
 *
 * No `--allowedTools`. The flag pre-approves, and there is nothing here to
 * pre-approve; passing an empty list would be a claim about a decision that
 * has not been made.
 */
export function cameraMcpArgs(engine, runId, token, { execPath = process.execPath, tmpDir = os.tmpdir(), port } = {}) {
  if (engine !== "claude" || !runId || !token) return { args: [] };

  const spec = cameraMcpServerSpec(runId, token, { execPath, port });
  const file = path.join(tmpDir, `teminali-code-mcp-camera-${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { [CAMERA_SERVER_NAME]: spec } }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  return { file, args: ["--mcp-config", file] };
}
