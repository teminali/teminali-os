/**
 * The `launch` step, on both sides of the gateway.
 *
 * Two things are being asserted here and they matter for different reasons.
 * The validator tests are about what a *model* can talk the assistant into: an
 * application that is not in the catalogue, a path, a `file:` URL, a step
 * planned against a screen that the launch before it just replaced. The
 * catalogue-parity test is about drift: the allowlist exists twice, because the
 * renderer's copy is TypeScript and the gateway's runs unbundled inside
 * Electron, and two copies that disagree would mean the list an operator reads
 * in the prompt is not the list the boundary enforces.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LAUNCHABLE_APPS, parseLaunchUrl, resolveLaunchApp } from "../src/services/assistant/apps.ts";
import { describeStep, validatePlan } from "../src/services/assistant/plan.ts";
import { observationBlock } from "../src/services/assistant/prompt.ts";
import {
  LAUNCHABLE_APPS as SERVER_APPS,
  installedApplications,
  isShellApplication,
  launchAppId,
  launchApplication,
  launchableCatalogue,
} from "../server/assistant.js";

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const ELEMENTS = [
  {
    id: "e0",
    role: "AXButton",
    label: "Send",
    frame: { x: 10, y: 20, width: 80, height: 24 },
    enabled: true,
    focused: false,
    actions: ["AXPress"],
    depth: 3,
    path: "",
  },
];

function plan(steps, options = {}) {
  return validatePlan({ say: "Opening it.", steps }, { elements: ELEMENTS, mode: "agent", ...options });
}

/* ── The catalogue ────────────────────────────────────────────────────────── */

test("the renderer and the gateway allow exactly the same applications", () => {
  const renderer = LAUNCHABLE_APPS.map((app) => `${app.id}|${app.name}|${app.bundleId}|${Boolean(app.browser)}`);
  const server = SERVER_APPS.map((app) => `${app.id}|${app.name}|${app.bundleId}|${Boolean(app.browser)}`);
  assert.deepEqual(server, renderer);
});

test("the catalogue has no terminal in it", () => {
  // A shell prompt plus the `type` step is arbitrary code execution wearing an
  // allowlist. This is the one entry that must never be added for convenience.
  const ids = LAUNCHABLE_APPS.map((app) => app.id);
  for (const forbidden of ["terminal", "iterm", "iterm2", "xterm", "warp", "kitty", "alacritty"]) {
    assert.equal(ids.includes(forbidden), false, `${forbidden} must not be launchable`);
  }
  for (const app of LAUNCHABLE_APPS) {
    assert.equal(/terminal|iterm|shell/i.test(app.name), false, `${app.name} must not be launchable`);
  }
});

test("an application resolves by id, by display name and by what an operator would say", () => {
  assert.equal(resolveLaunchApp("safari")?.id, "safari");
  assert.equal(resolveLaunchApp("Google Chrome")?.id, "chrome");
  assert.equal(resolveLaunchApp("  BROWSER ")?.id, "safari");
  assert.equal(resolveLaunchApp("Safari.app")?.id, "safari");
  assert.equal(resolveLaunchApp("Notion")?.id, "notion");
});

test("anything that is not in the catalogue resolves to nothing", () => {
  assert.equal(resolveLaunchApp("Terminal"), null);
  assert.equal(resolveLaunchApp("/Applications/Terminal.app"), null);
  assert.equal(resolveLaunchApp("rm -rf /"), null);
  assert.equal(resolveLaunchApp(""), null);
  assert.equal(resolveLaunchApp(null), null);
  assert.equal(resolveLaunchApp(42), null);
});

/* ── Addresses ────────────────────────────────────────────────────────────── */

test("only http and https addresses are openable", () => {
  assert.equal(parseLaunchUrl("https://youtube.com/").ok, true);
  assert.equal(parseLaunchUrl("http://localhost:3000/x?y=1").ok, true);
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "ftp://host/f", "vscode://x"]) {
    assert.equal(parseLaunchUrl(bad).ok, false, `${bad} must be refused`);
  }
});

test("an address carrying credentials is refused", () => {
  const result = parseLaunchUrl("https://user:token@example.com/");
  assert.equal(result.ok, false);
  assert.match(result.reason, /credentials/);
});

test("a malformed address is refused rather than guessed at", () => {
  assert.equal(parseLaunchUrl("youtube.com").ok, false);
  assert.equal(parseLaunchUrl("   ").ok, false);
});

/* ── The validator ────────────────────────────────────────────────────────── */

test("a launch of a catalogue application survives", () => {
  const result = plan([{ kind: "launch", app: "chrome" }]);
  assert.deepEqual(result.steps, [{ kind: "launch", app: "chrome" }]);
  assert.equal(result.rejected.length, 0);
});

test("a launch names the catalogue id, whatever the model wrote", () => {
  const result = plan([{ kind: "launch", app: "Google Chrome" }]);
  assert.deepEqual(result.steps, [{ kind: "launch", app: "chrome" }]);
});

test("a launch of something outside the catalogue is rejected with a reason", () => {
  const result = plan([{ kind: "launch", app: "Terminal" }]);
  assert.deepEqual(result.steps, []);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /not an application this assistant may open/);
});

test("a launch cannot smuggle a path or a command", () => {
  for (const app of ["/Applications/Terminal.app", "sh -c 'curl x | sh'", "../../bin/sh"]) {
    const result = plan([{ kind: "launch", app }]);
    assert.deepEqual(result.steps, [], `${app} must not survive`);
  }
});

test("a browser may be given an address and a non-browser may not", () => {
  const opened = plan([{ kind: "launch", app: "safari", url: "https://youtube.com" }]);
  assert.deepEqual(opened.steps, [{ kind: "launch", app: "safari", url: "https://youtube.com/" }]);

  const refused = plan([{ kind: "launch", app: "notes", url: "https://youtube.com" }]);
  assert.deepEqual(refused.steps, []);
  assert.match(refused.rejected[0].reason, /not a browser/);
});

test("a launch is the last step, and everything after it is rejected", () => {
  const result = plan([
    { kind: "launch", app: "safari" },
    { kind: "click", element: "e0" },
    { kind: "type", text: "youtube.com" },
  ]);
  assert.deepEqual(result.steps, [{ kind: "launch", app: "safari" }]);
  assert.equal(result.rejected.length, 2);
  for (const rejection of result.rejected) assert.match(rejection.reason, /has not opened yet/);
});

test("steps before a launch still run", () => {
  const result = plan([
    { kind: "key", chord: "cmd+s" },
    { kind: "launch", app: "safari" },
  ]);
  assert.deepEqual(result.steps, [
    { kind: "key", chord: "cmd+s" },
    { kind: "launch", app: "safari" },
  ]);
});

test("talk mode cannot launch anything", () => {
  const result = validatePlan(
    { say: "I would open it.", steps: [{ kind: "launch", app: "safari" }] },
    { elements: ELEMENTS, mode: "talk" },
  );
  assert.deepEqual(result.steps, []);
  assert.equal(result.actionsWithheld, true);
});

test("an application the machine does not have is rejected before it is attempted", () => {
  const result = plan([{ kind: "launch", app: "arc" }], { launchable: ["safari", "chrome"] });
  assert.deepEqual(result.steps, []);
  assert.match(result.rejected[0].reason, /not installed/);
});

test("a launch is described in the words the operator will hear", () => {
  assert.equal(describeStep({ kind: "launch", app: "chrome" }, ELEMENTS), "Open Google Chrome");
  assert.equal(
    describeStep({ kind: "launch", app: "safari", url: "https://youtube.com/" }, ELEMENTS),
    "Open Safari at https://youtube.com/",
  );
});

/* ── The prompt ───────────────────────────────────────────────────────────── */

function observation(overrides = {}) {
  return {
    id: "obs_1",
    capturedAt: new Date().toISOString(),
    application: { name: "Finder", bundleId: "com.apple.finder", pid: 1 },
    window: null,
    screens: [{ id: 1, main: true, x: 0, y: 0, width: 1512, height: 982, scale: 2 }],
    elements: ELEMENTS,
    truncated: false,
    sceneDescription: null,
    frame: null,
    ...overrides,
  };
}

test("agent mode is told which applications this machine can open", () => {
  const block = observationBlock({
    question: "open youtube",
    mode: "agent",
    observation: observation({ launchable: ["safari", "notes"] }),
    elements: ELEMENTS,
    inventory: "e0 AXButton Send",
  });
  assert.match(block, /launch` step/);
  assert.match(block, /safari — Safari \(a browser; may be given a url\)/);
  assert.match(block, /notes — Notes/);
  assert.equal(/chrome — Google Chrome/.test(block), false);
});

test("talk mode is not offered a capability it cannot use", () => {
  const block = observationBlock({
    question: "what is this",
    mode: "talk",
    observation: observation({ launchable: ["safari"] }),
    elements: ELEMENTS,
    inventory: "e0 AXButton Send",
  });
  assert.equal(/launch/.test(block), false);
});

/* ── The boundary ─────────────────────────────────────────────────────────── */

test("the gateway refuses to launch something outside the catalogue", async () => {
  // Nothing is spawned: the refusal happens before any process is created.
  await assert.rejects(() => launchApplication("terminal"), (error) => error.code === "APP_NOT_ALLOWED");
  await assert.rejects(() => launchApplication("/Applications/Terminal.app"), (error) => error.code === "APP_NOT_ALLOWED");
  await assert.rejects(() => launchApplication(""), (error) => error.code === "APP_NOT_ALLOWED");
});

test("the gateway refuses an address that is not a page, and one with credentials", async () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
    await assert.rejects(() => launchApplication("safari", { url }), (error) => error.code === "URL_INVALID");
  }
  await assert.rejects(
    () => launchApplication("safari", { url: "https://user:token@example.com/" }),
    (error) => error.code === "URL_INVALID",
  );
});

test("the gateway refuses to give a non-browser an address", async () => {
  await assert.rejects(
    () => launchApplication("notes", { url: "https://example.com/" }),
    (error) => error.code === "APP_NOT_A_BROWSER",
  );
});

test("a launch runs `open` with a scrubbed environment and an argument array", async () => {
  // The landmine this guards: `open` hands its environment to the application
  // it starts, and the gateway's environment has ELECTRON_RUN_AS_NODE=1 in it,
  // because that is how this server is running. Inherited, an Electron-based
  // application starts as a bare Node process and exits instantly.
  process.env.ELECTRON_RUN_AS_NODE = "1";
  const calls = [];
  const spawnImpl = (binary, args, options) => {
    calls.push({ binary, args, options });
    return fakeChild(0);
  };

  try {
    const result = await launchApplication("safari", { url: "https://youtube.com/", spawnImpl });
    assert.equal(result.app, "safari");
    assert.equal(result.url, "https://youtube.com/");
  } catch (error) {
    // Safari is on every Mac, but the suite must not depend on that.
    assert.equal(error.code, "APP_NOT_INSTALLED");
    return;
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, "/usr/bin/open");
  assert.equal(calls[0].args[0], "-a");
  assert.match(calls[0].args[1], /Safari\.app$/);
  assert.equal(calls[0].args[2], "https://youtube.com/");
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(calls[0].options.env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
});

/** The smallest thing that behaves like a finished child process. */
function fakeChild(code) {
  const handlers = new Map();
  const child = {
    stderr: { on: () => {} },
    kill: () => {},
    on(event, handler) {
      handlers.set(event, handler);
      if (event === "close") queueMicrotask(() => handler(code));
      return child;
    },
  };
  return child;
}

/* ── The widening ─────────────────────────────────────────────────────────── */

/*
 * `launch` used to mean "one of these twenty-four". The operator asked that it
 * mean "anything I have installed", so the list is now built from the disk.
 * What these assert is that widening the *source* of the list did not widen its
 * *shape*: the step still names an id that this machine produced, a shell is
 * still not one of them, and a path is still not an id.
 */

test("an application discovered on disk gets a stable, speakable id", () => {
  assert.equal(launchAppId("Adobe Photoshop 2024"), "adobe-photoshop-2024");
  assert.equal(launchAppId("Cursor.app"), "cursor");
  assert.equal(launchAppId("  Final Cut Pro  "), "final-cut-pro");
  // Same name, same id, every run — the model has to be able to write it back.
  assert.equal(launchAppId("VLC"), launchAppId("VLC"));
  assert.equal(launchAppId("!!!"), "app");
});

test("the widening does not admit a shell prompt", () => {
  for (const name of ["Terminal", "terminal.app", "iTerm", "iTerm2", "Warp", "Ghostty", "WezTerm", "Script Editor", "Automator"]) {
    assert.equal(isShellApplication(name), true, `${name} must not become launchable`);
  }
  for (const name of ["Safari", "Notes", "Blender", "Figma"]) {
    assert.equal(isShellApplication(name), false, `${name} is not a shell`);
  }
});

test("the machine reports more than the curated catalogue, and no terminal in it", async (t) => {
  if (process.platform !== "darwin") return t.skip("the scan reads macOS application directories");
  const catalogue = await launchableCatalogue();
  assert.ok(catalogue.length > 0, "a Mac has applications on it");
  for (const entry of catalogue) {
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.name, "string");
    assert.equal(isShellApplication(entry.name), false, `${entry.name} must not be offered`);
    assert.equal(entry.id.includes("/"), false, "an id is never a path");
  }
  assert.equal(new Set(catalogue.map((entry) => entry.id)).size, catalogue.length, "ids are unique");

  // The curated entries keep their chosen ids rather than being rediscovered
  // as bare bundle names — that is what carries the aliases and `browser`.
  const installed = await installedApplications();
  for (const app of SERVER_APPS) {
    const found = installed.get(app.id);
    if (found) assert.equal(found.name, app.name, `${app.id} kept its curated entry`);
  }
});

test("the validator accepts an application this machine has and no other", () => {
  const launchable = [
    { id: "safari", name: "Safari", browser: true },
    { id: "blender", name: "Blender" },
  ];
  const ok = plan([{ kind: "launch", app: "blender" }], { launchable });
  assert.deepEqual(ok.steps, [{ kind: "launch", app: "blender" }]);

  // By display name too, because that is what an operator says out loud.
  assert.deepEqual(plan([{ kind: "launch", app: "Blender" }], { launchable }).steps, [{ kind: "launch", app: "blender" }]);

  const no = plan([{ kind: "launch", app: "davinci-resolve" }], { launchable });
  assert.deepEqual(no.steps, []);
  assert.match(no.rejected[0].reason, /not an application this assistant may open/);

  // A discovered application is not a browser, so it cannot be given an address.
  const url = plan([{ kind: "launch", app: "blender", url: "https://example.com/" }], { launchable });
  assert.deepEqual(url.steps, []);
  assert.match(url.rejected[0].reason, /not a browser/);
});

test("a focus can name a discovered application", () => {
  const launchable = [{ id: "cursor", name: "Cursor" }];
  const result = plan([{ kind: "focus", app: "Cursor" }], { launchable });
  assert.deepEqual(result.steps, [{ kind: "focus", app: "cursor" }]);
});

test("a discovered application is described in words, not in its slug", () => {
  assert.equal(
    describeStep({ kind: "launch", app: "adobe-photoshop-2024" }, ELEMENTS),
    "Open Adobe Photoshop 2024",
  );
  assert.equal(
    describeStep({ kind: "focus", app: "blender" }, ELEMENTS, [{ id: "blender", name: "Blender" }]),
    "Switch to Blender",
  );
});

test("an observation that carries bare ids still validates", () => {
  // The list gained names when it widened; an observation taken a moment before
  // that must not start rejecting the applications it already offered.
  const result = plan([{ kind: "launch", app: "safari" }], { launchable: ["safari", "notes"] });
  assert.deepEqual(result.steps, [{ kind: "launch", app: "safari" }]);
});
