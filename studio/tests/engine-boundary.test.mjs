import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative) => readFile(new URL(`../src/services/${relative}`, import.meta.url), "utf8");

function importsOf(source) {
  return [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
}

/**
 * The whole point of the split is that you can tell where a capability comes
 * from. These tests fail the moment that stops being true.
 */

test("the model engine imports no host or editor capability", async () => {
  const engine = await read("frontierEngine.ts");
  const forbidden = [
    "./terminalService",     // running commands is the host's job
    "./workspaceService",    // reading and writing files is the host's job
    "./liveEditService",     // Monaco playback is editor machinery
    "./mcpRemoteSyncService" // a host integration, not model engineering
  ];
  const imported = importsOf(engine);
  for (const module of forbidden) {
    assert.equal(imported.includes(module), false, `frontierEngine must not import ${module}`);
  }
  // Nor may it reach into UI.
  assert.equal(imported.some((module) => module.includes("components/")), false, "engine must not import components");
  // Nor into the ported editor. The engine knows there are tools, not that
  // they edit video: `videoToolCalls` is a protocol, `src/video/` is the app.
  assert.equal(imported.some((module) => module.includes("/video/")), false, "engine must not import the editor");
});

test("the engine receives execution as an injected capability", async () => {
  const engine = await read("frontierEngine.ts");
  assert.match(engine, /export interface EngineCapabilities/);
  assert.match(engine, /runCommand\?:/);
  // It calls the injected handler, never a concrete transport.
  assert.match(engine, /execute: capabilities\.runCommand/);
  assert.equal(/TerminalService/.test(engine), false, "engine must not name a transport");
});

test("the engine degrades to no-shell rather than assuming one exists", async () => {
  const engine = await read("frontierEngine.ts");
  // A headless caller supplies no capabilities; the agent loop must skip
  // execution instead of throwing or pretending a command ran.
  // Matched without the closing paren so the loop may add budget conditions,
  // while `capabilities.runCommand` must remain the first thing guarding it.
  assert.match(engine, /if \(capabilities\.runCommand && hasExecutableCommands\(turnText\)/);
});

test("the engine degrades to no-editor rather than assuming one exists", async () => {
  const engine = await read("frontierEngine.ts");
  // A headless caller supplies no capabilities, so the tool branch must be
  // guarded by the injected executor before anything else.
  assert.match(engine, /if \(capabilities\.runVideoTool && hasVideoToolCalls\(turnText\)/);
  // And the prompt must not advertise tools the host did not hand over.
  assert.match(engine, /if \(capabilities\.videoTools && capabilities\.videoTools\.length > 0\)/);
});

test("the host adapter supplies capabilities and owns host integrations", async () => {
  const adapter = await read("aiService.ts");
  // The boundary being tested is that the *host* supplies capabilities, not the
  // shape it supplies them in. It became a factory so the benchmark arena can
  // hand the same engine a sandbox directory to work in; a module-level
  // singleton could only ever point at one place.
  assert.match(adapter, /function studioCapabilities\([^)]*\): EngineCapabilities/);
  assert.match(adapter, /runCommand: \(command, options\) =>\s*TerminalService\.run/);
  // The editor is a host integration too, and since P2 it is the one that
  // matters: the engine is handed an executor, and only the host imports the
  // tools it runs. Asserted on the import, not on a mention, so a comment
  // naming the module cannot satisfy it.
  assert.match(adapter, /^import \{ executeTool, getToolManifest \} from "\.\.\/video\/mcp\/toolRegistry";$/m,
    "the editor tool registry belongs to the host");
  assert.match(adapter, /runVideoTool: \(tool, args\) => executeTool/);
  // Model engineering must not have leaked back in.
  assert.equal(/streamFromOllama|resolveModelMode|keep_alive/.test(adapter), false,
    "model streaming must stay in the engine");
});

test("routing stays independent of both", async () => {
  const runner = await readFile(new URL("../../gateway/frontier-runner.js", import.meta.url), "utf8");
  const imported = importsOf(runner);
  assert.equal(imported.some((module) => /studio|editor|terminal/i.test(module)), false,
    "the router must not depend on the editor");
  assert.match(runner, /selectProfileForMode/);
});
