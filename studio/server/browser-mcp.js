/**
 * The browser panel, as an MCP server the agent CLI can be pointed at.
 *
 * Sibling of `workspace-mcp.js` and `camera-mcp.js`, and shaped the same way:
 * a config file written 0600 per spawn, the run's own token, and
 * `--allowedTools` naming *individual* tools rather than the server.
 *
 * ## Why this is not part of the workspace server
 *
 * The workspace server already has `browse`, and it is the right place for it:
 * `browse` puts a page in front of the operator the way `open_file` puts a
 * file there, and nothing comes back. These are the other half — read the
 * page, click it, type into it — and every one is a question with an answer,
 * which is a different transport (see `requestBrowserAction` in
 * permission-bridge.js, not `emitToRun`) and a different gate.
 *
 * It is also a different *tool budget*. The workspace server is eleven tools
 * an agent should be aware of on every turn; these seven only matter once
 * there is a page open, and folding them in would make the browsing tools a
 * third of everything the model reads before it starts.
 *
 * ## Which tools are pre-approved, and why that line is where it is
 *
 * The same line the workspace draws — between showing and changing — falls in
 * a different place here, because a web page is not the operator's own
 * workspace.
 *
 * `page_snapshot`, `page_read` and `page_screenshot` read a page the operator
 * already has open, in a panel they are looking at. They change nothing on it
 * and send no request anywhere. They are pre-approved, for the same reason
 * `browse` is: a prompt before every read would make reading not worth doing,
 * and what the model was doing instead was screenshotting the whole desktop.
 *
 * `page_click` and `page_type` act on somebody else's site as the operator,
 * signed into their session. A click can buy something, send something or
 * delete something, and no allowlist of ours can tell which — so both go
 * through the CLI's permission dialog, the same one that gates a shell
 * command.
 *
 * `page_network` is a read, and it is still not pre-approved: the addresses a
 * page fetches carry query strings, and query strings carry identifiers,
 * tokens and search terms. It is the operator's browsing, and they get to be
 * asked.
 *
 * `page_eval` runs the agent's own JavaScript in someone else's document, in
 * the page's own world, with the operator's cookies. It **must never** be
 * pre-approved. Anything that pre-approves it has pre-approved every other
 * tool here at once, since all of them can be written as an expression.
 *
 * Codex gets nothing, for the same reason it gets no screen, no workspace and
 * no camera: it has no `--permission-prompt-tool`, so `page_eval` would be
 * settled by its sandbox flag with nobody asked, and a gate that cannot ask
 * must not grant.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The server's name, and so the prefix on every tool the model sees:
 * `mcp__teminali-browser__page_snapshot`.
 *
 * Brand-prefixed deliberately, and `browser` on its own would have been a
 * particularly bad bet: `workspace` shipped as a bare name and was silently
 * discarded by the CLI, which reserves it — nine tools dark for as long as
 * they existed, with nothing on stderr to say so. See `WORKSPACE_SERVER_NAME`
 * for what that cost. The prefix is what stops this one being the next.
 */
export const BROWSER_SERVER_NAME = "teminali-browser";

/**
 * The tools that only read the page in front of the operator.
 *
 * `page_network`, `page_click`, `page_type` and `page_eval` are deliberately
 * absent — see the header. `page_eval` is the one whose absence is
 * load-bearing: it is a general-purpose way to do everything else on this
 * list and everything not on it.
 */
export const BROWSER_READ_TOOLS = Object.freeze([
  `mcp__${BROWSER_SERVER_NAME}__page_snapshot`,
  `mcp__${BROWSER_SERVER_NAME}__page_read`,
  `mcp__${BROWSER_SERVER_NAME}__page_screenshot`,
]);

/** The tool that must never join the list above, named so a test can say so. */
export const BROWSER_EVAL_TOOL = `mcp__${BROWSER_SERVER_NAME}__page_eval`;

export function browserShimPath() {
  return path
    .join(here, "..", "electron", "browserMcpStdio.cjs")
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

export function browserMcpServerSpec(runId, token, { execPath = process.execPath, port } = {}) {
  return {
    command: execPath,
    args: [browserShimPath()],
    env: {
      // Harmless under plain node, load-bearing when execPath is Electron's
      // own binary — which it is in a packaged build.
      ELECTRON_RUN_AS_NODE: "1",
      FRONTIER_GATEWAY_PORT: String(port ?? process.env.FRONTIER_GATEWAY_PORT ?? 4310),
      TEMINALI_BROWSER_RUN: String(runId),
      TEMINALI_BROWSER_TOKEN: String(token ?? ""),
    },
  };
}

/**
 * The extra CLI arguments that let the agent read and drive the browser panel,
 * or `[]`.
 *
 * Rides the approval bridge's token exactly as the screen, the workspace and
 * the camera do: the token that answers this run's prompts is the token that
 * reads this run's pages, so the two share one lifetime and `closeRun` takes
 * both away at once.
 *
 * No `available` flag and no capability check, for the camera's reason: whether
 * a page is open is answered where it can actually be answered — in the window,
 * when the tool is called — and a probe here could only guess.
 */
export function browserMcpArgs(engine, runId, token, { execPath = process.execPath, tmpDir = os.tmpdir(), port } = {}) {
  if (engine !== "claude" || !runId || !token) return { args: [] };

  const spec = browserMcpServerSpec(runId, token, { execPath, port });
  const file = path.join(tmpDir, `teminali-os-mcp-browser-${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { [BROWSER_SERVER_NAME]: spec } }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  return { file, args: ["--mcp-config", file, "--allowedTools", BROWSER_READ_TOOLS.join(",")] };
}
