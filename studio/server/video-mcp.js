/**
 * The video panel, as an MCP server the agent CLIs can be pointed at.
 *
 * The Claude Code and Codex CLIs are real processes in the real workspace, so
 * unlike the local Frontier engine they cannot reach the editor's stores by
 * calling a function — those stores are in Electron's renderer. This module is
 * what tells them how to get there: it finds the running bridge, and renders
 * the one server spec into each CLI's own configuration dialect.
 *
 * Nothing here fails loudly. An operator with no video panel open, or a build
 * with no Electron at all, gets `null` and their agent is spawned exactly as it
 * was before — the tools are an addition to a coding agent, never a dependency
 * of one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The MCP server's name, and so the prefix on every tool the model sees:
 * `mcp__cut__patch_clip`. Short on purpose — it is repeated in every tool
 * definition, every call and every result, and the panel's own name for itself
 * is the Cut.
 */
export const MCP_SERVER_NAME = "cut";

const DEFAULT_PORT = 3899;

/** Must agree with electron/videoRpc.cjs, which writes this file. */
function endpointFile(port) {
  const name = port === DEFAULT_PORT ? "video-bridge.json" : `video-bridge-${port}.json`;
  return path.join(os.tmpdir(), `teminali-code-${name}`);
}

/**
 * Where the shim lives.
 *
 * It has to be a real file on disk, because it is spawned as its own process.
 * Inside a packaged app this path lands in app.asar, which nothing can spawn
 * from, so it is rewritten to the unpacked copy — electron-builder is told to
 * unpack exactly this one file.
 */
export function shimPath() {
  return path
    .join(here, "..", "electron", "videoMcpStdio.cjs")
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/**
 * The running bridge, or null.
 *
 * The environment is checked first because in a packaged build the gateway runs
 * inside Electron main, which sets it — no file read at all. Development is the
 * case the file exists for: there the gateway is a separate process and has no
 * other way to learn a token minted in main's memory.
 *
 * A file whose process is gone is treated as absent. It is left on disk rather
 * than cleaned up here: this is the *reader*, and a reader that deletes what it
 * does not like will one day delete a live instance's endpoint because a pid
 * check went wrong.
 */
export function videoBridgeEndpoint(env = process.env) {
  const envPort = Number(env.TEMINALI_VIDEO_RPC_PORT);
  const port = Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_PORT;

  if (env.TEMINALI_VIDEO_RPC_TOKEN) return { port, token: env.TEMINALI_VIDEO_RPC_TOKEN };

  try {
    const data = JSON.parse(fs.readFileSync(endpointFile(port), "utf8"));
    if (!data || typeof data.token !== "string" || !data.token) return null;
    if (Number.isInteger(data.pid)) {
      try {
        process.kill(data.pid, 0);
      } catch {
        return null; // the app that wrote this is gone
      }
    }
    return { port: Number(data.port) || port, token: data.token };
  } catch {
    return null;
  }
}

/** The one server spec, in a form each CLI can render its own way. */
export function videoMcpServerSpec(endpoint, execPath = process.execPath) {
  return {
    command: execPath,
    args: [shimPath()],
    env: {
      // Harmless under plain node, load-bearing when execPath is Electron's
      // own binary — which it is in a packaged build, where the gateway runs
      // inside the main process and there is no separate node to spawn.
      ELECTRON_RUN_AS_NODE: "1",
      TEMINALI_VIDEO_RPC_PORT: String(endpoint.port),
      TEMINALI_VIDEO_RPC_TOKEN: endpoint.token,
    },
  };
}

/** `mcp_servers.cut={...}` as inline TOML, for a Codex `-c` override. */
export function codexMcpOverride(spec, name = MCP_SERVER_NAME) {
  const esc = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const args = spec.args.map((a) => `"${esc(a)}"`).join(", ");
  const env = Object.entries(spec.env).map(([k, v]) => `${k}="${esc(v)}"`).join(", ");
  return `mcp_servers.${name}={command="${esc(spec.command)}", args=[${args}], env={${env}}}`;
}

function writeConfig(file, value) {
  // 0600: the file carries the bridge token, and the temp directory is shared
  // between users on Linux.
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  return file;
}

/**
 * The extra CLI arguments that attach the panel, or `[]` when there is no
 * bridge to attach.
 *
 * Codex takes its server as a config override; Claude takes a file. Note what
 * is NOT here: `--strict-mcp-config`. The Cut passes it because its agent
 * exists to edit video and the operator's own MCP servers are noise. Here the
 * `claude` being spawned is the operator's general coding agent, and silently
 * dropping the servers they configured themselves would be a regression they
 * would have no way to explain.
 */
export function videoMcpArgs(engine, { env = process.env, execPath = process.execPath, tmpDir = os.tmpdir() } = {}) {
  const endpoint = videoBridgeEndpoint(env);
  if (!endpoint) return [];

  const spec = videoMcpServerSpec(endpoint, execPath);

  if (engine === "codex") return ["-c", codexMcpOverride(spec)];

  if (engine === "claude") {
    /*
      `tmpDir` is an argument only so the tests can write somewhere else. They
      used to write here, and since the path is fixed they overwrote the config
      of the app running on the same machine — with `/usr/bin/node` as the
      command, which does not exist on a Homebrew Mac. Harmless in production,
      where the gateway rewrites this file on every spawn, and thoroughly
      confusing once during verification.
    */
    const file = writeConfig(
      path.join(tmpDir, `teminali-code-mcp-${MCP_SERVER_NAME}.json`),
      { mcpServers: { [MCP_SERVER_NAME]: spec } }
    );
    /*
      `--allowedTools` names the server, so all of its tools are pre-approved.
      Headless `claude -p` has no TTY to approve anything on, so without this
      the first tool call is refused and the turn ends having done nothing. The
      flag ADDS to the permission list rather than replacing it, so the rest of
      the operator's own permissions are untouched.
    */
    return ["--mcp-config", file, "--allowedTools", `mcp__${MCP_SERVER_NAME}`];
  }

  return [];
}
