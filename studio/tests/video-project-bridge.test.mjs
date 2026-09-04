/*
  The video project transport's wiring, asserted end to end across four files.

  Modelled on `recorder-bridge.test.mjs`, and for the same reason it exists:
  the recorder shipped with `screenRecorder.cjs`, its typed contract and its
  panel all individually correct, and the feature dead, because nothing in
  `main.cjs` required the module and `preload.cjs` never put the key on
  `window.teminali`. Saving a project is exactly as easy to ship dead — it has
  no visible symptom until an operator loses an edit.

  Nothing that reads a single file can catch that. These tests read all four
  and assert they agree.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const electron = (name) => readFileSync(join(here, "..", "electron", name), "utf8");

const transportSource = electron("videoProjects.cjs");
const preloadSource = electron("preload.cjs");
const mainSource = electron("main.cjs");

const matchAll = (text, pattern) => [...text.matchAll(pattern)].map((m) => m[1]);

const handled = new Set(matchAll(transportSource, /ipcMain\.handle\("(videoProject:[\w-]+)"/g));
const invoked = new Set(matchAll(preloadSource, /ipcRenderer\.invoke\("(videoProject:[\w-]+)"/g));

test("every video project handler is reachable from the renderer", () => {
  assert.ok(handled.size >= 5, `expected the transport's handlers, found ${handled.size}`);
  const unreachable = [...handled].filter((channel) => !invoked.has(channel));
  assert.deepEqual(unreachable, [], `no preload verb invokes: ${unreachable.join(", ")}`);
});

test("the preload invokes no channel the main process does not answer", () => {
  const unanswered = [...invoked].filter((channel) => !handled.has(channel));
  assert.deepEqual(unanswered, [], `no handler answers: ${unanswered.join(", ")}`);
});

test("main requires the transport and both starts and stops it", () => {
  assert.match(
    mainSource,
    /require\("\.\/videoProjects\.cjs"\)/,
    "main.cjs does not require videoProjects.cjs, so its handlers are never registered",
  );
  assert.match(mainSource, /initVideoProjects\(/, "main.cjs never calls initVideoProjects");
  assert.match(mainSource, /shutdownVideoProjects\(/, "main.cjs never calls shutdownVideoProjects");
});

test("the preload publishes videoProjects on window.teminali", () => {
  // The renderer reads exactly this key to decide whether saving is possible
  // at all; without it the desktop build is indistinguishable from a browser.
  assert.match(preloadSource, /^\s{2}videoProjects: \{/m, "no `videoProjects` key is exposed on window.teminali");
});

test("the typed bridge names every verb the preload exposes", () => {
  const contract = readFileSync(join(here, "..", "src", "types", "videoProjects.ts"), "utf8");
  const body = preloadSource.slice(preloadSource.indexOf("\n  videoProjects: {"));
  const verbs = new Set(matchAll(body.slice(0, body.indexOf("\n  },")), /^\s{4}(\w+):/gm));
  assert.ok(verbs.size >= 5, `expected the transport's verbs, found ${verbs.size}`);
  const untyped = [...verbs].filter((verb) => !new RegExp(`^\\s{2}${verb}:`, "m").test(contract));
  assert.deepEqual(untyped, [], `VideoProjectsBridge does not declare: ${untyped.join(", ")}`);
});

test("the transport writes project.json and nothing the caller named", () => {
  // The renderer supplies a directory, never a file name. A transport that
  // joined a caller-supplied name would be a write-anywhere primitive.
  assert.match(transportSource, /const PROJECT_FILE = "project\.json";/);
  assert.doesNotMatch(
    transportSource,
    /path\.join\([^)]*p\.(name|file|fileName)/,
    "the transport composes a path from caller input",
  );
});

/* ── The menu commands ──────────────────────────────────────────────────────
   Same failure mode one layer up. `main.cjs` can send a menu channel, the
   renderer can subscribe to it, and the command can still be dead because
   `preload.cjs` filters every channel through an allow-list — a channel that
   is not on it returns a no-op unsubscribe and says nothing.
   ───────────────────────────────────────────────────────────────────────── */

const appSource = readFileSync(join(here, "..", "src", "App.tsx"), "utf8");

const menuSent = new Set(matchAll(mainSource, /webContents\.send\("(menu:[\w-]*video-project)"/g));
const menuAllowed = new Set(matchAll(preloadSource, /^\s*"(menu:[\w-]+)",$/gm));

test("the video project menu items are on the preload's allow-list", () => {
  assert.deepEqual(
    [...menuSent].sort(),
    ["menu:open-video-project", "menu:save-video-project"],
    "the File menu no longer sends both video project commands",
  );
  const filtered = [...menuSent].filter((channel) => !menuAllowed.has(channel));
  assert.deepEqual(filtered, [], `preload.cjs drops: ${filtered.join(", ")}`);
});

test("the renderer subscribes to both video project menu commands", () => {
  const unheard = [...menuSent].filter((channel) => !appSource.includes(`"${channel}"`));
  assert.deepEqual(unheard, [], `nothing in App.tsx listens for: ${unheard.join(", ")}`);
});

test("no File menu accelerator steals a renderer shortcut", () => {
  // A menu accelerator is handled by the menu, so the keydown never reaches
  // the page: binding ⇧⌘O here would have silently killed the Codex panel.
  const shiftAt = appSource.indexOf("if (event.shiftKey) {");
  assert.notEqual(shiftAt, -1, "App.tsx has no shift-modified shortcut branch — this guard needs rewriting");
  const endAt = appSource.indexOf('window.addEventListener("keydown"', shiftAt);
  assert.notEqual(endAt, -1, "the keydown handler moved — this guard needs rewriting");
  const branch = appSource.slice(shiftAt, endAt);

  const claimed = new Set(matchAll(branch, /key === "([a-z])"/g));
  const tabRecord = /Record<string, SidebarTabId> = \{([^}]+)\}/.exec(branch);
  if (tabRecord) for (const letter of matchAll(tabRecord[1], /(\w):/g)) claimed.add(letter);
  assert.ok(claimed.size >= 10, `expected the renderer's shift shortcuts, found ${claimed.size}`);

  const menuShift = matchAll(mainSource, /accelerator: "Shift\+CmdOrCtrl\+([A-Za-z])"/g).map((k) =>
    k.toLowerCase(),
  );
  const stolen = menuShift.filter((letter) => claimed.has(letter));
  assert.deepEqual(stolen, [], `the menu takes ⇧⌘${stolen.join(", ⇧⌘").toUpperCase()} from App.tsx`);
});

test("the first save renames the project before it serialises it", () => {
  // Found by running the round trip: the file kept the sample's own name while
  // the folder and the recent list said "Untitled", so reopening handed the old
  // name straight back and the title bar disagreed with Finder — the exact
  // thing the rename exists to prevent. Renaming after the write only touches
  // the store, so the ordering is the fix and the ordering is what is guarded.
  const io = readFileSync(join(here, "..", "src", "video", "project", "io.ts"), "utf8");
  const rename = io.indexOf("setProjectName");
  const serialise = io.indexOf("serializeProject(state)");
  assert.notEqual(rename, -1, "saveVideoProject no longer renames the project");
  assert.notEqual(serialise, -1, "saveVideoProject no longer serialises state");
  assert.ok(
    rename < serialise,
    "setProjectName runs after serializeProject — the saved file keeps the pre-rename name",
  );
});
