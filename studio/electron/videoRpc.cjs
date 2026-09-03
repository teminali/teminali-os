/* ─────────────────────────────────────────────────────────────────────────────
   The one door into the running video panel.

   The MCP stdio shim talks to this, and so could anything else on the machine —
   which is exactly why it binds 127.0.0.1 only and checks a token minted fresh
   every launch. A port on 0.0.0.0 with no auth would let any page the operator
   visits reach into the project they have open, since a browser may POST across
   origins freely.

   Ported from teminaliCut/electron/rpcServer.ts. Two deliberate differences:
   the bridge is passed in rather than imported, so this file requires nothing
   from Electron and the whole chain below it can be tested under plain Node;
   and there is no `debug/eval` route, because arbitrary evaluation in the
   renderer is a capability this app has no reason to expose.
   ───────────────────────────────────────────────────────────────────────────── */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * 3899, not the Cut's 3888.
 *
 * Teminali Cut is still shipping and still binds 3888. The two apps are meant
 * to run side by side — that is the entire hedge behind the phased port — so
 * they must not fight over a port. `TEMINALI_VIDEO_RPC_PORT` moves it, which is
 * what lets a second Code instance (or a CI runner that cannot assume the port
 * is free) have a bridge of its own.
 */
const DEFAULT_PORT = 3899;

function resolvePort() {
  const requested = Number(process.env.TEMINALI_VIDEO_RPC_PORT);
  return Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_PORT;
}

/**
 * Where the port and token are published for the processes that need them.
 *
 * The gateway spawns the agent CLIs, and in development it is a *separate*
 * process from Electron main — so it cannot be handed the token in memory and
 * cannot call `app.getPath("userData")` to find a file either. The temp
 * directory is the one location both sides compute identically with no Electron
 * and no app-name guessing.
 *
 * Written 0600, because on Linux the temp directory is shared between users and
 * the file carries a credential. Named after the port when it is not the
 * default, so two instances cannot overwrite each other's — the Cut's "Bad or
 * missing token" bug, which cost real time twice.
 */
function endpointFile(port = resolvePort()) {
  const name = port === DEFAULT_PORT ? "video-bridge.json" : `video-bridge-${port}.json`;
  return path.join(os.tmpdir(), `teminali-code-${name}`);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    // Refuse anything implausibly large rather than buffering it.
    const LIMIT = 4 * 1024 * 1024;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > LIMIT) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Start the bridge.
 *
 * `bridge` is the object from videoToolBridge.cjs — or, in a test, anything
 * with the same three methods. Returns a handle even when the port could not be
 * taken: an occupied port is an ordinary mistake and must not take the app down
 * with it. Code is still an editor with no agent attached, which is a far
 * better outcome than exiting, and the log line says what to do.
 */
function startVideoRpcServer({ bridge, log = () => {}, port = resolvePort(), token } = {}) {
  const rpcToken = token || crypto.randomBytes(24).toString("hex");
  let listening = false;
  /*
    The port actually bound, which is not always the port asked for: 0 means
    "any free one", and the endpoint file has to describe where the bridge
    really is or the shim will knock on an empty door. A test uses that, and so
    would a CI runner, which cannot assume 3899 is free.
  */
  let boundPort = port;
  /*
    Whether THIS instance published the endpoint file.

    Load-bearing on the way out: an instance that lost the port race must not
    unlink the file on quit, because the file belongs to the instance that won
    and is the only place its token exists. Deleting it would leave a running
    app whose bridge nothing can find — the Cut's "Bad or missing token" bug
    with the arrow pointing the other way.
  */
  let published = false;

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/rpc") {
      send(res, 404, { error: "Not found" });
      return;
    }
    if (req.headers["x-teminali-token"] !== rpcToken) {
      send(res, 401, { error: "Bad or missing token" });
      return;
    }

    try {
      const { method, params } = JSON.parse(await readBody(req));

      if (!bridge.isReady()) {
        send(res, 503, { error: "The Teminali Code video panel is not available — is the app open?" });
        return;
      }

      switch (method) {
        case "tools/list":
          send(res, 200, { result: await bridge.listTools() });
          return;

        case "tools/call":
          send(res, 200, {
            result: await bridge.callTool(String(params?.name ?? ""), params?.arguments ?? {}),
          });
          return;

        case "ping":
          send(res, 200, { result: { ok: true } });
          return;

        default:
          send(res, 400, { error: `Unknown method "${method}"` });
      }
    } catch (error) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  /*
    A tool call is a local operation the operator is watching happen, but the
    request must still outlive Node's defaults: those dropped the connection
    mid-call in the Cut, and a caller that gets nothing back cannot tell a
    completed edit from a failed one.
  */
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;

  server.on("error", (error) => {
    listening = false;
    if (error.code === "EADDRINUSE") {
      log(
        `[video] port ${port} is already in use, so this instance has no MCP bridge. ` +
        "Another Teminali Code is probably running; relaunch with a different " +
        "TEMINALI_VIDEO_RPC_PORT to give both one."
      );
      return;
    }
    log(`[video] the MCP bridge failed to start: ${error.message}`);
  });

  server.listen(port, "127.0.0.1", () => {
    listening = true;
    boundPort = server.address()?.port ?? port;
    log(`[video] MCP bridge on http://127.0.0.1:${boundPort}/rpc`);
    /*
      The endpoint file is written HERE and nowhere else, because it may only
      ever describe an instance that actually holds the port. `listen` is
      asynchronous: a second instance asking for a port it cannot have would
      otherwise overwrite the first one's credentials before failing, and the
      first would go on serving and answering 401 to every call.
    */
    try {
      fs.writeFileSync(
        endpointFile(boundPort),
        JSON.stringify({ port: boundPort, token: rpcToken, pid: process.pid, startedAt: Date.now() }, null, 2),
        { encoding: "utf8", mode: 0o600 }
      );
      published = true;
    } catch (error) {
      log(`[video] could not publish the bridge endpoint: ${error.message}`);
    }
  });

  return {
    server,
    token: rpcToken,
    /** Where it actually is. Only meaningful once `isListening()` is true. */
    port: () => boundPort,
    isListening: () => listening,
    /** Best effort: a stale file is survivable (the pid check catches it), a crash on quit is not. */
    close: () => {
      if (published) {
        try {
          fs.unlinkSync(endpointFile(boundPort));
        } catch {
          /* already gone */
        }
      }
      try {
        server.close();
      } catch {
        /* already closed */
      }
    },
  };
}

module.exports = { startVideoRpcServer, endpointFile, resolvePort, DEFAULT_PORT };
