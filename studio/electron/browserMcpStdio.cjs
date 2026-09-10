/* ─────────────────────────────────────────────────────────────────────────────
   Browser MCP shim.

   Lets the agent read and act on the page in the operator's browser panel —
   the panel inside this app, beside their files. Until this existed the only
   way it could see a web page was to screenshot the whole desktop and run the
   macOS accessibility tree through a vision model, which cannot click, cannot
   type, and cannot see a page that is scrolled off the display.

   Sibling of workspaceMcpStdio.cjs and cameraMcpStdio.cjs, shaped the same
   way. Runs under Electron's bundled Node via ELECTRON_RUN_AS_NODE=1, or under
   plain node. This process decides nothing: the gateway owns the run token,
   `server/browser-agent.js` checks the arguments, and the protocol itself is
   spoken only in electron/browserCdp.cjs.

   ## The tools are semantic, and that is the security boundary

   None of these names a DevTools Protocol method, and there is no argument
   anywhere on this path that can. `page_snapshot` means "the accessibility
   outline of the page, with a ref on everything you can act on"; main decides
   which protocol commands that is. So the allowlist in browserCdp.cjs guards
   our own future code rather than the model's input — a tool added in six
   months that reaches a new CDP domain fails a test before it ships.

   ## Which tools cost the operator a prompt

   Reading is pre-approved: `page_snapshot`, `page_read` and `page_screenshot`
   look at a page the operator already has open in front of them. Acting is
   not. `page_click`, `page_type` and `page_network` go through the CLI's
   permission dialog, and `page_eval` — which runs the agent's own JavaScript
   in someone else's document, on their session — is the one that must never be
   pre-approved. See server/browser-mcp.js.
   ───────────────────────────────────────────────────────────────────────────── */

const PORT = Number(process.env.FRONTIER_GATEWAY_PORT) || 4310;
const RUN_ID = process.env.TEMINALI_BROWSER_RUN || "";
const TOKEN = process.env.TEMINALI_BROWSER_TOKEN || "";

const SERVER_INFO = { name: "teminali-browser", version: "1.0.0" };

/*
  Longer than the gateway's own wait for the window (30s), so that when a page
  hangs the sentence the agent sees is the bridge's — which says which part
  failed — rather than this process giving up first and saying only that it
  did.
*/
const CALL_TIMEOUT_MS = 35_000;

function respond(body) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...body })}\n`);
}

async function call(route, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/workspace/agent/browser/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-teminali-browser-token": TOKEN,
    },
    body: JSON.stringify({ runId: RUN_ID, ...body }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `The browser bridge returned ${response.status}`);
  }
  return data.result ?? data;
}

const TOOLS = [
  {
    name: "page_snapshot",
    description:
      "The accessibility outline of the page in the operator's browser panel: every heading, link, button, field and "
      + "landmark, indented as they are nested, each acting element carrying a `ref` such as \"e12\". "
      + "This is how to SEE a web page — it works on a client-rendered page, which fetching the URL does not, and it is far "
      + "cheaper than a screenshot. Call it first: `page_click` and `page_type` take refs from it and nothing else. "
      + "Refs die the moment the page navigates, so snapshot again after a click that loaded something.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "page_read",
    description:
      "The readable text of the page in the operator's browser panel — the article, not the chrome. "
      + "Use it to actually read something; use `page_snapshot` to find what to click. Long pages are cut and say so.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "page_screenshot",
    description:
      "A picture of the page in the operator's browser panel, handed to you as an image. "
      + "Reach for it when the question is about how something LOOKS — a layout, a chart, a rendering bug. "
      + "For reading or for finding what to click, `page_read` and `page_snapshot` are cheaper and more precise.",
    inputSchema: {
      type: "object",
      properties: {
        full_page: { type: "boolean", description: "Capture the whole scrollable page rather than what is on screen." },
      },
    },
  },
  {
    name: "page_click",
    description:
      "Click an element in the operator's browser panel. `ref` is a ref from the last `page_snapshot`, such as \"e12\"; "
      + "the element is scrolled into view first. Take a fresh snapshot afterwards if the page navigated — the old refs "
      + "describe a document that is no longer there.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "A ref from the last page_snapshot, such as \"e12\"." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Which mouse button. Default left." },
      },
      required: ["ref"],
    },
  },
  {
    name: "page_type",
    description:
      "Type into a field in the operator's browser panel. `ref` is a ref from the last `page_snapshot`. "
      + "The text is inserted the way a browser's own automation inserts it, so a React-controlled field sees it properly. "
      + "It does not press any keys: set `submit` to press Enter afterwards, which is what a search box usually needs.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "A ref from the last page_snapshot, such as \"e3\"." },
        text: { type: "string", description: "What to type. Replaces nothing — clear the field first if it has content." },
        submit: { type: "boolean", description: "Press Enter after typing." },
      },
      required: ["ref"],
    },
  },
  {
    name: "page_network",
    description:
      "What the page in the operator's browser panel has asked the network for: method, address, type and status. "
      + "Use it to find the API behind a page, or to see which request failed. "
      + "The log starts when you first call this, so the first call on an already-loaded page is empty and says so — "
      + "reload the page, or act on it, and ask again.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many rows at most. Default 50, maximum 200." },
        filter: { type: "string", description: "Keep only rows whose address or status contains this." },
      },
    },
  },
  {
    name: "page_eval",
    description:
      "Evaluate a JavaScript expression in the page in the operator's browser panel and give back its value. "
      + "This runs YOUR code in SOMEONE ELSE'S document, signed in as them — the last resort, after `page_read`, "
      + "`page_snapshot` and `page_click` have all failed to get at something. Awaits a promise. "
      + "The value comes back as JSON, cut at 4000 characters.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "A JavaScript expression, evaluated in the page's own world." },
      },
      required: ["expression"],
    },
  },
];

async function runTool(name, args) {
  switch (name) {
    case "page_snapshot":
      return { data: await call("snapshot", {}) };
    case "page_read":
      return { data: await call("read", {}) };
    case "page_screenshot":
      return { data: await call("screenshot", { fullPage: args.full_page === true }), image: true };
    case "page_click":
      return { data: await call("click", { ref: String(args.ref ?? ""), button: args.button }) };
    case "page_type":
      return {
        data: await call("type", {
          ref: String(args.ref ?? ""),
          text: typeof args.text === "string" ? args.text : "",
          submit: args.submit === true,
        }),
      };
    case "page_network":
      return {
        data: await call("network", {
          limit: typeof args.limit === "number" ? args.limit : undefined,
          filter: typeof args.filter === "string" ? args.filter : undefined,
        }),
      };
    case "page_eval":
      return { data: await call("eval", { expression: String(args.expression ?? "") }) };
    default:
      throw new Error(`"${name}" is not a browser tool.`);
  }
}

/**
 * The tool's result as MCP content.
 *
 * A screenshot is handed over as a real image block rather than as a data URI
 * inside a JSON blob — the agent's own eyes are the point of the tool, and a
 * base64 string in a text field is not a picture to any client. Same shape
 * cameraMcpStdio.cjs uses. Everything else is JSON, which is what it is.
 */
function contentFor({ data, image }) {
  if (!image) return [{ type: "text", text: JSON.stringify(data, null, 2) }];
  const source = typeof data?.image === "string" ? data.image : "";
  const comma = source.indexOf(",");
  const base64 = comma < 0 ? source : source.slice(comma + 1);
  if (!base64) throw new Error("The browser panel produced no picture.");
  return [
    { type: "image", data: base64, mimeType: "image/jpeg" },
    {
      type: "text",
      text: `${data.fullPage ? "The whole page" : "What is on screen"} in the operator's browser panel: ${data.title || "untitled"} — ${data.url}`,
    },
  ];
}

/*
  How many calls are still waiting on an answer.

  A page snapshot is a round trip to the gateway, out to the window and back
  through main — during which this process must not decide it has nothing left
  to do. A client that closes stdin while a call is outstanding would otherwise
  get no reply at all, because `end` exits.
*/
let inFlight = 0;
let stdinClosed = false;

function exitWhenIdle() {
  if (stdinClosed && inFlight === 0) process.exit(0);
}

async function handle(request) {
  const { id, method, params } = request;

  inFlight += 1;
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
        const outcome = await runTool(params?.name, params?.arguments ?? {});
        respond({ id, result: { content: contentFor(outcome) } });
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
      A failed call is a tool RESULT, not a JSON-RPC error. "No browser panel
      is open — call `browse` first" and "the page has navigated since that
      snapshot" are both instructions the agent can act on by itself, where an
      error code usually just aborts the turn.
    */
    if (method === "tools/call") {
      respond({ id, result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true } });
    } else {
      respond({ id, error: { code: -32603, message } });
    }
  } finally {
    inFlight -= 1;
    exitWhenIdle();
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

process.stdin.on("end", () => {
  stdinClosed = true;
  exitWhenIdle();
});

process.stderr.write("Teminali OS browser MCP shim ready — forwarding to the live browser panel.\n");
