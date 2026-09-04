/*
  The video project format, asserted where it is declared more than once.

  `VIDEO_PROJECT_KIND` has one canonical home — `src/video/project/format.ts` —
  and two unavoidable echoes: `server/projects.js`, which classifies recent
  projects and is Node ESM on the other side of the renderer bundle, and
  `electron/videoProjects.cjs`, which names the file it writes. Neither can
  import the canonical one.

  A shared module would be better than a guard, and was tried: the three
  consumers are a Vite/TS renderer, an ESM gateway and a CJS main process, and
  the only file all three can load at runtime in a PACKAGED app is one that
  ships in each bundle — which is the duplication again, with an import in
  front of it. So the constants are declared where they are used and this test
  is what keeps them one constant.

  The classification behaviour below is measured against real directories, not
  asserted from the shape of the code.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  classifyProject,
  listRecentProjects,
  rememberProject,
  VIDEO_PROJECT_FILE,
  VIDEO_PROJECT_KIND,
} from "../server/projects.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, "..", ...parts), "utf8");

/* ── The constant is one constant ─────────────────────────────────────────── */

test("the renderer's marker is the marker the gateway classifies against", () => {
  const format = read("src", "video", "project", "format.ts");
  const declared = /export const VIDEO_PROJECT_KIND = '([^']+)';/.exec(format);
  assert.ok(declared, "format.ts no longer declares VIDEO_PROJECT_KIND as a string literal");
  assert.equal(
    declared[1],
    VIDEO_PROJECT_KIND,
    "format.ts and server/projects.js disagree about what makes a directory a video project",
  );
});

test("the renderer's file name is the file the transport writes", () => {
  const format = read("src", "video", "project", "format.ts");
  const declared = /export const VIDEO_PROJECT_FILE = '([^']+)';/.exec(format);
  assert.ok(declared, "format.ts no longer declares VIDEO_PROJECT_FILE as a string literal");
  assert.equal(declared[1], VIDEO_PROJECT_FILE);

  const transport = read("electron", "videoProjects.cjs");
  const written = /const PROJECT_FILE = "([^"]+)";/.exec(transport);
  assert.ok(written, "videoProjects.cjs no longer names the file it writes");
  assert.equal(written[1], declared[1], "the editor saves one file name and the transport writes another");
});

/* ── Classification, against real directories ─────────────────────────────── */

let root;

test.before(async () => {
  root = await mkdtemp(join(tmpdir(), "teminali-vp-"));
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

const makeDir = async (name, contents) => {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  if (contents !== undefined) await writeFile(join(dir, VIDEO_PROJECT_FILE), contents, "utf8");
  return dir;
};

test("a directory holding the marker classifies as video", async () => {
  const dir = await makeDir("saved", JSON.stringify({ kind: VIDEO_PROJECT_KIND, version: 1, tracks: [] }, null, 2));
  assert.equal(await classifyProject(dir), "video");
});

test("a project.json that is not ours classifies as code", async () => {
  const dir = await makeDir("npm-ish", JSON.stringify({ name: "some-package", version: "1.0.0" }));
  assert.equal(await classifyProject(dir), "code");
});

test("a directory with no project.json classifies as code", async () => {
  assert.equal(await classifyProject(await makeDir("plain")), "code");
});

test("a path that does not exist classifies as code rather than throwing", async () => {
  // One deleted project must not empty the whole recent list.
  assert.equal(await classifyProject(join(root, "deleted")), "code");
});

test("the marker is only looked for in the head of the file", async () => {
  /*
    The documented limit of the 4KB probe, asserted so it cannot change by
    accident. `serializeProject` writes `kind` first, so this shape is not one
    the app produces — but a hand-edited file could, and the answer it gets
    should be the one the comment in projects.js promises.
  */
  const padded = `{\n  "note": "${"x".repeat(5000)}",\n  "kind": "${VIDEO_PROJECT_KIND}"\n}`;
  assert.equal(await classifyProject(await makeDir("padded", padded)), "code");
});

/* ── The recent list carries the kind ─────────────────────────────────────── */

test("remembering a video project records it as video, and listing agrees", async () => {
  const store = join(root, "store", "projects.json");
  const video = await makeDir("timeline", JSON.stringify({ kind: VIDEO_PROJECT_KIND, version: 1, tracks: [] }));
  const code = await makeDir("repo");

  await rememberProject(store, { path: code, name: "repo" });
  const afterBoth = await rememberProject(store, { path: video, name: "timeline" });

  assert.deepEqual(
    afterBoth.map((entry) => [entry.name, entry.kind]),
    [["timeline", "video"], ["repo", "code"]],
    "the most recent project comes first and each carries its kind",
  );

  const listed = await listRecentProjects(store);
  assert.deepEqual(listed.map((entry) => entry.kind), ["video", "code"]);
});

test("a stored kind is re-read from disk rather than trusted", async () => {
  /*
    A project can stop being a video project between two sessions. The store is
    a cache of names and times; the marker file is the truth.
  */
  const store = join(root, "stale", "projects.json");
  const dir = await makeDir("was-video");
  await mkdir(dirname(store), { recursive: true });
  await writeFile(
    store,
    JSON.stringify({ recent: [{ path: dir, name: "was-video", kind: "video" }] }),
    "utf8",
  );

  const listed = await listRecentProjects(store);
  assert.equal(listed[0].kind, "code", "a stale stored kind survived a list");
});

test("a project whose folder is gone is dropped from the listing but kept in the store", async () => {
  /*
    Deleting or moving a project folder used to leave a row that stayed
    clickable forever, and clicking it reported "Projects are unavailable" —
    list-wide wording for a single dead entry.

    The store keeps it deliberately. A project on an unmounted volume is
    missing rather than deleted, and pruning the file would forget it for good;
    filtering the response lets it come back when the volume does.
  */
  const store = join(root, "gone", "projects.json");
  const alive = await makeDir("still-here");
  const doomed = await makeDir("deleted-later");

  await rememberProject(store, { path: alive, name: "still-here" });
  await rememberProject(store, { path: doomed, name: "deleted-later" });

  assert.deepEqual(
    (await listRecentProjects(store)).map((entry) => entry.name),
    ["deleted-later", "still-here"],
    "both projects should list while both folders exist",
  );

  await rm(doomed, { recursive: true, force: true });

  assert.deepEqual(
    (await listRecentProjects(store)).map((entry) => entry.name),
    ["still-here"],
    "a project whose folder is gone still listed",
  );

  const stored = JSON.parse(readFileSync(store, "utf8"));
  assert.deepEqual(
    stored.recent.map((entry) => entry.name),
    ["deleted-later", "still-here"],
    "the listing rewrote the store instead of just filtering its response",
  );
});

/* ── The route that remembers without switching ───────────────────────────── */

test("the gateway remembers a video project without rebinding the workspace", () => {
  /*
    The trap this feature had to avoid: `/api/workspace/open` sets
    `config.workspaceRoot`, which bounds every workspace and terminal route.
    Opening a timeline must not repoint the file tree at the folder holding it.
    Asserted by reading the route body, because the alternative — booting a
    gateway — is what the rest of this suite deliberately does not do here.
  */
  const gateway = read("server", "gateway.js");
  const start = gateway.indexOf('route === "/api/workspace/projects/remember"');
  assert.ok(start > 0, "the gateway has no remember-without-switching route");

  const body = gateway.slice(start, gateway.indexOf("replyJson", start));
  assert.doesNotMatch(body, /config\.workspaceRoot\s*=/, "the remember route rebinds the workspace root");
  assert.match(body, /rememberProject\(/, "the remember route does not record the project");
});
