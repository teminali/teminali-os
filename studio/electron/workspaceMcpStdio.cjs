/* ─────────────────────────────────────────────────────────────────────────────
   Workspace MCP shim.

   Lets the agent drive the application it is running inside: show a folder in
   the file tree, and switch the whole workspace to another project. Every call
   is forwarded to the gateway, which owns the workspace root, re-checks every
   path and is the only thing holding a channel back to the window; this process
   decides nothing.

   Sibling of screenMcpStdio.cjs and shaped the same way. Runs under Electron's
   bundled Node via ELECTRON_RUN_AS_NODE=1, or under plain node.

   ## The rule that shapes both tools

   A path is workspace-relative and the gateway proves it. `server/workspace.js`
   already refuses `..`, absolute paths and symlinks, and `reveal` is answered
   by the same `resolveWorkspacePath` every read route uses — so there is no
   path this shim can name that a read could not already have named. Switching
   projects is the one call that steps outside that boundary, which is exactly
   why it is not pre-approved.
   ───────────────────────────────────────────────────────────────────────────── */

const PORT = Number(process.env.FRONTIER_GATEWAY_PORT) || 4310;
const RUN_ID = process.env.TEMINALI_WORKSPACE_RUN || "";
const TOKEN = process.env.TEMINALI_WORKSPACE_TOKEN || "";

const SERVER_INFO = { name: "workspace", version: "1.0.0" };

function respond(body) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...body })}\n`);
}

async function call(route, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/workspace/agent/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-teminali-workspace-token": TOKEN,
    },
    body: JSON.stringify({ runId: RUN_ID, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `The workspace bridge returned ${response.status}`);
  }
  return data;
}

const TOOLS = [
  {
    name: "reveal",
    description:
      "Show a file or folder in the operator's file tree: every folder above it is opened and the tree scrolls to it. "
      + "Use it whenever you are about to talk about a path — they should be able to see what you mean without hunting for it. "
      + "This only shows; it opens no editor tab and changes no file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "A workspace-relative path, such as \"studio/src/store\". Not an absolute path." },
      },
      required: ["path"],
    },
  },
  {
    name: "open_project",
    description:
      "Switch the whole workspace to another project. This rebinds the file tree, the search and every terminal at once, "
      + "so the operator is asked before it happens. Give either `path` — an absolute path to the folder — or `phrase`, "
      + "what they actually said: \"the last project\", \"the one from yesterday\", \"the last video project\". "
      + "With neither, it lists the recent projects so you can choose.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "An absolute path to the project folder." },
        phrase: { type: "string", description: "The operator's own words for which recent project they mean." },
      },
    },
  },
  {
    name: "recent_projects",
    description:
      "List the projects the operator has opened recently, most recent first, each with when it was opened and whether it is "
      + "a code or a video project. Read-only. At most twelve are kept, so something worked on a while ago may not be here.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function runTool(name, args) {
  switch (name) {
    case "reveal": {
      const data = await call("reveal", { path: String(args.path ?? "") });
      return data.result ?? { ok: true };
    }
    case "recent_projects": {
      const data = await call("projects", {});
      return { current: data.current, recent: data.recent };
    }
    case "open_project": {
      const data = await call("open-project", {
        path: typeof args.path === "string" ? args.path : undefined,
        phrase: typeof args.phrase === "string" ? args.phrase : undefined,
      });
      return data.result ?? data;
    }
    default:
      throw new Error(`"${name}" is not a workspace tool.`);
  }
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

      case "tools/list":
        respond({ id, result: { tools: TOOLS } });
        return;

      case "tools/call": {
        const result = await runTool(params?.name, params?.arguments ?? {});
        respond({ id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
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
      A failed call is a tool RESULT, not a JSON-RPC error — "nothing recent is
      called that" is an answer the agent can act on, where an error code
      usually just aborts the turn.
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

process.stdin.on("end", () => process.exit(0));

process.stderr.write("Teminali Code workspace MCP shim ready — forwarding to the live workspace.\n");
