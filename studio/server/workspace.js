import { lstat, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

const DEFAULT_IGNORES = new Set([".git", "node_modules", "dist", "build", "coverage", ".cache", ".DS_Store"]);
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".csv", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx",
  ".json", ".md", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".svg", ".toml", ".ts", ".tsx",
  ".txt", ".xml", ".yaml", ".yml",
]);
const BINARY_PREVIEW_EXTENSIONS = new Set([".pdf", ".xlsx", ".xls"]);
const MIME_TYPES = {
  ".csv": "text/csv",
  ".css": "text/css",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
};

export const WORKSPACE_LIMITS = Object.freeze({ maxDepth: 8, maxEntries: 2_000, maxFileBytes: 8 * 1024 * 1024 });

function publicPath(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join("/");
}

export function resolveWorkspacePath(root, requestedPath = "") {
  if (typeof requestedPath !== "string" || requestedPath.includes("\0")) throw new Error("INVALID_WORKSPACE_PATH");
  const workspaceRoot = resolve(root);
  const candidate = resolve(workspaceRoot, requestedPath);
  if (candidate !== workspaceRoot && !candidate.startsWith(`${workspaceRoot}${sep}`)) throw new Error("WORKSPACE_PATH_ESCAPE");
  return candidate;
}

function fileKind(name) {
  const extension = extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension) || BINARY_PREVIEW_EXTENSIONS.has(extension)) return extension;
  return "";
}

export async function listWorkspaceTree(root, options = {}) {
  const limits = { ...WORKSPACE_LIMITS, ...options };
  const workspaceRoot = resolve(root);
  let entriesSeen = 0;

  async function visit(directory, depth) {
    if (depth > limits.maxDepth || entriesSeen >= limits.maxEntries) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const items = [];
    for (const entry of entries) {
      if (entriesSeen >= limits.maxEntries || DEFAULT_IGNORES.has(entry.name) || entry.isSymbolicLink()) continue;
      const absolutePath = resolve(directory, entry.name);
      const path = publicPath(workspaceRoot, absolutePath);
      if (entry.isDirectory()) {
        entriesSeen += 1;
        items.push({ id: `dir:${path}`, name: entry.name, path, type: "directory", children: await visit(absolutePath, depth + 1) });
      } else if (entry.isFile() && fileKind(entry.name)) {
        entriesSeen += 1;
        const stats = await lstat(absolutePath);
        items.push({ id: `file:${path}`, name: entry.name, path, type: "file", size: stats.size, modified: stats.mtime.toISOString() });
      }
    }
    return items;
  }

  return { rootName: workspaceRoot.split(sep).pop() || "workspace", files: await visit(workspaceRoot, 0), truncated: entriesSeen >= limits.maxEntries, entryCount: entriesSeen };
}

export async function readWorkspaceFile(root, requestedPath, options = {}) {
  const maxFileBytes = options.maxFileBytes || WORKSPACE_LIMITS.maxFileBytes;
  const workspaceRoot = resolve(root);
  const absolutePath = resolveWorkspacePath(workspaceRoot, requestedPath);
  const stats = await lstat(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("WORKSPACE_FILE_REQUIRED");
  if (stats.size > maxFileBytes) throw new Error("WORKSPACE_FILE_TOO_LARGE");
  const extension = fileKind(absolutePath);
  if (!extension) throw new Error("WORKSPACE_FILE_UNSUPPORTED");
  const buffer = await readFile(absolutePath);
  const isBinary = BINARY_PREVIEW_EXTENSIONS.has(extension) && !(extension === ".xls" && buffer.subarray(0, 256).toString("utf8").trimStart().startsWith("<"));
  return {
    path: publicPath(workspaceRoot, absolutePath),
    name: absolutePath.split(sep).pop(),
    size: stats.size,
    modified: stats.mtime.toISOString(),
    mimeType: MIME_TYPES[extension] || (isBinary ? "application/octet-stream" : "text/plain"),
    encoding: isBinary ? "base64" : "utf8",
    content: isBinary ? buffer.toString("base64") : buffer.toString("utf8"),
  };
}

export async function writeWorkspaceFile(root, requestedPath, content, options = {}) {
  const maxFileBytes = options.maxFileBytes || WORKSPACE_LIMITS.maxFileBytes;
  if (typeof content !== "string") throw new Error("WORKSPACE_CONTENT_REQUIRED");
  if (Buffer.byteLength(content, "utf8") > maxFileBytes) throw new Error("WORKSPACE_FILE_TOO_LARGE");

  const workspaceRoot = resolve(root);
  const absolutePath = resolveWorkspacePath(workspaceRoot, requestedPath);
  const extension = extname(absolutePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) throw new Error("WORKSPACE_FILE_UNSUPPORTED");

  const parentPath = dirname(absolutePath);
  const [realRoot, realParent] = await Promise.all([realpath(workspaceRoot), realpath(parentPath)]);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) throw new Error("WORKSPACE_PATH_ESCAPE");

  let existing = null;
  try {
    existing = await lstat(absolutePath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("WORKSPACE_FILE_REQUIRED");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (options.expectedModified === null && existing) {
    throw new Error("WORKSPACE_FILE_CONFLICT");
  }
  if (typeof options.expectedModified === "string" && existing?.mtime.toISOString() !== options.expectedModified) {
    throw new Error("WORKSPACE_FILE_CONFLICT");
  }

  const temporaryPath = resolve(parentPath, `.frontier-${basename(absolutePath)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: existing ? existing.mode & 0o777 : 0o644 });
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }

  return readWorkspaceFile(workspaceRoot, requestedPath, { maxFileBytes });
}
