/**
 * What an agent actually brings into a turn.
 *
 * The picker can say which model, how hard it thinks and what it may touch —
 * and still leave the operator with no way to answer the question that decides
 * whether a turn can succeed at all: *what tools will this thing have?*
 *
 * Two very different answers are stitched together here.
 *
 *   1. **What Teminali OS injects.** Up to five MCP servers are attached to a
 *      turn by `runAgentTurn`, and four of them are Claude Code only. Choosing
 *      Codex silently costs the screen, the workspace, the camera and the
 *      approval bridge. That asymmetry was invisible everywhere in the app
 *      until this module: nothing rendered it, and the operator found out by
 *      asking Codex to do something it had no hands for.
 *
 *   2. **What the CLI brings of its own.** Both binaries carry MCP servers and
 *      plugins the operator configured outside this app, and both can be asked
 *      to list them. We ask rather than guess, for the same reason the effort
 *      and thinking vocabularies are read off `--help`: a list we invent is a
 *      list that goes stale the next time they ship.
 *
 * Slash commands are deliberately **not** here. Neither CLI has a subcommand
 * that lists them, and enumerating them would mean walking private directory
 * layouts and guessing at precedence. An inventory that guesses is worse than
 * one that admits a gap, so this one admits it.
 *
 * Nothing in here reports a value from an environment block. `codex mcp list`
 * masks env values in its table and prints them in full under `--json`; that
 * is a config file's worth of secrets, and it has no business crossing into a
 * renderer to be drawn in a menu. Names and status only.
 */

import { spawnCommand } from "./command-resolver.js";
import { AGENTS, agentEnvironment } from "./agent-cli.js";
import { MCP_SERVER_NAME, videoBridgeEndpoint } from "./video-mcp.js";
import { PERMISSION_SERVER_NAME } from "./permission-mcp.js";
import { SCREEN_SERVER_NAME } from "./screen-mcp.js";
import { WORKSPACE_SERVER_NAME } from "./workspace-mcp.js";
import { CAMERA_SERVER_NAME } from "./camera-mcp.js";

/** How long a probe may take before it is abandoned and reported as unknown. */
const PROBE_TIMEOUT_MS = 6_000;

/**
 * How long an assembled inventory is served from memory.
 *
 * `claude mcp list` health-checks every configured server over the network and
 * takes 2.4s on this machine; the other three probes are under a quarter of a
 * second. Without a cache, opening the picker twice pays that twice. Short
 * enough that enabling a plugin and reopening the menu shows the change.
 */
export const INVENTORY_TTL_MS = 60_000;

/**
 * The five servers `runAgentTurn` attaches, and the conditions under which the
 * operator actually gets them.
 *
 * This table mirrors predicates that live in five other modules, which is a
 * drift risk taken deliberately and then closed with a test: the builders
 * themselves write 0600 spec files keyed by a run id, so an inventory cannot
 * call them without manufacturing a run and leaving temp files behind.
 * `tests/agent-inventory.test.mjs` calls every builder for real, in a throwaway
 * directory, and asserts this table agrees with what came back. If someone
 * teaches `screen-mcp.js` about Codex and forgets this file, that test fails.
 *
 * `engines` is the set that reaches a non-empty argv. `gate` names the runtime
 * condition on top of the engine, and is null when the engine is the whole
 * story. See server/agent-cli.js `argsFor` and the `runToken` line above it.
 */
export const STUDIO_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: "video",
    server: MCP_SERVER_NAME,
    label: "Cut timeline",
    detail: "Read and edit the open video timeline",
    engines: Object.freeze(["claude", "codex"]),
    gate: "video",
    /* Named as a whole server by `--allowedTools`, so every tool is pre-approved. */
    tools: Object.freeze([`mcp__${MCP_SERVER_NAME}__*`]),
  }),
  Object.freeze({
    id: "approvals",
    server: PERMISSION_SERVER_NAME,
    label: "Approval prompts",
    detail: "Ask you before running a command, in the app rather than in a terminal",
    engines: Object.freeze(["claude"]),
    gate: null,
    tools: Object.freeze([`mcp__${PERMISSION_SERVER_NAME}`]),
  }),
  Object.freeze({
    id: "screen",
    server: SCREEN_SERVER_NAME,
    label: "Screen",
    detail: "Look at your screen, and drive it once you approve each action",
    engines: Object.freeze(["claude"]),
    gate: "screen",
    /* Only `look` is pre-approved; everything that moves the pointer goes to
       the same prompt an operator answers by hand. See screen-mcp.js:96. */
    tools: Object.freeze([`mcp__${SCREEN_SERVER_NAME}__look`]),
  }),
  Object.freeze({
    id: "workspace",
    server: WORKSPACE_SERVER_NAME,
    label: "Workspace",
    detail: "Reveal files, open panels and read your bookmarks and history",
    engines: Object.freeze(["claude"]),
    gate: null,
    tools: Object.freeze([
      `mcp__${WORKSPACE_SERVER_NAME}__reveal`,
      `mcp__${WORKSPACE_SERVER_NAME}__open_file`,
      `mcp__${WORKSPACE_SERVER_NAME}__browse`,
      `mcp__${WORKSPACE_SERVER_NAME}__bookmarks`,
      `mcp__${WORKSPACE_SERVER_NAME}__browsing_history`,
      `mcp__${WORKSPACE_SERVER_NAME}__downloads`,
    ]),
  }),
  Object.freeze({
    id: "camera",
    server: CAMERA_SERVER_NAME,
    label: "Camera",
    detail: "Look through your webcam, once you approve the call",
    engines: Object.freeze(["claude"]),
    gate: null,
    tools: Object.freeze([`mcp__${CAMERA_SERVER_NAME}__look_at_me`]),
  }),
]);

/**
 * Why a capability is missing, in words an operator can act on.
 *
 * "Unavailable" tells nobody anything. Each of these names the thing to change:
 * switch agent, open the panel, grant the permission.
 */
function unavailableBecause(capability, engine, gates) {
  if (!capability.engines.includes(engine)) {
    /* Short enough to survive the column it is drawn in.
       An earlier draft read "Codex does not get this — Claude Code only", which
       is a better sentence and a worse label: the menu truncated it to "Codex
       does not ..." and told the operator nothing at all. The full sentence
       lives in `detail`, which the row carries as its tooltip. */
    return `${capability.engines.map((id) => AGENTS[id]?.label ?? id).join(" / ")} only`;
  }
  if (capability.gate === "video" && !gates.video) return "Cut panel closed";
  if (capability.gate === "screen" && !gates.screen) return "Accessibility not granted";
  return null;
}

/**
 * What this app will attach to the next turn on this engine.
 *
 * Synchronous and cheap: two booleans and a table walk. The gates are passed in
 * rather than read here so that the caller — which already computes both for
 * the turn itself — hands the inventory the same answers the turn will get,
 * and the menu can never claim a tool the turn then withholds.
 */
export function studioInventory(engine, { video = false, screen = false } = {}) {
  return STUDIO_CAPABILITIES.map((capability) => {
    const reason = unavailableBecause(capability, engine, { video, screen });
    return {
      id: capability.id,
      server: capability.server,
      label: capability.label,
      detail: capability.detail,
      tools: [...capability.tools],
      available: reason === null,
      reason,
    };
  });
}

/** Run a probe and hand back its stdout, or null if it failed or took too long. */
function probe(bin, args, env) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnCommand(bin, args, { env, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolvePromise(null);
      return;
    }
    let out = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? out : null));
  });
}

/** JSON, or null — a probe that returns prose instead of JSON is a failed probe. */
function parseJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `claude mcp list`, which is the one probe of the four with no `--json`.
 *
 * Its lines read `<name>: <target> - <status>`, and both halves of that are
 * more slippery than they look. A name may itself contain colons
 * (`plugin:cloudflare:cloudflare-api`), so the split is on the first colon
 * *followed by a space* rather than the first colon; a target may contain
 * `://`, which is why that distinction matters. The status is taken from the
 * last ` - ` so a target containing a dash survives.
 *
 * Anything that does not match is skipped rather than guessed at — the command
 * also prints a header line and blank lines.
 */
export function parseClaudeMcpList(text) {
  if (typeof text !== "string") return [];
  const servers = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const split = line.indexOf(": ");
    if (split <= 0) continue;
    const name = line.slice(0, split).trim();
    let rest = line.slice(split + 2).trim();
    if (!name || !rest) continue;
    let status = null;
    const dash = rest.lastIndexOf(" - ");
    if (dash > 0) {
      status = rest.slice(dash + 3).trim();
      rest = rest.slice(0, dash).trim();
    }
    servers.push({
      name,
      /* The transport, when the line volunteers it, e.g. "(HTTP)". */
      transport: /\((\w+)\)\s*$/.exec(rest)?.[1]?.toLowerCase() ?? (/^https?:/.test(rest) ? "http" : "stdio"),
      /* `✔ Connected`, `! Needs authentication`, `⏸ Pending approval`. The mark
         is dropped; the words are what an operator reads. */
      status: status ? status.replace(/^[^\p{L}]+/u, "").trim() || null : null,
      enabled: status ? !/^\s*[^\p{L}]*(failed|error)/i.test(status) : true,
    });
  }
  return servers;
}

/** `codex mcp list --json` — an array of configured servers. Env is dropped. */
export function parseCodexMcpList(json) {
  if (!Array.isArray(json)) return [];
  return json
    .filter((entry) => entry && typeof entry.name === "string")
    .map((entry) => ({
      name: entry.name,
      transport: typeof entry.transport?.type === "string" ? entry.transport.type : "stdio",
      status: entry.enabled === false
        ? (typeof entry.disabled_reason === "string" && entry.disabled_reason) || "disabled"
        : typeof entry.auth_status === "string" && entry.auth_status !== "unsupported"
          ? entry.auth_status
          : null,
      enabled: entry.enabled !== false,
    }));
}

/** `claude plugin list --json` — an array of installed plugins. */
export function parseClaudePlugins(json) {
  if (!Array.isArray(json)) return [];
  return json
    .filter((entry) => entry && typeof entry.id === "string")
    .map((entry) => ({
      name: entry.id,
      version: typeof entry.version === "string" ? entry.version : null,
      enabled: entry.enabled !== false,
      /* A plugin can carry MCP servers of its own, and those are tools the
         agent will really have. Counted, not listed: they already appear by
         name in the server list above. */
      servers: entry.mcpServers && typeof entry.mcpServers === "object"
        ? Object.keys(entry.mcpServers).length
        : 0,
    }));
}

/** `codex plugin list --json` — `{ installed: [...] }`. */
export function parseCodexPlugins(json) {
  const installed = Array.isArray(json?.installed) ? json.installed : [];
  return installed
    .filter((entry) => entry && (typeof entry.pluginId === "string" || typeof entry.name === "string"))
    .map((entry) => ({
      name: typeof entry.pluginId === "string" ? entry.pluginId : entry.name,
      version: typeof entry.version === "string" ? entry.version : null,
      enabled: entry.enabled !== false && entry.installed !== false,
      servers: 0,
    }));
}

const PROBES = Object.freeze({
  claude: {
    mcp: { args: ["mcp", "list"], parse: (text) => parseClaudeMcpList(text) },
    plugins: { args: ["plugin", "list", "--json"], parse: (text) => parseClaudePlugins(parseJson(text)) },
  },
  codex: {
    mcp: { args: ["mcp", "list", "--json"], parse: (text) => parseCodexMcpList(parseJson(text)) },
    plugins: { args: ["plugin", "list", "--json"], parse: (text) => parseCodexPlugins(parseJson(text)) },
  },
});

const cache = new Map();

/** Drop everything remembered. Exported for the tests, and for a forced reload. */
export function clearInventoryCache() {
  cache.clear();
}

/**
 * Everything the agent brings, assembled.
 *
 * The two CLI probes run together and neither can sink the call: a binary that
 * is missing, hangs or answers in a shape we do not recognise yields `null` for
 * that section, which the renderer draws as "could not be read" rather than as
 * an empty list. An empty list is a claim — *you have no plugins* — and we are
 * only entitled to make it when the CLI actually said so.
 */
export async function agentInventory(engine, {
  env = agentEnvironment(),
  video = null,
  screen = false,
  now = Date.now(),
  ttlMs = INVENTORY_TTL_MS,
} = {}) {
  const agent = AGENTS[engine];
  if (!agent) throw new Error("UNKNOWN_AGENT_ENGINE");

  const videoOpen = video === null ? Boolean(videoBridgeEndpoint(env)) : Boolean(video);

  /* Only the CLI halves are cached. The studio half is two booleans and a table
     walk, and it is exactly the half that must never be stale — the Cut panel
     can open between one menu and the next. */
  const key = `${engine}`;
  const hit = cache.get(key);
  let cli = hit && now - hit.at < ttlMs ? hit.cli : null;

  if (!cli) {
    const spec = PROBES[engine];
    const [mcpText, pluginText] = await Promise.all([
      probe(agent.bin, spec.mcp.args, env),
      probe(agent.bin, spec.plugins.args, env),
    ]);
    cli = {
      mcp: mcpText === null ? null : spec.mcp.parse(mcpText),
      plugins: pluginText === null ? null : spec.plugins.parse(pluginText),
    };
    cache.set(key, { at: now, cli });
  }

  return {
    engine,
    label: agent.label,
    studio: studioInventory(engine, { video: videoOpen, screen }),
    mcp: cli.mcp,
    plugins: cli.plugins,
    /* Named so the renderer can say why the list is short, instead of leaving
       the operator to wonder whether they really have no slash commands. */
    unlisted: ["slash commands"],
  };
}
