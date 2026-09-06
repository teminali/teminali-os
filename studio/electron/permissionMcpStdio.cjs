/* ─────────────────────────────────────────────────────────────────────────────
   Permission-prompt MCP shim.

   `claude -p` has no terminal to prompt on, so `--permission-prompt-tool` names
   an MCP tool to call instead. This is that tool. It decides nothing: every
   request is forwarded to the gateway, which puts it in front of the operator
   in the agent tab and sends the answer back.

   Sibling of videoMcpStdio.cjs and deliberately shaped the same way. Runs under
   Electron's bundled Node via ELECTRON_RUN_AS_NODE=1, or under plain node.
   ───────────────────────────────────────────────────────────────────────────── */

const PORT = Number(process.env.FRONTIER_GATEWAY_PORT) || 4310;
const RUN_ID = process.env.TEMINALI_PERMISSION_RUN || "";
const TOKEN = process.env.TEMINALI_PERMISSION_TOKEN || "";

const SERVER_INFO = { name: "teminali-permissions", version: "1.0.0" };
const TOOL_NAME = "approve";

function respond(body) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...body })}\n`);
}

/**
 * The verdict, as the CLI wants to read it: a single text block whose content
 * is the JSON decision. Anything else is treated as a malformed answer and the
 * call is refused.
 */
function verdict(decision) {
  return {
    content: [{ type: "text", text: JSON.stringify(decision) }],
  };
}

async function ask(toolName, input) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/agents/permission`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-teminali-permission-token": TOKEN,
    },
    body: JSON.stringify({ runId: RUN_ID, toolName, input }),
  });
  if (!response.ok) {
    throw new Error(`the permission bridge returned ${response.status}`);
  }
  const data = await response.json();
  return data?.behavior === "allow"
    ? { behavior: "allow", updatedInput: data.updatedInput ?? input }
    : { behavior: "deny", message: data?.message || "The operator declined this." };
}

const TOOL = {
  name: TOOL_NAME,
  description:
    "Ask the Teminali OS operator to approve a tool call. Called by the CLI in place of a terminal prompt; never call it directly.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "The tool awaiting approval." },
      input: { type: "object", description: "The arguments that tool was called with." },
    },
    required: ["tool_name", "input"],
  },
};

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
        return;

      case "tools/list":
        respond({ id, result: { tools: [TOOL] } });
        return;

      case "tools/call": {
        if (params?.name !== TOOL_NAME) {
          respond({ id, result: verdict({ behavior: "deny", message: `Unknown tool "${params?.name}".` }) });
          return;
        }
        const args = params?.arguments ?? {};
        const decision = await ask(args.tool_name ?? "", args.input ?? {});
        respond({ id, result: verdict(decision) });
        return;
      }

      case "ping":
        respond({ id, result: {} });
        return;

      default:
        if (id === undefined) return;
        respond({ id, error: { code: -32601, message: `Unknown method "${method}"` } });
    }
  } catch (error) {
    if (id === undefined) return;
    const message = error instanceof Error ? error.message : String(error);
    /*
      A bridge that cannot be reached must deny, and say why. Returning a
      JSON-RPC error instead would abort the turn, which loses the operator
      both the answer and the reason they never got asked.
    */
    if (method === "tools/call") {
      respond({ id, result: verdict({ behavior: "deny", message: `Could not reach the approval prompt: ${message}.` }) });
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

process.stderr.write("Teminali OS permission MCP shim ready.\n");
