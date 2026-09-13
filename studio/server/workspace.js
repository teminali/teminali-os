import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

const DEFAULT_IGNORES = new Set([".git", "node_modules", "dist", "build", "coverage", ".cache", ".DS_Store"]);
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".csv", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx",
  ".json", ".md", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".srt", ".svg", ".toml", ".ts", ".tsx",
  ".txt", ".vtt", ".xml", ".yaml", ".yml",
]);
/**
 * Text files whose whole name is the extension, or which have none at all.
 *
 * `extname(".gitignore")` and `extname("Dockerfile")` are both "", so an
 * extension allowlist hides them completely: they were missing from the tree,
 * unreadable, unwritable, and therefore invisible to the review dock, which
 * will not record a change it cannot offer to reject. A name list is the only
 * way to admit them without admitting every extension-less binary on disk.
 *
 * `.env` is deliberately absent. It is text, but it is the one text file whose
 * contents are usually secrets, and nothing here should put them in front of a
 * model by default.
 */
const TEXT_FILENAMES = new Set([
  ".babelrc", ".browserslistrc", ".dockerignore", ".editorconfig", ".eslintrc",
  ".gitattributes", ".gitignore", ".gitmodules", ".npmignore", ".npmrc", ".nvmrc",
  ".prettierrc", ".tool-versions", "CHANGELOG", "CODEOWNERS", "Dockerfile",
  "Gemfile", "LICENCE", "LICENSE", "Makefile", "Procfile", "README", "Rakefile",
]);
// Shown as pictures, never as text. `.svg` is absent on purpose: it is markup,
// and the operator is far more likely to want to edit it than to look at it.
const IMAGE_EXTENSIONS = new Set([
  ".apng", ".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp",
]);
const BINARY_PREVIEW_EXTENSIONS = new Set([".pdf", ".xlsx", ".xls"]);
// Played, never read: these travel the desktop app's `teminali-media://`
// protocol (server/workspace-media.js) with HTTP Range, not the JSON reader.
// The list is what Chromium's own player demuxes — a container here is no
// promise about the codec inside it; the pane names that problem on play.
/**
 * Video and audio the tree lists and the desktop app streams. Wider than what
 * Chromium's player can demux on its own: the media protocol asks ffprobe
 * what is inside and remuxes or re-encodes live through ffmpeg when it has
 * to (`server/media-probe.js`). `.ts` is deliberately absent — it is
 * TypeScript here — and so are `.rm`/`.rmvb`, which ffmpeg builds rarely carry.
 */
export const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".webm", ".m4v", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".mpg", ".mpeg",
  ".m2ts", ".mts", ".3gp", ".ogv", ".vob", ".mxf", ".asf", ".f4v",
  ".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac", ".opus", ".aiff", ".aif", ".wma", ".amr", ".weba",
]);

/** A folder holding fewer direct video files than this is a folder; at or above it, a series. */
export const SERIES_MIN_EPISODES = 2;

export function isVideoWorkspaceFile(path) {
  const extension = extname(basename(path)).toLowerCase();
  return MEDIA_EXTENSIONS.has(extension) && String(MIME_TYPES[extension] || "").startsWith("video/");
}

/**
 * How many direct children of a folder are video files — the gateway's half
 * of the series rule the renderer's `seriesOf` applies to the tree. Only
 * regular files count; a symlink to a film is refused by the stream anyway.
 */
export async function countSeriesVideos(absoluteDirectory) {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && isVideoWorkspaceFile(entry.name)).length;
}
const MIME_TYPES = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html",
  ".flac": "audio/flac",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".m2ts": "video/mp2t",
  ".mts": "video/mp2t",
  ".3gp": "video/3gpp",
  ".ogv": "video/ogg",
  ".vob": "video/mpeg",
  ".mxf": "application/mxf",
  ".asf": "video/x-ms-asf",
  ".f4v": "video/x-f4v",
  ".aac": "audio/aac",
  ".opus": "audio/ogg",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".wma": "audio/x-ms-wma",
  ".amr": "audio/amr",
  ".weba": "audio/webm",
  ".vtt": "text/vtt",
  ".srt": "text/plain",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".htm": "text/html",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain",
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

/**
 * True when `writeWorkspaceFile` would accept this path.
 *
 * Exported because a caller that records a change has to know, before it
 * offers a reject, whether the restore behind that button can run at all.
 */
export function isWritableWorkspaceFile(path) {
  return isTextFile(path);
}

/**
 * The single answer to "is this text?", asked by the tree, the reader, the
 * writer, the delete path and search. They gated on the extension table
 * separately before, which was survivable only while the table was the whole
 * truth; the moment a file could qualify by name they would have disagreed,
 * and a disagreement here means offering a reject that cannot run.
 */
function isTextFile(path) {
  const name = basename(path);
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase()) || TEXT_FILENAMES.has(name);
}

/** Readable, but only as bytes for a viewer: pictures, PDFs, spreadsheets. */
function isPreviewFile(path) {
  const extension = extname(basename(path)).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) || BINARY_PREVIEW_EXTENSIONS.has(extension);
}

/**
 * Playable, and therefore never read: the JSON reader refuses these and the
 * media protocol serves them. Exported so the protocol handler and the reader
 * ask the same question — a file both answered would be read twice, a file
 * neither answered would open to an empty pane.
 */
export function isStreamableWorkspaceFile(path) {
  return MEDIA_EXTENSIONS.has(extname(basename(path)).toLowerCase());
}

/** The mime type the pane is told, or null for a format the table has no name for. */
export function workspaceMimeType(path) {
  return MIME_TYPES[extname(basename(path)).toLowerCase()] || null;
}

/**
 * Everything the file pane can put in front of the operator: text it can edit,
 * the formats it can only show, and the media it can only play. Exported
 * because the agent's `open_file`
 * has to refuse a format before a tab is opened for it — a tool that reports
 * success and leaves an empty pane is the silence this codebase keeps
 * legislating against.
 */
export function isViewableWorkspaceFile(path) {
  return isViewableFile(path);
}

function isViewableFile(path) {
  return isTextFile(path) || isPreviewFile(path) || isStreamableWorkspaceFile(path);
}

// An .xls that starts with a tag is one of those HTML tables Excel opens
// happily. Sending it as base64 would hide readable text behind a viewer.
function looksLikeMarkup(buffer) {
  return buffer.subarray(0, 256).toString("utf8").trimStart().startsWith("<");
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
      } else if (entry.isFile() && isViewableFile(entry.name)) {
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
  // Before the size cap: a two-gigabyte film is not "too large", it is served
  // elsewhere, and the error should say which.
  if (isStreamableWorkspaceFile(absolutePath)) throw new Error("WORKSPACE_FILE_STREAMED");
  if (stats.size > maxFileBytes) throw new Error("WORKSPACE_FILE_TOO_LARGE");
  if (!isViewableFile(absolutePath)) throw new Error("WORKSPACE_FILE_UNSUPPORTED");
  const extension = extname(basename(absolutePath)).toLowerCase();
  const buffer = await readFile(absolutePath);
  const isBinary = !isTextFile(absolutePath) && !(extension === ".xls" && looksLikeMarkup(buffer));
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
  if (!isTextFile(absolutePath)) throw new Error("WORKSPACE_FILE_UNSUPPORTED");

  const parentPath = dirname(absolutePath);
  await mkdir(parentPath, { recursive: true });
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

export async function createWorkspaceDirectory(root, requestedPath) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) throw new Error("INVALID_WORKSPACE_PATH");
  const workspaceRoot = resolve(root);
  const absolutePath = resolveWorkspacePath(workspaceRoot, requestedPath);
  const realRoot = await realpath(workspaceRoot);
  await mkdir(absolutePath, { recursive: true });
  const realDir = await realpath(absolutePath);
  if (realDir !== realRoot && !realDir.startsWith(`${realRoot}${sep}`)) throw new Error("WORKSPACE_PATH_ESCAPE");
  return { path: publicPath(workspaceRoot, absolutePath) };
}

/**
 * Search the workspace for a literal string or a regular expression.
 *
 * This exists because the studio's search view had been searching only the
 * files already open in the editor, while calling itself global search. A
 * search that silently excludes everything you have not opened is worse than no
 * search: it answers "no matches" for a string that is right there on disk.
 *
 * Walks the same tree the explorer does, honouring the same ignore list and the
 * same text allowlists, so the two views never disagree about what the
 * workspace contains. Bounded on every axis — files scanned, matches returned,
 * bytes read per file — because an unbounded grep over a monorepo will hang the
 * gateway rather than fail it.
 */
export async function searchWorkspace(root, query, options = {}) {
  const {
    caseSensitive = false,
    regex = false,
    wholeWord = false,
    maxMatches = 500,
    maxFiles = 3_000,
    maxFileBytes = 2 * 1024 * 1024,
  } = options;

  if (typeof query !== "string" || query.trim().length === 0) throw new Error("SEARCH_QUERY_REQUIRED");
  if (query.length > 1_000) throw new Error("SEARCH_QUERY_TOO_LONG");

  let matcher;
  try {
    const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bounded = wholeWord ? `\\b(?:${source})\\b` : source;
    matcher = new RegExp(bounded, caseSensitive ? "g" : "gi");
  } catch {
    // An invalid regex is the operator mid-typing, not a server fault.
    throw new Error("SEARCH_PATTERN_INVALID");
  }

  const workspaceRoot = resolve(root);
  const files = [];
  let scanned = 0;
  let matches = 0;
  let truncated = false;

  async function walk(directory, depth) {
    if (depth > WORKSPACE_LIMITS.maxDepth || scanned >= maxFiles || matches >= maxMatches) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= maxFiles || matches >= maxMatches) {
        truncated = true;
        return;
      }
      if (DEFAULT_IGNORES.has(entry.name) || entry.name.startsWith(".")) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isTextFile(entry.name)) continue;

      let info;
      try {
        info = await lstat(absolute);
      } catch {
        continue;
      }
      if (info.size > maxFileBytes) continue;
      scanned += 1;

      let text;
      try {
        text = await readFile(absolute, "utf8");
      } catch {
        continue;
      }
      // Cheap reject before splitting a whole file into lines.
      matcher.lastIndex = 0;
      if (!matcher.test(text)) continue;

      const lines = text.split("\n");
      const hits = [];
      for (let index = 0; index < lines.length && matches < maxMatches; index += 1) {
        const line = lines[index];
        matcher.lastIndex = 0;
        let hit;
        while ((hit = matcher.exec(line)) !== null) {
          hits.push({ line: index + 1, column: hit.index + 1, text: line.slice(0, 400), match: hit[0] });
          matches += 1;
          if (hit[0].length === 0) break; // a zero-width pattern would spin forever
          if (matches >= maxMatches) {
            truncated = true;
            break;
          }
        }
      }
      if (hits.length > 0) files.push({ path: publicPath(workspaceRoot, absolute), name: basename(absolute), matches: hits });
    }
  }

  await walk(workspaceRoot, 0);
  return { query, files, totalMatches: matches, filesScanned: scanned, truncated };
}

/**
 * Remove a file the assistant created.
 *
 * The narrow companion to `writeWorkspaceFile`, and it exists for exactly one
 * caller: rejecting a proposed change to a file that did not exist before the
 * turn. Restoring "what was there before" means removing it, and truncating it
 * to zero bytes instead would leave litter the operator never asked for.
 *
 * Same guards as the write path — inside the root, a real file rather than a
 * symlink or a directory, and text by extension or by name — because a delete
 * is the one
 * operation where a path escape cannot be undone.
 */
export async function deleteWorkspaceFile(root, requestedPath) {
  const workspaceRoot = resolve(root);
  const absolutePath = resolveWorkspacePath(workspaceRoot, requestedPath);
  if (!isTextFile(absolutePath)) throw new Error("WORKSPACE_FILE_UNSUPPORTED");

  const realParent = await realpath(dirname(absolutePath));
  const realRoot = await realpath(workspaceRoot);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) throw new Error("WORKSPACE_PATH_ESCAPE");

  const existing = await lstat(absolutePath);
  if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("WORKSPACE_FILE_REQUIRED");

  await unlink(absolutePath);
  return { path: publicPath(workspaceRoot, absolutePath), deleted: true };
}
