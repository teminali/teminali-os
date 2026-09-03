/**
 * The media approval gate, end to end under plain Node.
 *
 * These are the ten tests `src/video/P3-import-gate.md` owes, in its own
 * order. The first seven drive the real gate: `createMediaConsentGate` is
 * React-free and does no I/O of its own — path resolution is injected —
 * which is exactly what makes the real policy testable here rather than
 * only in a running Electron window. Node 26 strips the types on import,
 * the way `tests/video-tool-calls.test.mjs` already does.
 *
 * The last three are about the surface the bridge advertises, and are
 * assertions over source in the style of `tests/video-mcp-bridge.test.mjs`:
 * `toolRegistry.ts` imports the timeline store through extensionless
 * specifiers that plain Node cannot resolve, so the file is read rather
 * than imported.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  createMediaConsentGate,
  CONSENT_DEADLINE_MS,
  MEDIA_EXTENSIONS,
  LUT_EXTENSIONS,
} from "../src/services/mediaConsent.ts";

/* ── Harness ──────────────────────────────────────────────────────────────── */

const HOME = "/home/op";
const USER_DATA = "/home/op/Library/Application Support/Teminali Code";
const POLICY = { home: HOME, userData: USER_DATA };

/**
 * A gate with a fake filesystem underneath it.
 *
 * `links` is what main's `resolveRealPath` would return: `..` collapsed and
 * symlinks followed. Anything not listed resolves to itself, which is the
 * ordinary case of an already-real absolute path.
 */
function gateWith({ links = {}, deadlineMs = 5_000 } = {}) {
  const audit = [];
  const gate = createMediaConsentGate({
    policy: POLICY,
    resolve: async (p) => links[p] ?? p,
    deadlineMs,
    audit: (entry) => audit.push(entry),
  });
  return { gate, audit };
}

/** Subscribes and records every prompt actually raised. */
function watch(gate) {
  const prompts = [];
  const stop = gate.subscribe((pending) => { if (pending) prompts.push(pending); });
  return { prompts, stop, last: () => prompts[prompts.length - 1] };
}

const read = (name) => ({ path: name, accepts: MEDIA_EXTENSIONS });

const call = (paths, extra = {}) => ({
  tool: "import_media_from_path",
  agentName: "Agent CLI over MCP",
  capabilities: ["read-path"],
  paths,
  ...extra,
});

/** Yields until the microtasks inside `request` have run up to the prompt. */
const settleMicrotasks = () => new Promise((r) => setTimeout(r, 5));

/* ── 1. Grants ────────────────────────────────────────────────────────────── */

test("an ungranted path raises a prompt; the granted path does not", async () => {
  const { gate, audit } = gateWith();
  const seen = watch(gate);

  const first = gate.request(call([read("/vault/shoot/a.mp4")]));
  await settleMicrotasks();

  assert.equal(seen.prompts.length, 1, "an ungranted path must ask");
  assert.deepEqual(seen.last().resolved, ["/vault/shoot/a.mp4"]);
  // The prompt offers the containing folder, because the folder you took one
  // clip out of is the folder the rest of the shoot is in.
  assert.deepEqual(seen.last().folders, ["/vault/shoot"]);

  gate.answer("folder");
  const verdict = await first;
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.reason, "prompt");
  assert.equal(gate.pending(), null, "the prompt comes down when it is answered");

  // A sibling in the granted folder is not a second question.
  const second = await gate.request(call([read("/vault/shoot/b.mov")]));
  assert.equal(second.allowed, true);
  assert.equal(second.reason, "session-folder");
  assert.equal(seen.prompts.length, 1, "a granted root must not ask again");

  // Spawn is a different question at a different scope: allowed paths do not
  // buy ffmpeg, and ffmpeg is bought once for the session.
  const spawn = { ...call([read("/vault/shoot/b.mov")]), tool: "ffmpeg_process", capabilities: ["read-path", "spawn"] };
  const third = gate.request(spawn);
  await settleMicrotasks();
  assert.equal(seen.prompts.length, 2, "spawn is asked even where the path is granted");
  gate.answer("file");
  assert.equal((await third).allowed, true);

  const fourth = await gate.request(spawn);
  assert.equal(fourth.allowed, true);
  assert.equal(fourth.reason, "session-spawn");
  assert.equal(seen.prompts.length, 2, "ffmpeg is asked about once per session");

  // Every decision is on the record, allowed ones included: "the agent
  // imported something odd" has no answer unless you know which grant let it.
  assert.deepEqual(audit.map((e) => e.reason), ["prompt", "session-folder", "prompt", "session-spawn"]);
  assert.ok(audit.every((e) => e.agentName === "Agent CLI over MCP"));

  seen.stop();
});

/* ── 2. The deny list ─────────────────────────────────────────────────────── */

test("the deny list refuses inside a granted root", async () => {
  const { gate } = gateWith();
  const seen = watch(gate);

  // The widest grant a gesture can produce: the operator's home itself.
  gate.grantRoot(`${HOME}/clip.mp4`, "picker");
  assert.ok(gate.granted().includes(HOME), "a picked file grants its folder too");

  const cases = [
    [`${HOME}/.ssh/id_rsa.mp4`, /SSH keys/],
    [`${HOME}/.aws/credentials.mp4`, /AWS credentials/],
    [`${HOME}/.gnupg/secring.mp4`, /GnuPG keys/],
    [`${HOME}/Library/Keychains/login.mp4`, /the macOS keychain/],
    [`${USER_DATA}/state.mp4`, /Teminali Code's own state/],
    // Not a named root: the dotfile rule is about the path, so a folder of
    // footage that happens to hold a .env did not make the .env footage.
    [`${HOME}/.env.mp4`, /a hidden file or folder \(\.env\.mp4\)/],
  ];

  for (const [path, expected] of cases) {
    const verdict = await gate.request(call([read(path)]));
    assert.equal(verdict.allowed, false, `${path} must be refused`);
    assert.equal(verdict.reason, "deny-list");
    assert.match(verdict.message, expected);
    assert.match(verdict.message, /not something a grant can cover/);
  }

  assert.equal(seen.prompts.length, 0, "a question whose only right answer is no is not asked");
  seen.stop();
});

/* ── 3. The extension rule ────────────────────────────────────────────────── */

test("a non-media extension is refused with no prompt raised", async () => {
  const { gate } = gateWith();
  const seen = watch(gate);

  const refused = await gate.request(call([read("/vault/passwords.txt")]));
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "not-media");
  assert.match(refused.message, /is not a media file/);
  assert.match(refused.message, /Accepted here: mp4, mov/);

  // The honest answer to import_media_from_path('/etc/passwd') is "that is
  // not media" — an extensionless file has no accepted extension at all.
  assert.equal((await gate.request(call([read("/etc/passwd")]))).reason, "not-media");

  // `accepts` is per argument, not one global media list: ffmpeg's lutPath is
  // a real read of a real .cube sidecar, and a media-only rule would leave the
  // `lut` operation permanently dead.
  const lut = { path: "/vault/looks/kodak.cube", accepts: LUT_EXTENSIONS };
  const wrongForLut = await gate.request(call([{ path: "/vault/looks/kodak.mp4", accepts: LUT_EXTENSIONS }]));
  assert.equal(wrongForLut.reason, "not-media");
  assert.match(wrongForLut.message, /is not a \.cube LUT/);

  assert.equal(seen.prompts.length, 0, "nothing above got as far as asking");

  // And the .cube itself gets through the rule to the question.
  const asked = gate.request(call([lut]));
  await settleMicrotasks();
  assert.equal(seen.prompts.length, 1);
  gate.cancel();
  assert.equal((await asked).allowed, false);

  seen.stop();
});

/* ── 4. Resolution ────────────────────────────────────────────────────────── */

test("every check is against the resolved path, not the requested one", async () => {
  const { gate } = gateWith({
    links: {
      // `..` back out of a granted folder and into a denied one.
      [`${HOME}/Footage/../.ssh/id_rsa.mp4`]: `${HOME}/.ssh/id_rsa.mp4`,
      // A symlink sitting inside a granted folder, pointing outside it.
      [`${HOME}/Footage/link.mp4`]: "/vault/secret.mp4",
      // A relative path, which main resolves against the project folder.
      "second.mp4": `${HOME}/Footage/second.mp4`,
    },
  });
  const seen = watch(gate);

  gate.grantRoot(`${HOME}/Footage/first.mp4`, "picker");

  const traversed = await gate.request(call([read(`${HOME}/Footage/../.ssh/id_rsa.mp4`)]));
  assert.equal(traversed.reason, "deny-list", "the grant does not survive a `..`");
  assert.equal(traversed.subject, `${HOME}/.ssh/id_rsa.mp4`, "the verdict names the real path");
  assert.equal(seen.prompts.length, 0);

  const linked = gate.request(call([read(`${HOME}/Footage/link.mp4`)]));
  await settleMicrotasks();
  assert.equal(seen.prompts.length, 1, "a symlink out of a granted root is still a question");
  // A gate that validates one path and shows another is worse than no gate.
  assert.deepEqual(seen.last().resolved, ["/vault/secret.mp4"]);
  gate.cancel();
  assert.equal((await linked).allowed, false);

  const relative = await gate.request(call([read("second.mp4")]));
  assert.equal(relative.allowed, true, "resolving inside a granted root needs no prompt");
  assert.equal(relative.subject, `${HOME}/Footage/second.mp4`);
  assert.equal(seen.prompts.length, 1);

  seen.stop();
});

/* ── 5. Nobody to ask ─────────────────────────────────────────────────────── */

test("no subscriber is an immediate denial, not a deadline", async () => {
  const { gate } = gateWith({ deadlineMs: 5_000 });

  const started = Date.now();
  const verdict = await gate.request(call([read("/vault/a.mp4")]));
  const elapsed = Date.now() - started;

  assert.equal(verdict.allowed, false, "a gate that cannot ask must not grant");
  assert.equal(verdict.reason, "no-ui");
  assert.match(verdict.message, /nothing is available to ask the operator/);
  assert.ok(elapsed < 1_000, `answered in ${elapsed}ms; it must not wait out the deadline`);

  // The last subscriber leaving mid-prompt is the same situation, and must not
  // leave the caller waiting on a question nobody can see any more.
  const seen = watch(gate);
  const orphaned = gate.request(call([read("/vault/b.mp4")]));
  await settleMicrotasks();
  assert.equal(seen.prompts.length, 1);
  seen.stop();
  assert.equal((await orphaned).reason, "no-ui");
});

/* ── 6. The deadline ──────────────────────────────────────────────────────── */

test("the prompt deadline settles as a denial, and the call is answered", async () => {
  const { gate, audit } = gateWith({ deadlineMs: 60 });
  const seen = watch(gate);

  // Nobody answers. A blocked call must not become a wedged CLI.
  const verdict = await gate.request(call([read("/vault/a.mp4")]));

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "deadline");
  // "Denied" alone cannot tell an operator who said no from a prompt that
  // timed out unseen, and those are the two failures with different fixes.
  assert.match(verdict.message, /Nobody answered the permission prompt/);
  assert.match(verdict.message, /may not have been at the machine/);
  assert.equal(gate.pending(), null, "the prompt comes down with it");
  assert.deepEqual(audit.map((e) => e.reason), ["deadline"]);
  assert.equal(seen.prompts.length, 1);

  // 90s is a human deadline, not the bridge's 20s default for in-memory writes.
  assert.equal(CONSENT_DEADLINE_MS, 90_000);

  seen.stop();
});

/* ── 7. Two prompts at once ───────────────────────────────────────────────── */

test("a second prompt denies the first rather than dropping its resolver", async () => {
  const { gate } = gateWith();
  const seen = watch(gate);

  const first = gate.request(call([read("/vault/a.mp4")]));
  await settleMicrotasks();
  const second = gate.request(call([read("/vault/b.mp4")]));
  await settleMicrotasks();

  // The first agent's turn must not stall on a question that is no longer
  // on screen — the invariant `createApprovalGate` already holds.
  const firstVerdict = await first;
  assert.equal(firstVerdict.allowed, false);
  assert.equal(firstVerdict.reason, "superseded");
  assert.equal(firstVerdict.subject, "/vault/a.mp4");

  assert.equal(seen.prompts.length, 2);
  assert.deepEqual(gate.pending().resolved, ["/vault/b.mp4"], "the visible prompt is the second one");

  gate.answer("file");
  const secondVerdict = await second;
  assert.equal(secondVerdict.allowed, true);
  assert.equal(secondVerdict.reason, "prompt");

  // The grant is the file, not the folder, when that is what was answered.
  assert.deepEqual(gate.granted(), ["/vault/b.mp4"]);
  gate.reset();
  assert.deepEqual(gate.granted(), []);

  seen.stop();
});

/* ── The surface the bridge advertises ────────────────────────────────────── */

const registry = await fs.promises.readFile(new URL("../src/video/mcp/toolRegistry.ts", import.meta.url), "utf8");
const bridge = await fs.promises.readFile(new URL("../src/services/videoToolBridge.ts", import.meta.url), "utf8");

const exposed = [...registry.match(/export const EXPOSED_TOOLS[\s\S]*?\];/)[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

/** Each `defineTool({ ... })` header, up to its handler. */
const declared = registry.split(/defineTool\(\{/).slice(1).map((block) => {
  const head = block.slice(0, block.indexOf("handler:") === -1 ? block.length : block.indexOf("handler:"));
  return {
    name: head.match(/name: '([a-z_]+)'/)?.[1],
    consent: /\n {2}consent: \[/.test(head),
    consentPaths: /\n {2}consentPaths:/.test(head),
  };
});

/* ── 8. custom ────────────────────────────────────────────────────────────── */

test('operation "custom" is refused over MCP and accepted in-process', () => {
  // A raw filtergraph is a small programming language pointed at the
  // operator's machine. The panel's own chat is a different trust boundary,
  // so `custom` stays defined and callable there.
  assert.match(registry, /'reverse', 'speed', 'lut', 'extract_audio', 'custom',/);
  assert.match(registry, /const EXPOSED_OPERATIONS = FFMPEG_OPERATIONS\.filter\(\(op\) => op !== 'custom'\)/);
  assert.match(registry, /exposedSchema: z\.object\(\{ \.\.\.ffmpegShape, operation: z\.enum\(EXPOSED_OPERATIONS\) \}\)/);

  // The narrowed schema is what an outside caller is validated against …
  assert.match(registry, /const schema = options\.external \? tool\.exposedSchema \?\? tool\.schema : tool\.schema;/);
  // … it is what the manifest advertises …
  assert.match(registry, /inputSchema: zodToJsonSchema\(t\.exposedSchema \?\? t\.schema\)/);
  // … and the bridge is the only caller that sets the flag.
  assert.match(bridge, /executeTool\(name, args, AGENT_NAME, \{ external: true \}\)/);
  assert.ok(!/external: true/.test(registry), "nothing inside the registry may mark itself external");

  // Consent is decided on the same narrowed schema, so a field no exposed
  // operation reads cannot smuggle a path past the gate.
  assert.match(bridge, /\(tool\.exposedSchema \?\? tool\.schema\)\.safeParse/);
});

/* ── 9. Nothing advertised without its gate ───────────────────────────────── */

test("the manifest does not list a consent tool that has no gate wired", () => {
  const manifest = registry.match(/export function getToolManifest[\s\S]*?\n\}/)[0];
  assert.match(manifest, /KERF_TOOLS\.filter\(\(t\) => isExposed\(t\.name\)\)/);

  // A tool that declares consent must also say what it will touch, or the
  // gate would ask about a call and grant nothing — allowing it forever after.
  for (const tool of declared.filter((t) => t.consent)) {
    assert.ok(tool.consentPaths, `${tool.name} declares consent but no consentPaths`);
  }

  // The bridge is the wiring, and it is the only place it can be: the CLI's
  // own permission model is already spent (`--allowedTools mcp__cut` names the
  // server, so every tool it serves is pre-approved).
  assert.match(bridge, /if \(tool\?\.consent\?\.length\) \{/);
  assert.match(bridge, /const verdict = await gate\.request\(\{/);
  assert.match(bridge, /if \(!verdict\.allowed\) \{/);

  // Order matters: the allowlist first, so an un-advertised tool is refused
  // without asking the operator about a call that was never going to run.
  assert.ok(
    bridge.indexOf("if (!isExposed(name))") < bridge.indexOf("if (tool?.consent?.length)"),
    "the exposure check must come before the gate",
  );
  // And the gate before the work, so the call blocks while a person decides.
  assert.ok(
    bridge.indexOf("const verdict = await gate.request({") < bridge.indexOf("await executeTool("),
    "consent must be resolved before the tool runs",
  );
});

/* ── 10. Nothing joins the list unreviewed ────────────────────────────────── */

test("nothing joins EXPOSED_TOOLS without declaring what it touches", () => {
  const budget = Number(registry.match(/export const TOOL_BUDGET = (\d+);/)[1]);
  assert.ok(exposed.length <= budget, `${exposed.length} exposed against a budget of ${budget}`);

  // The gated surface, named. This assertion is meant to fail when the list
  // changes: a new tool that reads a path needs its `consent` declaration and
  // a line here, and a tool that loses `consent` needs someone to say why.
  const gated = declared.filter((t) => t.consent && exposed.includes(t.name)).map((t) => t.name);
  assert.deepEqual(gated.sort(), ["ffmpeg_process", "import_media_from_path"]);

  // Both are exposed, so the gate is on the path that is actually reachable
  // from outside this renderer rather than on a tool nobody can call.
  for (const name of gated) assert.ok(exposed.includes(name), `${name} is gated but not exposed`);

  // list_media_pool is the deliberate exception, and the reason the other two
  // are usable at all: it reads a pool the operator already imported.
  assert.ok(exposed.includes("list_media_pool"));
  assert.equal(declared.find((t) => t.name === "list_media_pool").consent, false);
});
