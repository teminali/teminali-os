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
  // And the prompt must not advertise tools the host did not hand over: the
  // engine passes exactly what it was given, and the composition gates on it.
  assert.match(engine, /videoTools: capabilities\.videoTools,/);
  const prompt = await read("systemPrompt.ts");
  assert.match(prompt, /if \(input\.videoTools && input\.videoTools\.length > 0\)/);
});

test("the host adapter supplies capabilities and owns host integrations", async () => {
  const adapter = await read("aiService.ts");
  // The boundary being tested is that the *host* supplies capabilities, not the
  // shape it supplies them in. It became a factory so the benchmark arena can
  // hand the same engine a sandbox directory to work in; a module-level
  // singleton could only ever point at one place.
  // `[\s\S]` rather than `.`: the parameter list is multi-line once the host
  // supplies more than a couple of capabilities, and the claim being pinned is
  // that the adapter builds them — not how the signature is wrapped.
  assert.match(adapter, /function studioCapabilities\([\s\S]*?\): EngineCapabilities/);
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

test("an agent CLI turn from the chat can move the workspace it is talking about", async () => {
  // The gateway wires `reveal` and `open_project` for every agent turn, but a
  // tool whose event nobody subscribes to is worse than an absent one: the
  // model is told it worked. The chat had `onPermission` and neither of these,
  // so opening a project from chat became eleven steps of driving the app's
  // own UI by pointer, ending in "I can't tell whether that switched the
  // workspace". Asserted on the adapter forwarding them and on the chat
  // supplying them, because either half alone is still silence.
  const adapter = await read("aiService.ts");
  assert.match(adapter, /onWorkspace: options\.onWorkspace/);
  assert.match(adapter, /onEdit: options\.onEdit/);

  const chat = await readFile(new URL("../src/components/chat/StudioChat.tsx", import.meta.url), "utf8");
  assert.match(chat, /onWorkspace: \(event\) =>/, "the chat must subscribe to workspace events");
  assert.match(chat, /store\.revealPath\(event\.path\)/);
  assert.match(chat, /store\.setWorkspacePath\(event\.path\)/);
  assert.match(chat, /onEdit: \(event\) =>/, "an agent edit from the chat must reach the review dock");
});

test("routing stays independent of both", async () => {
  const runner = await readFile(new URL("../../gateway/frontier-runner.js", import.meta.url), "utf8");
  const imported = importsOf(runner);
  assert.equal(imported.some((module) => /studio|editor|terminal/i.test(module)), false,
    "the router must not depend on the editor");
  assert.match(runner, /selectProfileForMode/);
});
