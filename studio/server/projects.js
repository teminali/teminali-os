import { open, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve, sep } from "node:path";

export const MAX_RECENT_PROJECTS = 12;

/**
 * The roots a never-opened folder may be discovered under, and how deep each
 * one is worth scanning.
 *
 * MIRRORED from `ALLOWED_ROOTS` in `studio/src/services/voice/workspaceActions.ts`,
 * and mirrored rather than imported for two reasons that both matter:
 *
 *   - That module is renderer code Vite bundles for the browser. It imports
 *     nothing on purpose — no `node:os`, no `node:path` — so this file cannot
 *     reach it and it could not reach `homedir()` if it tried.
 *   - More to the point, a server that took its roots from the client would not
 *     have an allowlist at all. The caller would name the directory to scan and
 *     the gate would be decoration. The list below is the server's own, and no
 *     request body can widen it.
 *
 * `homedir()` rather than the client's hard-coded `/Users/teminali`: the client
 * derives the home from a literal because it cannot ask, this can, and the two
 * agree on the operator's machine.
 *
 * **Depth is per root, because the roots are not the same kind of place, and
 * this was measured before it was chosen.** `my_projects` is a folder of
 * folders of projects: 15 entries at the top, of which 6 are containers whose
 * children — `teminali/claude-context-guard`, `m-digital/m-digital-web` — are
 * the projects the operator names, and until depth 2 they were unreachable by
 * voice however clearly he said them. Depth 2 there costs 12 entries, because
 * `PROJECT_MARKERS` keeps the generic ones out. `~/Downloads` and `~/Movies` are the
 * opposite: their top-level entries already ARE what he names, and a second
 * level there is 126 directories of `src`, `dist`, `tests` and `node_modules`
 * from two cloned repos. Those are not projects, and short generic names are
 * precisely what a mis-transcription scores above the 0.7 floor. Binding the
 * workspace root to a `node_modules` by mis-hearing is the silent wrong switch
 * this whole lane is built to refuse.
 *
 * Keep the two lists in step. Adding a root is how this feature is widened —
 * never by loosening the containment check in `discoverProjectFolders`.
 */
export const DISCOVERY_ROOTS = [
  { path: resolve(homedir(), "Documents", "my_projects"), depth: 2 },
  { path: resolve(homedir(), "Downloads"), depth: 1 },
  { path: resolve(homedir(), "Movies"), depth: 1 },
];

/**
 * How many directories a scan may return.
 *
 * The renderer holds this whole list in memory and scores a heard name against
 * every entry on every voice turn, so an unbounded answer is a stall on the one
 * lane that is supposed to be the fast path. A few hundred covers every root
 * here with room to spare — the roots above return 45 on the operator's
 * machine, measured, with depth 2 in force; past that the operator has a
 * downloads folder, not a set of projects, and the tail of an alphabetised
 * list is the least likely thing he is asking for by name.
 */
export const MAX_DISCOVERED_FOLDERS = 400;

/**
 * The markers that make a directory a project in its own right.
 *
 * They answer two questions below the top level of a root, and it is the same
 * answer both times:
 *
 *   - **Stop.** A directory carrying one of these IS the thing the operator
 *     names. Its children are its source tree, and `src`, `dist` and
 *     `node_modules` are not places to bind a workspace root.
 *   - **Include.** A directory below the top level is a candidate only if it
 *     carries one. Measured on the operator's machine, depth 2 under
 *     `my_projects` finds 21 directories: 12 carry a marker and are the
 *     projects he names — `teminali/claude-context-guard`, all five
 *     `m-digital/*` apps — and the other 9 are `build`, `docs`, `tests`,
 *     `tools`, `__pycache__` and a bare clone. Those nine are the dangerous
 *     ones: short generic names are exactly what a mis-transcription scores
 *     above the 0.7 floor, and "open the tests folder" must not rebind the
 *     workspace to some unrelated project's test directory.
 *
 * More than `package.json`, because the operator's projects are not all
 * JavaScript: `xslm_project` is Python and was read as a container until
 * `pyproject.toml`/`requirements.txt` were here, which put its `tests` and
 * `tools` into the candidate list.
 */
const PROJECT_MARKERS = [
  "package.json",
  ".git",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
];

/** A root entry may be written as a bare path; bare means one level. */
function normaliseRoot(root) {
  if (typeof root === "string") return { path: root, depth: 1 };
  const depth = Number.isInteger(root?.depth) && root.depth > 0 ? root.depth : 1;
  return { path: root?.path ?? "", depth };
}

/** Does this directory carry a project's own marker? Never throws. */
async function isProjectItself(directory) {
  for (const marker of PROJECT_MARKERS) {
    try {
      await stat(resolve(directory, marker));
      return true;
    } catch {
      // Absent, or unreadable, which for this question are the same answer.
    }
  }
  return false;
}

/**
 * The directories directly inside `directory`, resolved and contained.
 *
 * `root` is the scan's own root, not the parent: a symlink two levels down
 * still may not point outside the root it was found under.
 *
 * Never throws. A directory that is absent or unreadable is one fewer place to
 * look, not an error — `~/Movies` does not exist on a fresh machine and a voice
 * turn must not die of it.
 */
async function listChildDirectories(directory, root) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  const children = [];
  for (const entry of entries) {
    // Dot-directories are the machine's business, not the operator's: `.git`,
    // `.cache`, `.Trash`. None of them is a project he would ask for by name.
    if (entry.name.startsWith(".")) continue;

    let path = resolve(directory, entry.name);

    if (entry.isSymbolicLink()) {
      // A link is followed only as far as proving where it lands. A symlink
      // in ~/Downloads pointing at ~/Library is the whole reason this check
      // exists, and `isInside` alone would not catch it — the link's own path
      // is inside the root, its target is not.
      try {
        path = await realpath(path);
      } catch {
        continue;
      }
      if (!isInside(root, path) || path === root) continue;
      try {
        if (!(await stat(path)).isDirectory()) continue;
      } catch {
        continue;
      }
    } else if (!entry.isDirectory()) {
      continue;
    }

    children.push({ path, name: basename(path) || entry.name });
  }

  return children;
}

/**
 * Every directory under the discovery roots the operator might name, as
 * `{ path, name }`.
 *
 * The gap this closes: the voice lane's candidate list came only from the
 * recents, so a folder the operator had never opened was unreachable by voice
 * however clearly he said its name. The shape matches `ProjectEntry` in its
 * first two fields so a caller can concatenate the two lists without
 * translating either.
 *
 * `kind` is deliberately absent. Classifying would mean opening a project.json
 * in each of up to four hundred directories to answer a question the candidate
 * list never asks; `listRecentProjects` classifies twelve, which is affordable.
 *
 * A bounded descent, never a walk: each root goes as deep as `DISCOVERY_ROOTS`
 * says and no deeper, the descent stops early at any directory that is itself
 * a project, and below the top level only a project is listed at all — see
 * `PROJECT_MARKERS`. Unbounded depth is the difference between listing the
 * projects and indexing the disk.
 *
 * **Level by level, deliberately.** Every entry at one distance is collected
 * before any entry at the next, so the alphabetised top level is complete
 * whatever happens below it, and when the cap bites it takes the deepest and
 * least likely entries first rather than truncating the roots he names most.
 *
 * Never throws. A root that is absent, unreadable, or not a directory is one
 * fewer place to look.
 */
export async function discoverProjectFolders(roots = DISCOVERY_ROOTS) {
  const seen = new Set();
  const folders = [];
  let truncated = false;

  scan: for (const candidateRoot of roots) {
    const { path: rootPath, depth } = normaliseRoot(candidateRoot);

    // The root is resolved first so every containment check below compares real
    // paths against a real path. On macOS `/tmp` is a link to `/private/tmp`,
    // and comparing a resolved child against an unresolved root rejects
    // everything.
    let root;
    try {
      root = await realpath(resolve(rootPath));
    } catch {
      continue;
    }

    let level = [root];
    for (let distance = 1; distance <= depth && level.length; distance += 1) {
      const next = [];

      for (const parent of level) {
        for (const child of await listChildDirectories(parent, root)) {
          if (seen.has(child.path)) continue;
          seen.add(child.path);

          // The marker answers both questions below, so it is asked once — and
          // only when one of them is live. A depth-1 root never asks it at all,
          // which is why `~/Downloads` costs exactly what it used to.
          const project =
            distance > 1 || distance < depth ? await isProjectItself(child.path) : false;

          // The top level of a root is listed whole, a level down is not. The
          // asymmetry is the point: the top level is a place the operator put
          // things — `argus-vpn-landing` is three loose files and he still
          // names it — while a level down is the inside of someone's folder,
          // where a directory has to prove it is a project to be named.
          if (distance === 1 || project) {
            if (folders.length >= MAX_DISCOVERED_FOLDERS) {
              truncated = true;
              break scan;
            }
            folders.push(child);
          }

          if (distance < depth && !project) next.push(child.path);
        }
      }

      level = next;
    }
  }

  return { folders, truncated };
}

/**
 * The marker that makes a directory a video project rather than a code one.
 *
 * The canonical declaration is `VIDEO_PROJECT_KIND` in
 * `studio/src/video/project/format.ts`, which this file cannot import — it is
 * renderer code on the other side of the bundle. `studio/tests/video-project-format.test.mjs`
 * reads both and asserts the two literals still agree.
 */
export const VIDEO_PROJECT_KIND = "teminali-video-project";
export const VIDEO_PROJECT_FILE = "project.json";

/**
 * How much of a project.json is read to classify it.
 *
 * Only the head, not the file. A saved timeline is the whole edit — tracks,
 * clips, keyframes, transcripts — and can run to megabytes, while this answers
 * one yes/no question for up to twelve directories every time a sidebar mounts.
 * `serializeProject` writes `kind` as the first key, so the marker is inside
 * the first few dozen bytes of every file this app has ever written; a file
 * where it is not found in 4KB is reported as code, which is the same answer
 * an unreadable file gets.
 */
const MARKER_PROBE_BYTES = 4096;
const MARKER_PATTERN = new RegExp(`"kind"\\s*:\\s*"${VIDEO_PROJECT_KIND}"`);

/**
 * `"video"` when the directory holds a project.json carrying the marker,
 * `"code"` otherwise. Never throws: a path that has been deleted, or that the
 * user cannot read, is a code project rather than an error that empties the
 * whole recent list.
 */
export async function classifyProject(projectPath) {
  let handle;
  try {
    handle = await open(resolve(projectPath, VIDEO_PROJECT_FILE), "r");
  } catch {
    return "code";
  }
  try {
    const buffer = Buffer.alloc(MARKER_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MARKER_PROBE_BYTES, 0);
    return MARKER_PATTERN.test(buffer.subarray(0, bytesRead).toString("utf8")) ? "video" : "code";
  } catch {
    return "code";
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Re-reads each entry's kind from disk. The store is a cache; the marker file is the truth. */
async function withKinds(entries) {
  return Promise.all(entries.map(async (entry) => ({ ...entry, kind: await classifyProject(entry.path) })));
}

/**
 * Opening a folder makes it the root the gateway reads and writes. Two roots are
 * refused outright: the filesystem root and the user's home directory. Both would
 * expose everything on the machine to workspace routes and make the bounded tree
 * walk meaningless.
 */
export async function validateProjectRoot(requestedPath) {
  if (typeof requestedPath !== "string" || !requestedPath.trim() || requestedPath.includes("\0")) {
    throw new Error("INVALID_PROJECT_PATH");
  }

  const expanded = requestedPath.startsWith("~")
    ? resolve(homedir(), requestedPath.slice(1).replace(/^[/\\]/, ""))
    : resolve(requestedPath);

  if (expanded === parse(expanded).root) throw new Error("PROJECT_ROOT_TOO_BROAD");
  if (expanded === resolve(homedir())) throw new Error("PROJECT_ROOT_TOO_BROAD");

  let real;
  try {
    real = await realpath(expanded);
  } catch {
    throw new Error("PROJECT_NOT_FOUND");
  }

  const stats = await lstat(real);
  if (!stats.isDirectory()) throw new Error("PROJECT_NOT_A_DIRECTORY");

  return { path: real, name: basename(real) || real };
}

async function readStore(storePath) {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8"));
    return Array.isArray(parsed?.recent) ? parsed.recent : [];
  } catch {
    return [];
  }
}

function sanitizeEntries(entries) {
  const seen = new Set();
  const clean = [];
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string") continue;
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    clean.push({
      path: entry.path,
      name: typeof entry.name === "string" && entry.name ? entry.name : basename(entry.path),
      openedAt: typeof entry.openedAt === "string" ? entry.openedAt : new Date().toISOString(),
      // Carried through so a stored file round-trips, but never trusted: every
      // read path overwrites it from the marker file. A project can stop being
      // a video project between two sessions, and the store cannot know.
      kind: entry.kind === "video" ? "video" : "code",
    });
    if (clean.length >= MAX_RECENT_PROJECTS) break;
  }
  return clean;
}

/**
 * Drops entries whose directory is no longer there.
 *
 * Filtered out of the response rather than rewritten into the store, and the
 * distinction is the point: a project on an unmounted volume is missing, not
 * deleted, so it reappears when the volume does. Rewriting would forget it.
 *
 * Without this a dead row stays in the list and stays clickable. It does not
 * fail silently — `validateProjectRoot` throws `PROJECT_NOT_FOUND` and the
 * panel says so — but the message is list-wide ("Projects are unavailable"),
 * which reads as though every project had gone rather than the one that did.
 *
 * `stat` rather than `lstat`: a project reached through a symlinked path is
 * present when its target is, and `lstat` would report the link instead.
 */
async function present(entries) {
  const alive = await Promise.all(
    entries.map(async (entry) => {
      try {
        return (await stat(entry.path)).isDirectory() ? entry : null;
      } catch {
        return null;
      }
    }),
  );
  return alive.filter((entry) => entry !== null);
}

export async function listRecentProjects(storePath) {
  return withKinds(await present(sanitizeEntries(await readStore(storePath))));
}

/** Records a project as most-recently opened; the write is atomic. */
export async function rememberProject(storePath, project) {
  const existing = await readStore(storePath);
  const entry = {
    path: project.path,
    name: project.name,
    openedAt: new Date().toISOString(),
    kind: await classifyProject(project.path),
  };
  const recent = sanitizeEntries([entry, ...existing.filter((item) => item?.path !== project.path)]);

  await mkdir(dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ recent }, null, 2)}\n`, "utf8");
  await rename(temporary, storePath);
  return withKinds(recent);
}

export async function forgetProject(storePath, projectPath) {
  const existing = await readStore(storePath);
  const recent = sanitizeEntries(existing.filter((item) => item?.path !== projectPath));
  await mkdir(dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ recent }, null, 2)}\n`, "utf8");
  await rename(temporary, storePath);
  return withKinds(recent);
}

/** True when `child` is the same as, or inside, `root`. */
export function isInside(root, child) {
  const a = resolve(root);
  const b = resolve(child);
  return b === a || b.startsWith(`${a}${sep}`);
}
