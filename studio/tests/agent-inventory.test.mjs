import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STUDIO_CAPABILITIES,
  agentInventory,
  clearInventoryCache,
  parseClaudeMcpList,
  parseClaudePlugins,
  parseCodexMcpList,
  parseCodexPlugins,
  studioInventory,
} from "../server/agent-inventory.js";

import { videoMcpArgs } from "../server/video-mcp.js";
import { permissionMcpArgs } from "../server/permission-mcp.js";
import { screenMcpArgs } from "../server/screen-mcp.js";
import { workspaceMcpArgs } from "../server/workspace-mcp.js";
import { cameraMcpArgs } from "../server/camera-mcp.js";

/**
 * The inventory tells the operator which tools a turn will have. Everything
 * here exists to stop it saying something the turn then contradicts.
 *
 * The fixtures are real output, captured from `claude` 2.1.263 and `codex-cli`
 * 0.149.1 on the machine this was written on. They are not invented shapes:
 * the parsers only have to survive what these binaries actually print, and the
 * traps below — a server name containing colons, a status containing a word
 * that looks like a failure — are traps the real output actually set.
 */

const RUN = "11111111-2222-3333-4444-555555555555";
const TOKEN = "probe-token";

/* ── The anti-drift test ────────────────────────────────────────────────────
   STUDIO_CAPABILITIES mirrors predicates that live in five other modules. The
   builders cannot be called from the inventory itself — four of them write a
   0600 spec file keyed by a run id — so they are called here instead, for real,
   into a throwaway directory, and the table is checked against what came back.

   This is the test that fails when someone teaches screen-mcp.js about Codex
   and forgets that the menu is still telling operators it is Claude-only.
   ────────────────────────────────────────────────────────────────────────── */
test("the capability table agrees with the argv builders it mirrors", () => {
  const dir = mkdtempSync(join(tmpdir(), "inventory-drift-"));
  const options = { tmpDir: dir, execPath: process.execPath, port: 4319 };
  /* A token in the env is the one route to a bridge that needs no running app. */
  const env = { TEMINALI_VIDEO_RPC_TOKEN: "t", TEMINALI_VIDEO_RPC_PORT: "4319" };

  const built = {
    video: (engine) => videoMcpArgs(engine, { ...options, env }).length > 0,
    screen: (engine) => screenMcpArgs(engine, RUN, TOKEN, { ...options, available: true }).args.length > 0,
    workspace: (engine) => workspaceMcpArgs(engine, RUN, TOKEN, options).args.length > 0,
    camera: (engine) => cameraMcpArgs(engine, RUN, TOKEN, options).args.length > 0,
  };

  for (const capability of STUDIO_CAPABILITIES) {
    const check = built[capability.id];
    if (!check) continue;
    for (const engine of ["claude", "codex"]) {
      assert.equal(
        check(engine),
        capability.engines.includes(engine),
        `${capability.id}: the table says ${engine} ${capability.engines.includes(engine) ? "does" : "does not"} get this, `
          + `but ${capability.id}-mcp.js ${check(engine) ? "does" : "does not"} build args for it`,
      );
    }
  }

  /* The approval bridge takes no engine argument: its gate is the `runToken`
     line in agent-cli.js, which is where this one has to be read from. Asserted
     as a predicate rather than as a whole line so that reformatting does not
     break it, but narrowly enough that widening the gate to Codex does. */
  assert.ok(permissionMcpArgs(RUN, TOKEN, options).args.length > 0, "the approval bridge builds args when given a run");
  const source = readFileSync(fileURLToPath(new URL("../server/agent-cli.js", import.meta.url)), "utf8");
  assert.match(
    source,
    /runToken\s*=\s*engine === "claude" && runId/,
    "agent-cli.js no longer gates the approval bridge on Claude alone — STUDIO_CAPABILITIES.approvals must be updated to match",
  );
});

test("Codex is reported as losing the four Claude-only capabilities", () => {
  const codex = studioInventory("codex", { video: true, screen: true });
  const unavailable = codex.filter((entry) => !entry.available).map((entry) => entry.id);
  assert.deepEqual(unavailable.sort(), ["approvals", "camera", "screen", "workspace"]);
  /* Every refusal names the thing to change; "unavailable" helps nobody. It
     also has to fit the column it is drawn in — the first draft read "Codex
     does not get this — Claude Code only" and the menu truncated it to "Codex
     does not ...", which is the same as saying nothing. */
  for (const entry of codex.filter((item) => !item.available)) {
    assert.equal(entry.reason, "Claude Code only");
    assert.ok(entry.reason.length <= 24, `"${entry.reason}" will truncate in the menu`);
  }
  assert.equal(codex.find((entry) => entry.id === "video").available, true);
});

test("a closed Cut panel and an ungranted screen each explain themselves", () => {
  const claude = studioInventory("claude", { video: false, screen: false });
  const byId = Object.fromEntries(claude.map((entry) => [entry.id, entry]));
  assert.equal(byId.video.available, false);
  assert.match(byId.video.reason, /Cut panel closed/);
  assert.equal(byId.screen.available, false);
  assert.match(byId.screen.reason, /Accessibility not granted/);
  /* The three with no environmental gate are unaffected by either. */
  assert.equal(byId.approvals.available, true);
  assert.equal(byId.workspace.available, true);
  assert.equal(byId.camera.available, true);
});

/* ── The parsers, against real output ───────────────────────────────────── */

const CLAUDE_MCP_FIXTURE = `Checking MCP server health…

claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected
plugin:cloudflare:cloudflare-api: https://mcp.cloudflare.com/mcp (HTTP) - ! Needs authentication
local-thing: /usr/local/bin/thing --serve - ✔ Connected
`;

test("claude mcp list survives names that contain colons", () => {
  const servers = parseClaudeMcpList(CLAUDE_MCP_FIXTURE);
  assert.deepEqual(servers.map((entry) => entry.name), [
    "claude.ai Google Drive",
    "plugin:cloudflare:cloudflare-api",
    "local-thing",
  ]);
  /* Splitting on the first colon rather than the first ": " turns that middle
     name into "plugin" and the target into nonsense. That is the bug this
     fixture exists to catch. */
  assert.equal(servers[1].transport, "http");
  assert.equal(servers[1].status, "Needs authentication");
  assert.equal(servers[0].status, "Connected", "the status mark is dropped, the words are kept");
  assert.equal(servers[2].transport, "stdio");
  /* A command containing a dash must not be mistaken for the status separator. */
  assert.equal(servers[2].status, "Connected");
});

test("claude mcp list ignores the header and blank lines rather than guessing", () => {
  assert.deepEqual(parseClaudeMcpList("Checking MCP server health…\n\n"), []);
  assert.deepEqual(parseClaudeMcpList(""), []);
  assert.deepEqual(parseClaudeMcpList(null), []);
});

test("codex mcp list reports disabled servers and never carries env values", () => {
  const servers = parseCodexMcpList([
    {
      name: "computer-use",
      enabled: false,
      disabled_reason: null,
      transport: { type: "stdio", command: "/x", env: { SECRET: "hunter2" }, env_vars: ["SECRET"] },
      auth_status: "unsupported",
    },
    {
      name: "node_repl",
      enabled: true,
      transport: { type: "stdio", command: "/y", env: { TOKEN: "sk-live-abcdef" } },
      auth_status: "unsupported",
    },
  ]);
  assert.equal(servers[0].enabled, false);
  assert.equal(servers[0].status, "disabled");
  assert.equal(servers[1].enabled, true);
  /* `codex mcp list` masks env in its table and prints it in full under
     --json. A config file's worth of secrets has no business reaching a menu,
     so nothing that leaves this parser may contain one. */
  const serialised = JSON.stringify(servers);
  assert.ok(!serialised.includes("hunter2"), "an env value reached the inventory");
  assert.ok(!serialised.includes("sk-live-abcdef"), "an env value reached the inventory");
  assert.ok(!serialised.includes("SECRET"), "an env name reached the inventory");
});

test("plugin lists are read from both CLIs' own JSON", () => {
  const claude = parseClaudePlugins([
    { id: "cloudflare@cloudflare", version: "1.0.0", enabled: true, mcpServers: { a: {}, b: {} } },
    { id: "off@local", version: null, enabled: false },
  ]);
  assert.deepEqual(claude[0], { name: "cloudflare@cloudflare", version: "1.0.0", enabled: true, servers: 2 });
  assert.equal(claude[1].enabled, false);
  assert.equal(claude[1].servers, 0);

  const codex = parseCodexPlugins({
    installed: [
      { pluginId: "documents@openai-primary-runtime", name: "documents", version: "26.904.11930", installed: true, enabled: true },
      { pluginId: "gone@x", name: "gone", version: "1", installed: false, enabled: true },
    ],
  });
  assert.equal(codex[0].name, "documents@openai-primary-runtime");
  assert.equal(codex[0].version, "26.904.11930");
  assert.equal(codex[1].enabled, false, "a plugin that is not installed is not enabled");
});

test("garbage from a CLI parses to nothing rather than throwing", () => {
  assert.deepEqual(parseCodexMcpList(null), []);
  assert.deepEqual(parseCodexMcpList({ nope: true }), []);
  assert.deepEqual(parseClaudePlugins("not json"), []);
  assert.deepEqual(parseCodexPlugins({}), []);
  assert.deepEqual(parseCodexPlugins(null), []);
});

/* ── The assembled call ─────────────────────────────────────────────────── */

test("a CLI that cannot be run yields null, which is not an empty list", async () => {
  clearInventoryCache();
  /* A bin that does not exist stands in for every way a probe can fail. The
     distinction being protected: null means "we could not read this", `[]`
     means the CLI said "none". Collapsing the two tells an operator they have
     no plugins when the truth is that we never asked successfully. */
  const inventory = await agentInventory("codex", {
    env: { PATH: mkdtempSync(join(tmpdir(), "inventory-empty-path-")) },
    video: false,
    screen: false,
  });
  assert.equal(inventory.mcp, null);
  assert.equal(inventory.plugins, null);
  /* The studio half needs no binary and must still be reported. */
  assert.equal(inventory.studio.length, STUDIO_CAPABILITIES.length);
  assert.equal(inventory.engine, "codex");
  assert.equal(inventory.label, "Codex");
  assert.deepEqual(inventory.unlisted, ["slash commands"]);
  clearInventoryCache();
});

test("an unknown engine is refused rather than half-answered", async () => {
  await assert.rejects(() => agentInventory("gemini"), /UNKNOWN_AGENT_ENGINE/);
});

test("the studio half is never served stale even when the CLI half is cached", async () => {
  clearInventoryCache();
  const env = { PATH: mkdtempSync(join(tmpdir(), "inventory-cache-path-")) };
  const closed = await agentInventory("claude", { env, video: false, screen: false });
  assert.equal(closed.studio.find((entry) => entry.id === "video").available, false);

  /* Same engine, inside the TTL, so the CLI probes are not re-run — but the Cut
     panel has opened since, and a menu that answers "no timeline" a second
     later is a menu the operator stops believing. */
  const open = await agentInventory("claude", { env, video: true, screen: true });
  assert.equal(open.studio.find((entry) => entry.id === "video").available, true);
  assert.equal(open.studio.find((entry) => entry.id === "screen").available, true);
  clearInventoryCache();
});
