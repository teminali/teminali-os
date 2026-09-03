/* ─────────────────────────────────────────────────────────────────────────────
   MCP stdio shim.

   An MCP client — the Claude Code CLI, the Codex CLI, anything else — speaks
   newline-delimited JSON-RPC to this over stdio. It owns no state of its own:
   every tool call is forwarded to the running Teminali Code window through the
   local RPC bridge, so edits land in the timeline actually on screen instead of
   in a fresh store this process would otherwise have to itself.

   Runs under Electron's bundled Node via ELECTRON_RUN_AS_NODE=1, or under plain
   node — either way there is no dependency on the operator having installed
   Node separately.

   Ported from teminaliCut/electron/mcpStdio.ts. Note which file that is: the
   Cut ALSO has src/mcp/cli.ts, an earlier stdio server that imported the tool
   registry directly and therefore edited an empty project in its own process.
   That is the mistake this shim exists to not make.
   ───────────────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_PORT = 3899;

function endpointFile(port) {
  const name = port === DEFAULT_PORT ? "video-bridge.json" : `video-bridge-${port}.json`;
  return path.join(os.tmpdir(), `teminali-code-${name}`);
}

/**
 * Find the bridge.
 *
 * The environment wins, because the gateway that spawned us usually knows. The
 * file is the fallback for a shim started by hand, or by a client the operator
 * configured themselves — the whole point of speaking MCP is that we are not
 * the only possible caller.
 */
function resolveEndpoint() {
  const envPort = Number(process.env.TEMINALI_VIDEO_RPC_PORT);
  const port = Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_PORT;
  if (process.env.TEMINALI_VIDEO_RPC_TOKEN) {
    return { port, token: process.env.TEMINALI_VIDEO_RPC_TOKEN };
  }
  try {
    const data = JSON.parse(fs.readFileSync(endpointFile(port), "utf8"));
    if (data && typeof data.token === "string") {
      return { port: Number(data.port) || port, token: data.token };
    }
  } catch {
    /* not running, or never wrote one */
  }
  return { port, token: "" };
}

const endpoint = resolveEndpoint();

const SERVER_INFO = { name: "cut", version: "1.0.0" };

function respond(body) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...body })}\n`);
}

async function rpc(method, params) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-teminali-token": endpoint.token },
    body: JSON.stringify({ method, params }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.error || `The video bridge returned ${response.status}`);
  }
  return data.result;
}

async function handle(request) {
  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize":
        respond({
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          },
        });
        return;

      case "notifications/initialized":
        return; // a notification — no reply

      case "tools/list": {
        let tools = [];
        try {
          tools = (await rpc("tools/list")) || [];
        } catch {
          /*
            An empty list, not an error. A client that fails to initialise its
            MCP servers usually aborts the whole session, and "the video panel
            is not open" must not be able to stop the operator's coding agent
            from starting.
          */
          tools = [];
        }
        respond({ id, result: { tools } });
        return;
      }

      case "tools/call": {
        const result = await rpc("tools/call", {
          name: params?.name,
          arguments: params?.arguments ?? {},
        });
        respond({
          id,
          result: {
            content: [
              {
                type: "text",
                text: result?.success
                  ? JSON.stringify(result.data ?? { ok: true }, null, 2)
                  : `Error: ${result?.error ?? "the tool reported no result"}`,
              },
            ],
            isError: !result?.success,
          },
        });
        return;
      }

      case "ping":
        respond({ id, result: {} });
        return;

      default:
        if (id === undefined) return; // unknown notification
        respond({ id, error: { code: -32601, message: `Unknown method "${method}"` } });
    }
  } catch (error) {
    if (id === undefined) return;
    const message = error instanceof Error ? error.message : String(error);
    /*
      Report a failed call as a tool RESULT where we can. An agent can read
      "the video panel is not available" and tell the operator; a JSON-RPC
      error code usually just aborts the turn.
    */
    if (method === "tools/call") {
      respond({ id, result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true } });
    } else {
      respond({ id, error: { code: -32603, message } });
    }
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;

  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);

    if (line.length > 0) {
      try {
        void handle(JSON.parse(line));
      } catch {
        respond({ error: { code: -32700, message: "Parse error" } });
      }
    }
    newline = buffer.indexOf("\n");
  }
});

// Nothing to serve once the client hangs up.
process.stdin.on("end", () => process.exit(0));

process.stderr.write("Teminali Code video MCP shim ready — forwarding to the live panel.\n");
