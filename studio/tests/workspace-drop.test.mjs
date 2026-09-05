import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WORKSPACE_PATH_MIME,
  containingFolder,
  describesWorkspaceDrop,
  resolveWorkspaceDrop,
  workspaceRelative,
} from "../src/services/workspaceDrop.ts";
import { guardDragOver, guardDrop } from "../src/services/dropGuard.ts";

/**
 * What a dropped file means.
 *
 * The rule these pin is the operator's, and it is a boundary rule: a file from
 * outside the project is never read across the workspace guard. It becomes an
 * offer to switch the project to the folder that holds it, which is the same
 * road a My Projects click takes.
 */

const ROOT = "/Users/x/projects/site";

/** A stand-in for `DataTransfer`, carrying only what the resolver reads. */
function transfer({ types = [], data = {}, files = [], directories = [] } = {}) {
  return {
    types,
    getData: (format) => data[format] ?? "",
    files,
    items: files.map((_, index) => ({
      webkitGetAsEntry: () => ({ isDirectory: directories.includes(index) }),
    })),
  };
}

/* ── The path arithmetic ──────────────────────────────────────────────────── */

test("a path under the root becomes workspace-relative", () => {
  assert.equal(workspaceRelative(`${ROOT}/src/app.ts`, ROOT), "src/app.ts");
  assert.equal(workspaceRelative(`${ROOT}/README.md`, ROOT), "README.md");
});

test("a sibling whose name merely starts with the root is not inside it", () => {
  // The bug this exists to prevent: `/site-old` reading as a file in `/site`,
  // which would hand the workspace guard a path it must then refuse.
  assert.equal(workspaceRelative("/Users/x/projects/site-old/app.ts", ROOT), null);
});

test("the root itself is not a file the pane can open", () => {
  assert.equal(workspaceRelative(ROOT, ROOT), null);
  assert.equal(workspaceRelative(`${ROOT}/`, ROOT), null);
});

test("a trailing slash on either side does not change the answer", () => {
  assert.equal(workspaceRelative(`${ROOT}/src/app.ts`, `${ROOT}/`), "src/app.ts");
});

test("windows separators compare equal to posix ones", () => {
  assert.equal(workspaceRelative("C:\\work\\site\\src\\app.ts", "C:\\work\\site"), "src/app.ts");
});

test("the containing folder is what an outside drop offers", () => {
  assert.equal(containingFolder("/Users/x/Downloads/notes.txt"), "/Users/x/Downloads");
  assert.equal(containingFolder("/notes.txt"), "/");
});

/* ── Telling the two sources apart ────────────────────────────────────────── */

test("an Explorer row is recognised by its private type, not by text/plain", () => {
  assert.equal(describesWorkspaceDrop([WORKSPACE_PATH_MIME]), true);
  assert.equal(describesWorkspaceDrop(["Files"]), true);
  // A filename dragged out of a text editor is text and nothing else, and must
  // not light the pane up as though it were one of our own rows.
  assert.equal(describesWorkspaceDrop(["text/plain"]), false);
  assert.equal(describesWorkspaceDrop(undefined), false);
});

test("an internal drop opens its path with no bridge at all", () => {
  const outcome = resolveWorkspaceDrop(
    transfer({ types: [WORKSPACE_PATH_MIME, "text/plain"], data: { [WORKSPACE_PATH_MIME]: "src/app.ts" } }),
    { root: ROOT },
  );
  assert.deepEqual(outcome, { kind: "open", paths: ["src/app.ts"], skipped: 0 });
});

/* ── Finder drops ─────────────────────────────────────────────────────────── */

test("a Finder file inside the root opens as a relative path", () => {
  const outcome = resolveWorkspaceDrop(transfer({ types: ["Files"], files: ["f"] }), {
    root: ROOT,
    getPathForFile: () => `${ROOT}/src/app.ts`,
  });
  assert.deepEqual(outcome, { kind: "open", paths: ["src/app.ts"], skipped: 0 });
});

test("a Finder file outside the root offers its folder as the project — it is never read across", () => {
  const outcome = resolveWorkspaceDrop(transfer({ types: ["Files"], files: ["f"] }), {
    root: ROOT,
    getPathForFile: () => "/Users/x/Downloads/notes.txt",
  });
  assert.deepEqual(outcome, { kind: "switch", folder: "/Users/x/Downloads", file: "notes.txt" });
});

test("a dropped folder is offered directly, because a folder is a project", () => {
  const outcome = resolveWorkspaceDrop(transfer({ types: ["Files"], files: ["d"], directories: [0] }), {
    root: ROOT,
    getPathForFile: () => "/Users/x/projects/other",
  });
  assert.deepEqual(outcome, { kind: "switch", folder: "/Users/x/projects/other", file: null });
});

test("dropping the current project onto itself is a no-op, not an offer", () => {
  const outcome = resolveWorkspaceDrop(transfer({ types: ["Files"], files: ["d"], directories: [0] }), {
    root: ROOT,
    getPathForFile: () => ROOT,
  });
  assert.equal(outcome, null);
});

test("what this project already contains wins over switching away from it", () => {
  // Switching would close the very tree the inside file came from, so a mixed
  // drop opens what it can and counts the rest rather than moving the project.
  const paths = [`${ROOT}/src/app.ts`, "/Users/x/Downloads/notes.txt"];
  const outcome = resolveWorkspaceDrop(transfer({ types: ["Files"], files: ["a", "b"] }), {
    root: ROOT,
    getPathForFile: (file) => paths[["a", "b"].indexOf(file)],
  });
  assert.deepEqual(outcome, { kind: "open", paths: ["src/app.ts"], skipped: 1 });
});

test("without the desktop bridge the external half says so instead of throwing", () => {
  const outcome = resolveWorkspaceDrop(transfer({ types: ["Files"], files: ["f"] }), { root: ROOT });
  assert.equal(outcome?.kind, "unavailable");
  assert.match(outcome.reason, /desktop app/i);
});

test("a drag carrying nothing droppable resolves to nothing", () => {
  assert.equal(resolveWorkspaceDrop(transfer({ types: ["text/plain"] }), { root: ROOT }), null);
});

/* ── The window guard ─────────────────────────────────────────────────────── */

test("an unclaimed drag is refused where the pointer can see it", () => {
  // Chromium's default for an unclaimed drop is to navigate to the file, which
  // in Electron replaces the whole app and reads as a crash to a blank page.
  let prevented = false;
  const event = { defaultPrevented: false, preventDefault: () => { prevented = true; }, dataTransfer: { dropEffect: "copy" } };
  guardDragOver(event);
  assert.equal(prevented, true);
  assert.equal(event.dataTransfer.dropEffect, "none");
});

test("a drag a real drop zone already claimed is left completely alone", () => {
  // The composer, the media panel, the timeline and the file pane all accept a
  // dragover by calling preventDefault; overriding dropEffect here would stop
  // Chromium delivering their drop event at all.
  let prevented = false;
  const event = { defaultPrevented: true, preventDefault: () => { prevented = true; }, dataTransfer: { dropEffect: "copy" } };
  guardDragOver(event);
  guardDrop(event);
  assert.equal(prevented, false);
  assert.equal(event.dataTransfer.dropEffect, "copy");
});

/* ── The two ends of the wire ─────────────────────────────────────────────── */

test("the Explorer sets the private type, and only files are draggable", async () => {
  const source = await readFile(new URL("../src/components/sidebar/FileTree.tsx", import.meta.url), "utf8");
  assert.match(source, /setData\(WORKSPACE_PATH_MIME, item\.path\)/);
  assert.match(source, /draggable=\{!isDirectory\}/, "a folder must not be draggable");
});

test("the file pane accepts the dragover it needs, or no drop is ever delivered", async () => {
  const source = await readFile(new URL("../src/components/workspace/panels/FilePane.tsx", import.meta.url), "utf8");
  assert.match(source, /onDragOver=/);
  assert.match(source, /onDrop=\{handleDrop\}/);
  // The switch goes through the project route, never through a file read.
  assert.match(source, /WorkspaceService\.openProject\(offer\.folder\)/);
});

test("the guard is armed at boot, for every surface this bundle serves", async () => {
  const source = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(source, /installWindowDropGuard\(\)/);
});
