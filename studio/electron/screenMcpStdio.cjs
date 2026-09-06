/* ─────────────────────────────────────────────────────────────────────────────
   Screen MCP shim.

   Gives the chat pane's agent the hands the screen assistant already has: it
   can look at the operator's screen, and act on what it saw. Every call is
   forwarded to the gateway, which owns the observation store, re-checks every
   step and moves the pointer; this process decides nothing.

   Sibling of videoMcpStdio.cjs and permissionMcpStdio.cjs, and deliberately
   shaped the same way. Runs under Electron's bundled Node via
   ELECTRON_RUN_AS_NODE=1, or under plain node.

   ## The rule that shapes every tool below

   No tool takes a coordinate, and no tool hands one out. `look` returns
   elements the operating system reported, each with an id; every acting tool
   names one of those ids. The gateway resolves the id to the frame macOS
   itself reports for that element — so what gets clicked is where the control
   actually is, not where a model guessed it might be. Frames are stripped from
   what the model sees, both because it must not reason in pixels and because
   they are the bulk of an observation's size.
   ───────────────────────────────────────────────────────────────────────────── */

const PORT = Number(process.env.FRONTIER_GATEWAY_PORT) || 4310;
const RUN_ID = process.env.TEMINALI_SCREEN_RUN || "";
const TOKEN = process.env.TEMINALI_SCREEN_TOKEN || "";

const SERVER_INFO = { name: "screen", version: "1.0.0" };

/**
 * What the last `look` saw, kept so the acting tools need not be told again.
 *
 * `observation` lets every other tool default to the most recent look, which
 * removes a whole class of turn-ending mistake — an agent that mistypes an
 * opaque id gets a refusal instead of a click. Staleness is still caught: the
 * gateway enforces the 90-second TTL and the frontmost check regardless of who
 * named the observation.
 *
 * `launchable` is the full catalogue of what this machine can open. It is kept
 * here rather than sent to the model on every look, because it is a hundred
 * entries the model needs once. `launch` and `focus` resolve a friendly name
 * against it, so the agent may say "Google Chrome" and the gateway still only
 * ever receives an id it recognises.
 */
let lastObservation = null;
let launchable = [];

function respond(body) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...body })}\n`);
}

async function call(route, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/assistant/agent/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-teminali-screen-token": TOKEN,
    },
    body: JSON.stringify({ runId: RUN_ID, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `The screen bridge returned ${response.status}`);
  }
  return data;
}

/* ── look ─────────────────────────────────────────────────────────────────── */

/**
 * The observation, trimmed to what a model can act on.
 *
 * An observation carries screen geometry, element frames and the whole
 * installed-application catalogue. None of that belongs in an agent's context:
 * the geometry and frames are coordinates it must not reason about, and the
 * catalogue is answered by `launch` resolving a name. What is left is the part
 * a plan is actually written against.
 */
function forModel(observation, { apps = false } = {}) {
  const elements = (observation.elements || []).map((element) => {
    const entry = { id: element.id, role: element.role };
    if (element.label) entry.label = element.label;
    if (element.value !== undefined && element.value !== null && element.value !== "") entry.value = element.value;
    // Only the unusual case is worth a field. Most controls are enabled and
    // saying so a hundred times tells the model nothing.
    if (element.enabled === false) entry.enabled = false;
    if (element.focused) entry.focused = true;
    return entry;
  });

  const view = {
    observation: observation.id,
    application: observation.application?.name ?? "Unknown",
    window: observation.window?.title ?? null,
    scene: observation.sceneDescription ?? null,
    elements,
    truncated: Boolean(observation.truncated),
  };
  if (Array.isArray(observation.limits) && observation.limits.length > 0) view.limits = observation.limits;

  if (apps) {
    view.apps = launchable.map((entry) => entry.name);
  } else if (launchable.length > 0) {
    view.appsAvailable = `${launchable.length} applications can be opened by name with launch — call look with apps:true to see the list.`;
  }
  return view;
}

/* ── launch and focus ─────────────────────────────────────────────────────── */

/**
 * A spoken name to a catalogue id.
 *
 * Exact id first, then an exact name, then a name that merely contains what was
 * asked for — "chrome" finding "Google Chrome" is the case this is for. It
 * resolves nothing it cannot find: an unrecognised name is passed through
 * unchanged so the gateway refuses it by name, which reads better to the agent
 * than this shim inventing a plausible id.
 */
function resolveApp(wanted) {
  const asked = String(wanted ?? "").trim();
  if (!asked) return asked;
  const lower = asked.toLowerCase();
  const byId = launchable.find((entry) => entry.id === lower);
  if (byId) return byId.id;
  const byName = launchable.find((entry) => entry.name.toLowerCase() === lower);
  if (byName) return byName.id;
  const partial = launchable.find((entry) => entry.name.toLowerCase().includes(lower));
  return partial ? partial.id : asked;
}

/* ── Tools ────────────────────────────────────────────────────────────────── */

const OBSERVATION_ARG = {
  type: "string",
  description: "The id from the look this refers to. Omit to use the most recent look.",
};

const TOOLS = [
  {
    name: "look",
    description:
      "Look at the operator's screen. Returns the frontmost application, its window, a description of what is visible, "
      + "and every control the operating system reports, each with an id. Every other screen tool names one of those ids. "
      + "Take a fresh look after anything that changes the screen — a click that opens a dialog, a launch, a page load. "
      + "A look older than 90 seconds is refused.",
    inputSchema: {
      type: "object",
      properties: {
        apps: { type: "boolean", description: "Also list every application that can be opened. A hundred or so names; ask once, not every look." },
        describe: { type: "boolean", description: "Include the written description of the screenshot. Default true. Set false for a faster, cheaper look when the control names are enough." },
      },
    },
  },
  {
    name: "click",
    description: "Click a control from the last look. This is also how you put the cursor in a text field before typing into it.",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "The id of the control to click." },
        button: { type: "string", enum: ["left", "right"], description: "Default left." },
        count: { type: "number", description: "1 for a click, 2 to double-click. Default 1." },
        observation: OBSERVATION_ARG,
      },
      required: ["element"],
    },
  },
  {
    name: "type",
    description:
      "Type text wherever the keyboard focus already is. It does not choose a field — click the field first. "
      + "Do not type a password or any other credential: ask the operator to type it themselves.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to type." },
        observation: OBSERVATION_ARG,
      },
      required: ["text"],
    },
  },
  {
    name: "key",
    description: "Press a key or chord, such as \"return\", \"tab\", \"cmd+a\" or \"cmd+shift+t\".",
    inputSchema: {
      type: "object",
      properties: {
        chord: { type: "string", description: "The chord to press." },
        observation: OBSERVATION_ARG,
      },
      required: ["chord"],
    },
  },
  {
    name: "scroll",
    description: "Scroll over a control from the last look. Negative dy scrolls down the page.",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "The id of the control to scroll over." },
        dx: { type: "number" },
        dy: { type: "number" },
        observation: OBSERVATION_ARG,
      },
      required: ["element"],
    },
  },
  {
    name: "drag",
    description:
      "Press on a control, travel, and release. Give either `to` — a second element id, for a reorder or a drop — "
      + "or `dx`/`dy`, a displacement in points, for a slider or a handle with no element at the destination. Never both.",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "The id of the control to press on." },
        to: { type: "string", description: "The id of the control to release over." },
        dx: { type: "number" },
        dy: { type: "number" },
        button: { type: "string", enum: ["left", "right"] },
        observation: OBSERVATION_ARG,
      },
      required: ["element"],
    },
  },
  {
    name: "launch",
    description:
      "Open an application, optionally at a URL if it is a browser. Use it when what the operator wants is not on the screen yet. "
      + "The screen afterwards is not the screen you planned against, so take a fresh look before acting again.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "The application's name, as a person would say it — \"Google Chrome\", \"Safari\", \"Slack\"." },
        url: { type: "string", description: "An http or https URL. Browsers only." },
        observation: OBSERVATION_ARG,
      },
      required: ["app"],
    },
  },
  {
    name: "focus",
    description:
      "Bring an application that is already running to the front. Prefer it to `launch` for something already open — "
      + "a launch is at best wasted and at worst a second window. Take a fresh look afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "The application's name, as a person would say it." },
        observation: OBSERVATION_ARG,
      },
      required: ["app"],
    },
  },
  {
    name: "wait",
    description: "Pause, for a page or a window that is still settling. Up to 5 seconds. Cheaper than taking a look that shows a half-drawn screen.",
    inputSchema: {
      type: "object",
      properties: {
        ms: { type: "number", description: "Milliseconds to wait, at most 5000." },
        observation: OBSERVATION_ARG,
      },
      required: ["ms"],
    },
  },
];

const ACTING = new Map([
  ["click", (args) => ({ kind: "click", element: args.element, button: args.button, count: args.count })],
  ["type", (args) => ({ kind: "type", text: args.text })],
  ["key", (args) => ({ kind: "key", chord: args.chord })],
  ["scroll", (args) => ({ kind: "scroll", element: args.element, dx: args.dx, dy: args.dy })],
  ["drag", (args) => ({ kind: "drag", element: args.element, to: args.to, dx: args.dx, dy: args.dy, button: args.button })],
  ["launch", (args) => ({ kind: "launch", app: resolveApp(args.app), url: args.url })],
  ["focus", (args) => ({ kind: "focus", app: resolveApp(args.app) })],
  ["wait", (args) => ({ kind: "wait", ms: args.ms })],
]);

/** Drops the keys the caller left out, so the gateway sees a step, not a mask of undefineds. */
function tidy(step) {
  const out = {};
  for (const [key, value] of Object.entries(step)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

async function runTool(name, args) {
  if (name === "look") {
    const data = await call("observe", { describe: args.describe !== false });
    lastObservation = data.observation?.id ?? null;
    if (Array.isArray(data.observation?.launchable)) launchable = data.observation.launchable;
    return forModel(data.observation ?? {}, { apps: args.apps === true });
  }

  const build = ACTING.get(name);
  if (!build) throw new Error(`"${name}" is not a screen tool.`);

  const observationId = typeof args.observation === "string" && args.observation ? args.observation : lastObservation;
  if (!observationId) {
    throw new Error("Take a look at the screen first — every action names something you saw.");
  }

  const data = await call("act", { observationId, step: tidy(build(args)) });

  /*
    A launch or a focus expires the look it was made against, because the
    application that was in front is not any more. Forgetting it here as well
    turns the next action into "take another look" rather than a refusal the
    agent has to work out for itself.
  */
  if (name === "launch" || name === "focus") lastObservation = null;

  return data.result ?? { ok: true };
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
      A failed call is a tool RESULT, not a JSON-RPC error. "That look at the
      screen is no longer current — take another one" is an answer the agent can
      act on; an error code usually just aborts the turn.
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

process.stderr.write("Teminali OS screen MCP shim ready — forwarding to the live screen.\n");
