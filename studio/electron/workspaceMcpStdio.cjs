/* ─────────────────────────────────────────────────────────────────────────────
   Workspace MCP shim.

   Lets the agent drive the application it is running inside: show a folder in
   the file tree, open a file into an editor tab, show a page in the browser
   panel and read what that browser remembers, and switch the whole workspace
   to another project. Every call is forwarded to the gateway, which owns the
   workspace root, re-checks every path and is the only thing holding a channel
   back to the window; this process decides nothing.

   Sibling of screenMcpStdio.cjs and shaped the same way. Runs under Electron's
   bundled Node via ELECTRON_RUN_AS_NODE=1, or under plain node.

   ## The rule that shapes the showing tools

   A path is workspace-relative and the gateway proves it. `server/workspace.js`
   already refuses `..`, absolute paths and symlinks, and `reveal` and
   `open_file` are answered by the same `resolveWorkspacePath` every read route
   uses — so there is no path this shim can name that a read could not already
   have named. Switching projects is the one call that steps outside that
   boundary, which is exactly why it is not pre-approved.
   ───────────────────────────────────────────────────────────────────────────── */

const PORT = Number(process.env.FRONTIER_GATEWAY_PORT) || 4310;
const RUN_ID = process.env.TEMINALI_WORKSPACE_RUN || "";
const TOKEN = process.env.TEMINALI_WORKSPACE_TOKEN || "";

const SERVER_INFO = { name: "teminali-workspace", version: "1.0.0" };

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
    name: "open_file",
    description:
      "Open a file in the operator's editor and make it the tab they are looking at. "
      + "This is what to call when they asked to *see* something — `reveal` only scrolls their tree to it. "
      + "Opens text, images, PDFs, spreadsheets, video and audio, and a folder as a gallery of what is in it — "
      + "a folder holding two or more videos is additionally a series, with nothing playing until `player_control` starts an episode. "
      + "Anything else comes back as a refusal rather than an empty tab. "
      + "It reads only: nothing is written, and a tab they have unsaved changes in is left as it is.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "A workspace-relative path to a file, such as \"studio/src/App.tsx\", or to a folder. Not an absolute path." },
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
    name: "browse",
    description:
      "Show a web page in the operator's browser panel — the panel inside this app, beside their files, not their system browser. "
      + "Give a full http or https address. By default it navigates the browser tab they are looking at (opening one if there is none); "
      + "`new_tab` opens another. Read-only from the workspace's point of view and no permission is needed. "
      + "A search is an address too: https://www.google.com/search?q=… ",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "A full http(s) address." },
        new_tab: { type: "boolean", description: "Open a new browser tab rather than navigating the current one." },
      },
      required: ["url"],
    },
  },
  {
    name: "bookmarks",
    description: "The operator's browser bookmarks, newest first: address, title and when it was kept. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bookmark",
    description:
      "Keep a page in the operator's bookmarks, which they see on the browser's home page. Give a full http(s) address and, "
      + "ideally, a title. Writes a row, so the operator is asked first.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "A full http(s) address." },
        title: { type: "string", description: "What to call it. Defaults to the address." },
      },
      required: ["url"],
    },
  },
  {
    name: "browsing_history",
    description:
      "Pages the operator has visited in the browser panel, newest first, with titles and times. Optional `query` narrows to "
      + "rows whose address or title contains it; `limit` caps the rows (default 50). Read-only. At most 500 visits are kept.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for in the address or title." },
        limit: { type: "number", description: "How many rows at most." },
      },
    },
  },
  {
    name: "downloads",
    description:
      "Files the operator has downloaded through the browser panel, newest first: address, filename, where it was saved, size "
      + "and whether it completed. A saved path is somewhere on their machine, chosen by them in the save dialog. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "player",
    description:
      "What the operator's media player is showing right now: the file or the episode (with its number in the series), "
      + "playing or paused, position and duration, volume, speed, which subtitles are on and which are available, and the "
      + "whole episode list when a series is open. Read-only and free. Call it before `player_control` when you need the "
      + "episode numbers or the subtitle labels, and after, to confirm what happened.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "player_control",
    description:
      "Drive the operator's media player. `action` is one of: play, pause, toggle, restart; seek (value: seconds from the "
      + "start), seek_by (value: seconds, negative to go back); volume (value: 0–1), mute, unmute; rate (value: 0.25–3, 1 is "
      + "normal); subtitles (value: a label from `player`, \"on\" for the first available, or \"off\"); fullscreen (value: "
      + "true/false, or none to toggle); next, previous, episode (value: the episode number, from 1), episodes (back to the "
      + "gallery). Acts on the file the operator already has open and writes nothing, so it needs no permission. It fails "
      + "plainly when nothing is open — `open_file` a video, or a folder of videos, first.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "play", "pause", "toggle", "restart",
            "seek", "seek_by", "frame_step", "frame_back", "chapter",
            "volume", "mute", "unmute", "rate",
            "subtitles", "audio_track", "fullscreen",
            "next", "previous", "episode", "episodes",
          ],
        },
        value: { description: "What the action takes, if anything: seconds, a 0–1 volume, a rate, an episode or chapter number, an audio or subtitle track, or a boolean." },
      },
      required: ["action"],
    },
  },
  {
    name: "player_frame",
    description:
      "Look at the video the operator is playing: one frame of it, as a picture, from wherever it is paused or playing right "
      + "now. This is how you answer a question about what is *on screen* — who is in the shot, what a caption says, whether "
      + "this is the scene they mean — instead of guessing from a filename. To find a moment, `player_control` seek and then "
      + "look again; a few of those is normal. Read-only and free. Nothing but their video is in the picture: for the operator "
      + "themselves use the camera, for the rest of their desktop use a screenshot. It fails plainly when nothing is playing, "
      + "or when what is open is audio and has no picture to take.",
    inputSchema: { type: "object", properties: {} },
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
    case "open_file": {
      const data = await call("open-file", { path: String(args.path ?? "") });
      return data.result ?? { ok: true };
    }
    case "browse": {
      const data = await call("browse", { url: String(args.url ?? ""), newTab: args.new_tab === true });
      return data.result ?? { ok: true };
    }
    case "bookmarks": {
      const data = await call("bookmarks", {});
      return data.result ?? data;
    }
    case "bookmark": {
      const data = await call("bookmark", {
        url: String(args.url ?? ""),
        title: typeof args.title === "string" ? args.title : undefined,
      });
      return data.result ?? data;
    }
    case "browsing_history": {
      const data = await call("browsing-history", {
        query: typeof args.query === "string" ? args.query : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return data.result ?? data;
    }
    case "downloads": {
      const data = await call("downloads", {});
      return data.result ?? data;
    }
    case "player": {
      const data = await call("player", {});
      return data.result ?? data;
    }
    case "player_control": {
      const data = await call("player-control", { action: String(args.action ?? ""), value: args.value });
      return data.result ?? data;
    }
    case "player_frame": {
      const data = await call("player-frame", {});
      return data.result ?? data;
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

/**
 * The tool's result as MCP content.
 *
 * Everything here is JSON, which is what it is — except a frame of the
 * operator's video, which is handed over as a real image block rather than as
 * a data URI inside a JSON blob. The agent's own eyes are the point of that
 * tool, and a base64 string in a text field is not a picture to any client.
 * The same shape browserMcpStdio.cjs and cameraMcpStdio.cjs use.
 *
 * The sentence beside the picture is the gateway's, not this shim's: a frame
 * with no timestamp under it is a frame the model cannot seek from, and this
 * process decides nothing.
 */
function contentFor(name, result) {
  if (name !== "player_frame") return [{ type: "text", text: JSON.stringify(result, null, 2) }];
  const source = typeof result?.image === "string" ? result.image : "";
  const comma = source.indexOf(",");
  const base64 = comma < 0 ? source : source.slice(comma + 1);
  if (!base64) throw new Error("The player produced no picture.");
  return [
    { type: "image", data: base64, mimeType: "image/jpeg" },
    { type: "text", text: String(result.summary || "One frame of what the operator is playing.") },
  ];
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
        respond({ id, result: { content: contentFor(params?.name, result) } });
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

process.stderr.write("Teminali OS workspace MCP shim ready — forwarding to the live workspace.\n");
