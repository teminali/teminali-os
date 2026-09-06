/* ─────────────────────────────────────────────────────────────────────────────
   Camera MCP shim.

   Lets the assistant look at the operator rather than at their screen. One
   tool, one frame, and the frame itself goes back — not a description of it.

   ## Why the picture and not a caption

   `server/assistant.js` describes a screenshot with a local vision model,
   because a screen is mostly text and layout and a caption of it is cheap,
   private and enough to reason over. A person is not that. Asked "how do I
   look" or "what am I holding", a thirty-word local caption throws away
   exactly what was being asked about, and the model doing the reasoning is
   already one that can see. So this returns an MCP image block and lets the
   agent's own eyes do the work.

   That is also why it is not free: the picture leaves the machine. The tool is
   deliberately absent from every pre-approved list, so the operator is asked
   before the camera opens — see `server/camera-mcp.js`.

   Sibling of screenMcpStdio.cjs and workspaceMcpStdio.cjs, shaped the same
   way. Runs under Electron's bundled Node via ELECTRON_RUN_AS_NODE=1, or under
   plain node. This process decides nothing: the gateway owns the run token and
   is the only thing holding a channel back to the window that has the camera.
   ───────────────────────────────────────────────────────────────────────────── */

const PORT = Number(process.env.FRONTIER_GATEWAY_PORT) || 4310;
const RUN_ID = process.env.TEMINALI_CAMERA_RUN || "";
const TOKEN = process.env.TEMINALI_CAMERA_TOKEN || "";

const SERVER_INFO = { name: "teminali-camera", version: "1.0.0" };

/* A frame has to be taken, which means a camera warming up and a window
   answering. Longer than the bridge's own wait so the bridge's message — which
   says which part failed — is the one the agent sees. */
const CALL_TIMEOUT_MS = 25_000;

function respond(body) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...body })}\n`);
}

async function call(route, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/assistant/agent/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-teminali-camera-token": TOKEN,
    },
    body: JSON.stringify({ runId: RUN_ID, ...body }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `The camera bridge returned ${response.status}`);
  }
  return data;
}

const TOOLS = [
  {
    name: "look_at_me",
    description:
      "Look at the operator through their webcam. Use it when they ask whether you can see them, or ask about anything "
      + "in front of the camera — how they look, what they are holding, what they are doing, who is with them. "
      + "This is the room, not the screen: use `look` on the screen server for anything on their display. "
      + "Ask for several frames when the question is about MOVEMENT or a process — what they are doing with their hands, "
      + "whether they are nodding, how something is being assembled — because one still cannot answer that. "
      + "The camera stays warm for about ten seconds after a look, so a follow-up in that window is nearly instant; "
      + "looking again to check on something is cheap and expected.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "One short phrase for why you are looking, shown to the operator with the request. e.g. \"to see what you're holding\".",
        },
        frames: {
          type: "number",
          description: "How many frames to take, 1 to 6. One (the default) is a photograph and is sharper. More than one is a sequence and shows movement.",
        },
        span_ms: {
          type: "number",
          description: "How long to spread a multi-frame sequence over, in milliseconds. Default 1200, maximum 5000.",
        },
      },
    },
  },
];

/*
  How many calls are still waiting on an answer.

  Taking a photograph means a round trip to the gateway and a camera warming
  up in a window — hundreds of milliseconds during which this process must not
  decide it has nothing left to do. A client that closes stdin while a call is
  outstanding would otherwise get no reply at all, because `end` exits.
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
        if (params?.name !== "look_at_me") throw new Error(`"${params?.name}" is not a camera tool.`);
        const args = params?.arguments ?? {};
        const data = await call("camera", {
          reason: typeof args.reason === "string" ? args.reason : "",
          frames: Number(args.frames) || 1,
          spanMs: Number(args.span_ms) || 1200,
        });
        const frame = data.frame ?? data;
        const images = Array.isArray(frame?.images) ? frame.images : [];
        if (images.length === 0) throw new Error("The camera returned no picture.");
        /*
          The pictures first, in the order they were taken, then the note. An
          agent reading this is being handed photographs; the sentence after
          them is there so a client that cannot render images still says
          something true rather than nothing, and so the model knows whether it
          is looking at one moment or at a stretch of time.
        */
        respond({
          id,
          result: {
            content: [
              ...images.map((image) => ({ type: "image", data: image, mimeType: "image/jpeg" })),
              {
                type: "text",
                text: images.length === 1
                  ? `One frame from the operator's webcam, taken ${frame.capturedAt}.`
                  : `${images.length} frames from the operator's webcam in the order they were taken, spanning about ${frame.tookMs} ms up to ${frame.capturedAt}. Read them as a sequence: what changed between them is the answer to a question about movement.`,
              },
            ],
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
      A camera that could not be opened is a tool result the agent can report
      and work around, not a JSON-RPC error that ends the turn. "There is no
      camera on this machine" is an answer.
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

process.stderr.write("Teminali Code camera MCP shim ready — forwarding to the live window.\n");
