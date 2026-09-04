import { open, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve, sep } from "node:path";

export const MAX_RECENT_PROJECTS = 12;

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
