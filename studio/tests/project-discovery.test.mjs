/*
  `discoverProjectFolders` is what makes a folder the operator has never opened
  reachable by a spoken name, and until this file it had no test of its own --
  it was exercised only through a live probe against the operator's own disk,
  which proves the answer on one machine on one day and pins nothing.

  What is pinned here is the shape of the scan, because every rule in it exists
  to keep something OUT of the candidate list. Each entry this returns is scored
  against a heard name on every voice turn, and anything that clears the 0.7
  floor can rebind the workspace root. A test that only checked that real
  folders are found would miss the half that matters.

  The fixtures are built in a temp directory rather than read from disk: the
  operator's machine is where this was measured, not where it is proved.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  DISCOVERY_ROOTS,
  MAX_DISCOVERED_FOLDERS,
  discoverProjectFolders,
} from "../server/projects.js";
import { ALLOWED_ROOTS, PROJECTS_ROOT } from "../src/services/voice/workspaceActions.ts";

/** A scratch tree. `realpath` because on macOS /var is a link to /private/var. */
async function scratch() {
  return realpath(await mkdtemp(join(tmpdir(), "discovery-")));
}

/** `dirs` become directories, `files` become empty files, both nested as given. */
async function build(base, { dirs = [], files = [] }) {
  for (const d of dirs) await mkdir(resolve(base, d), { recursive: true });
  for (const f of files) {
    await mkdir(resolve(base, f, ".."), { recursive: true });
    await writeFile(resolve(base, f), "", "utf8");
  }
  return base;
}

/** Paths relative to the scratch root, so assertions read like the fixture. */
const relative = (base, { folders }) => folders.map((f) => f.path.slice(base.length + 1));

test("a depth-1 root lists what is directly inside it and goes no further", async (t) => {
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, { dirs: ["downloads/a-film/season-one", "downloads/notes"] });

  const found = await discoverProjectFolders([{ path: join(base, "downloads"), depth: 1 }]);
  assert.deepEqual(relative(base, found), ["downloads/a-film", "downloads/notes"]);
  assert.equal(found.truncated, false);
});

test("a bare string root means depth 1, so an injected list needs no shape", async (t) => {
  // The exported constant carries a depth per root; a caller passing plain
  // paths -- which is every caller that is not `DISCOVERY_ROOTS` itself --
  // gets the conservative reading rather than an error.
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, { dirs: ["root/container/inner"] });

  assert.deepEqual(relative(base, await discoverProjectFolders([join(base, "root")])), [
    "root/container",
  ]);
});

test("a depth-2 root reaches the projects inside a container, which is the whole point", async (t) => {
  // The gap this closes: `my_projects/teminali/claude-context-guard` is a real
  // project the operator asked for by name, and one level deep it did not
  // exist as far as the voice lane was concerned.
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, {
    dirs: ["projects/teminali/context-guard", "projects/teminali/landing"],
    files: [
      "projects/teminali/context-guard/package.json",
      "projects/teminali/landing/.git/HEAD",
    ],
  });

  const found = relative(base, await discoverProjectFolders([{ path: join(base, "projects"), depth: 2 }]));
  assert.deepEqual(found, [
    "projects/teminali",
    "projects/teminali/context-guard",
    "projects/teminali/landing",
  ]);
});

test("below the top level, a directory must prove it is a project to be named", async (t) => {
  /*
    Measured on the operator's disk: depth 2 under `my_projects` finds 21
    directories, and only 12 are projects. The other nine are `build`, `docs`,
    `tests`, `tools`, `__pycache__` and a bare clone -- short generic names,
    which are exactly what a mis-transcription scores above the 0.7 floor.
    "open the tests folder" must not rebind the workspace root to some
    unrelated project's test directory, and the guard is here rather than in
    the scorer because a name that never enters the list cannot win.
  */
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, {
    dirs: ["projects/group/build", "projects/group/docs", "projects/group/the-app"],
    files: ["projects/group/the-app/package.json"],
  });

  const found = relative(base, await discoverProjectFolders([{ path: join(base, "projects"), depth: 2 }]));
  assert.deepEqual(found, ["projects/group", "projects/group/the-app"]);
});

test("the top level is listed whole, marker or not, because he put it there himself", async (t) => {
  // The asymmetry with the test above is deliberate. `argus-vpn-landing` is
  // three loose files in `my_projects` with no package.json and no repository,
  // and the operator still names it -- reaching it is what discovery was added
  // for. A level down is the inside of someone's folder and gets the stricter
  // rule.
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, { dirs: ["projects/loose-files"], files: ["projects/loose-files/index.html"] });

  assert.deepEqual(relative(base, await discoverProjectFolders([{ path: join(base, "projects"), depth: 2 }])), [
    "projects/loose-files",
  ]);
});

test("the descent stops at a project, so no source tree becomes a workspace root", async (t) => {
  // Every marker, one fixture each, because the set grew for a reason: the
  // operator's `xslm_project` is Python and was read as a container while the
  // list was JavaScript-only, which put its `tests` and `tools` in the list.
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, {
    dirs: ["projects/js-app/src", "projects/py-app/tests", "projects/rust-app/src", "projects/go-app/internal"],
    files: [
      "projects/js-app/package.json",
      "projects/py-app/pyproject.toml",
      "projects/rust-app/Cargo.toml",
      "projects/go-app/go.mod",
    ],
  });

  const found = relative(base, await discoverProjectFolders([{ path: join(base, "projects"), depth: 2 }]));
  assert.deepEqual(found, ["projects/go-app", "projects/js-app", "projects/py-app", "projects/rust-app"]);
  assert.equal(
    found.some((f) => /\/(src|tests|internal)$/.test(f)),
    false,
    "a project's own directories must never be candidates",
  );
});

test("requirements.txt marks a project too, since not every Python tree has a pyproject", async (t) => {
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, {
    dirs: ["projects/script-tool/tools"],
    files: ["projects/script-tool/requirements.txt"],
  });

  assert.deepEqual(relative(base, await discoverProjectFolders([{ path: join(base, "projects"), depth: 2 }])), [
    "projects/script-tool",
  ]);
});

test("dot-directories are the machine's business at every level", async (t) => {
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, {
    dirs: [".Trash", "group/.cache", "group/real-app"],
    files: ["group/real-app/package.json"],
  });

  const found = relative(base, await discoverProjectFolders([{ path: base, depth: 2 }]));
  assert.deepEqual(found, ["group", "group/real-app"]);
});

test("a symlink out of the root is refused at depth, not only at the top", async (t) => {
  /*
    `isInside` alone would not catch this: the link's own path is inside the
    root, its target is not. The check is against the ROOT of the scan rather
    than the parent directory, so a link two levels down cannot escape either.
  */
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, { dirs: ["outside/secrets", "root/group"], files: ["root/group/.git/HEAD"] });
  // A link at the top level and a link a level down, both pointing out.
  await symlink(join(base, "outside"), join(base, "root", "escape"));
  await symlink(join(base, "outside"), join(base, "root", "group", "escape"));

  const found = relative(base, await discoverProjectFolders([{ path: join(base, "root"), depth: 2 }]));
  assert.deepEqual(found, ["root/group"]);
});

test("a symlink that stays inside the root is followed to where it lands", async (t) => {
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, { dirs: ["root/real-project"], files: ["root/real-project/package.json"] });
  await symlink(join(base, "root", "real-project"), join(base, "root", "shortcut"));

  const found = await discoverProjectFolders([{ path: join(base, "root"), depth: 1 }]);
  // One entry, not two: the link resolves onto a path already seen.
  assert.deepEqual(relative(base, found), ["root/real-project"]);
});

test("a file is not a folder, and neither is a link to one", async (t) => {
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, { dirs: ["root/a-folder"], files: ["root/a-file.txt"] });
  await symlink(join(base, "root", "a-file.txt"), join(base, "root", "a-link"));

  assert.deepEqual(relative(base, await discoverProjectFolders([{ path: join(base, "root"), depth: 1 }])), [
    "root/a-folder",
  ]);
});

test("a root that is not there costs one place to look, never the voice turn", async (t) => {
  // `~/Movies` does not exist on a fresh machine. A scan that threw would take
  // the whole spoken turn down with it, and the operator would hear nothing.
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, { dirs: ["present/a-project"], files: ["present/a-project/package.json"] });

  const found = await discoverProjectFolders([
    { path: join(base, "nowhere"), depth: 2 },
    join(base, "also-nowhere"),
    { path: join(base, "present"), depth: 1 },
  ]);
  assert.deepEqual(relative(base, found), ["present/a-project"]);
});

test("the same directory reached twice is one entry", async (t) => {
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, { dirs: ["root/shared"] });

  const found = await discoverProjectFolders([join(base, "root"), join(base, "root")]);
  assert.deepEqual(relative(base, found), ["root/shared"]);
});

test("entries come back alphabetically, because the cap cuts the tail", async (t) => {
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  await build(base, { dirs: ["root/zebra", "root/Apple", "root/mango"] });

  assert.deepEqual(relative(base, await discoverProjectFolders([join(base, "root")])), [
    "root/Apple",
    "root/mango",
    "root/zebra",
  ]);
});

test("the cap takes the deepest entries first, so the top level survives it", async (t) => {
  /*
    Level by level, not directory by directory. The renderer scores every entry
    on every turn, so the cap is a stall guard -- but WHICH entries it drops is
    a correctness question: truncating the top level of `~/Downloads` would
    have taken `4K Video Downloader+` out of the list and silently undone the
    fix this lane exists for.
  */
  const base = await scratch();
  t.after(() => rm(base, { recursive: true, force: true }));
  const dirs = [];
  for (let i = 0; i < MAX_DISCOVERED_FOLDERS + 1; i += 1) {
    dirs.push(`root/top-${String(i).padStart(4, "0")}`);
  }
  dirs.push("root/container/deep-project");
  await build(base, { dirs, files: ["root/container/deep-project/package.json"] });

  const found = await discoverProjectFolders([{ path: join(base, "root"), depth: 2 }]);
  assert.equal(found.folders.length, MAX_DISCOVERED_FOLDERS);
  assert.equal(found.truncated, true);
  assert.equal(
    relative(base, found).some((f) => f.endsWith("deep-project")),
    false,
    "a depth-2 entry must not displace a top-level one",
  );
});

test("the roots are the server's own, and they mirror the resolver's allowlist", async () => {
  /*
    `DISCOVERY_ROOTS` is mirrored from `ALLOWED_ROOTS` rather than imported --
    that module is renderer code that imports nothing, deliberately. Mirrored
    lists drift, so the drift is what is tested. Discovering a folder the
    resolver would then refuse to bind is a voice turn that finds the right
    directory and says no.
  */
  const home = PROJECTS_ROOT.replace("/Documents/my_projects", "");
  assert.deepEqual(
    DISCOVERY_ROOTS.map((r) => r.path.replace(process.env.HOME ?? home, "~")),
    ALLOWED_ROOTS.map((r) => r.replace(home, "~")),
  );

  // Depth is per root because the roots are not the same kind of place: a
  // folder of folders of projects, versus two dumping grounds whose top level
  // is already what he names.
  assert.deepEqual(
    DISCOVERY_ROOTS.map((r) => [r.path.split("/").pop(), r.depth]),
    [["my_projects", 2], ["Downloads", 1], ["Movies", 1]],
  );
});
