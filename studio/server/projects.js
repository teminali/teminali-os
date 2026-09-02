import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve, sep } from "node:path";

export const MAX_RECENT_PROJECTS = 12;

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
    });
    if (clean.length >= MAX_RECENT_PROJECTS) break;
  }
  return clean;
}

export async function listRecentProjects(storePath) {
  return sanitizeEntries(await readStore(storePath));
}

/** Records a project as most-recently opened; the write is atomic. */
export async function rememberProject(storePath, project) {
  const existing = await readStore(storePath);
  const entry = { path: project.path, name: project.name, openedAt: new Date().toISOString() };
  const recent = sanitizeEntries([entry, ...existing.filter((item) => item?.path !== project.path)]);

  await mkdir(dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ recent }, null, 2)}\n`, "utf8");
  await rename(temporary, storePath);
  return recent;
}

export async function forgetProject(storePath, projectPath) {
  const existing = await readStore(storePath);
  const recent = sanitizeEntries(existing.filter((item) => item?.path !== projectPath));
  await mkdir(dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ recent }, null, 2)}\n`, "utf8");
  await rename(temporary, storePath);
  return recent;
}

/** True when `child` is the same as, or inside, `root`. */
export function isInside(root, child) {
  const a = resolve(root);
  const b = resolve(child);
  return b === a || b.startsWith(`${a}${sep}`);
}
