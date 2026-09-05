/**
 * The screen, as an MCP server the agent CLI can be pointed at.
 *
 * The chat pane runs a real Claude Code process. It has a filesystem and a
 * shell, and until now that was all — so when the operator asked it to open a
 * site and help them log in, it answered honestly that it could open a URL and
 * nothing else, because it could. The screen assistant has hands; the chat pane
 * had none. This module is the introduction.
 *
 * Sibling of `video-mcp.js` and `permission-mcp.js`, and shaped like the
 * second: the CLI spawns MCP servers itself, so the only way to hand one a
 * secret is through the config file it is named in, written 0600 and rewritten
 * on every spawn.
 *
 * ## Three rules this file exists to keep
 *
 * **A tool never takes a coordinate.** `look` returns element ids from the
 * accessibility tree and every acting tool names one of them, exactly as a
 * `PlanStep` does. An MCP surface that accepted `{x, y}` would let a model's
 * guess at a position reach the operator's screen, and undo in one commit the
 * whole reason the tree is read at all.
 *
 * **The approval surface is the one that already exists.** Only `look` is
 * pre-approved. Everything that touches the machine is left out of
 * `--allowedTools`, so it falls to `--permission-prompt-tool` — the same prompt
 * in the same agent tab that already gates the CLI's shell commands, with the
 * same "always allow" for the rest of the run.
 *
 * **No grant, no server.** The tools are attached only when the operating
 * system has actually given this build Accessibility, and only for an engine
 * whose approvals we can bridge. An agent told it has hands it does not have
 * spends the turn discovering that instead of doing the work.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The server's name, and so the prefix on every tool the model sees:
 * `mcp__screen__click`. Short for the same reason `cut` is — it is repeated in
 * every definition, every call and every result.
 */
export const SCREEN_SERVER_NAME = "screen";

/** The one tool that only reads. Everything else is gated. */
export const SCREEN_READ_TOOL = `mcp__${SCREEN_SERVER_NAME}__look`;

export function screenShimPath() {
  return path
    .join(here, "..", "electron", "screenMcpStdio.cjs")
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

export function screenMcpServerSpec(runId, token, { execPath = process.execPath, port } = {}) {
  return {
    command: execPath,
    args: [screenShimPath()],
    env: {
      // Harmless under plain node, load-bearing when execPath is Electron's
      // own binary — which it is in a packaged build.
      ELECTRON_RUN_AS_NODE: "1",
      FRONTIER_GATEWAY_PORT: String(port ?? process.env.FRONTIER_GATEWAY_PORT ?? 4310),
      TEMINALI_SCREEN_RUN: String(runId),
      TEMINALI_SCREEN_TOKEN: String(token ?? ""),
    },
  };
}

/**
 * The extra CLI arguments that give the agent hands, or `[]`.
 *
 * `available` is the caller's answer to "has this machine actually granted
 * Accessibility" — an argument rather than a call, because this stays
 * synchronous alongside the other two arg builders and the permission check is
 * an await away in `assistant.js`.
 *
 * Codex gets nothing, deliberately. It has no `--permission-prompt-tool`
 * equivalent, so its screen calls would be settled by its sandbox flag with
 * nobody asked — and a gate that cannot ask must not grant. The day Codex can
 * be bridged, this is where it is added.
 */
export function screenMcpArgs(engine, runId, token, { execPath = process.execPath, tmpDir = os.tmpdir(), port, available = true } = {}) {
  if (engine !== "claude" || !runId || !token || !available) return { args: [] };

  const spec = screenMcpServerSpec(runId, token, { execPath, port });
  const file = path.join(tmpDir, `teminali-code-mcp-screen-${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { [SCREEN_SERVER_NAME]: spec } }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  /*
    Note what is NOT pre-approved: everything except `look`. Naming the server
    here — `mcp__screen`, the way the video panel is named — would allow every
    tool on it, and the operator would find their pointer moving with no prompt
    they could have refused. One tool is named instead, and the rest go through
    the gate the CLI already has.
  */
  return { file, args: ["--mcp-config", file, "--allowedTools", SCREEN_READ_TOOL] };
}
