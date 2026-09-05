/**
 * What a drop onto the file pane means.
 *
 * Two sources land here and they are told apart rather than guessed at. A row
 * dragged out of the Explorer carries a private MIME type holding a path that
 * is *already* workspace-relative; a file dragged out of Finder or Explorer.exe
 * carries only `Files`, and its absolute path has to be asked for. Reading
 * `text/plain` and hoping would confuse the two the first time someone dragged
 * a filename out of a text editor.
 *
 * The absolute path comes from `webUtils.getPathForFile`, which lives on the
 * Electron side because `File.path` was removed in Electron 44 and a blob URL
 * is not a path. In a browser dev build there is no such bridge, so the
 * external half reports that it needs the desktop app instead of throwing.
 *
 * The rule for a file that is *not* under the current root is the operator's,
 * and it is deliberately not a path-escape hatch: the workspace routes refuse
 * `..`, absolute paths and symlinks, and nothing here may go around them. A
 * drop from outside offers to **switch the project** to the folder that holds
 * the file — the same road a My Projects click takes — and only then opens it.
 * A dropped folder is offered directly, because a folder is a project and never
 * something the file pane could show.
 */

/** Set by the Explorer on an internal drag; its absence means the drag is foreign. */
export const WORKSPACE_PATH_MIME = "application/x-teminali-path";

export type WorkspaceDrop =
  /** Files under the current root. `skipped` counts what came along and could not be opened. */
  | { kind: "open"; paths: string[]; skipped: number }
  /** Nothing here is openable; offer this folder as the project, then show `file` inside it. */
  | { kind: "switch"; folder: string; file: string | null }
  /** The drop carried files, and this build cannot turn one into a path. */
  | { kind: "unavailable"; reason: string };

/** The slice of `DataTransfer` this module reads. Generic in the file type so a test can pass its own. */
export interface DroppedItems<TFile> {
  types: readonly string[];
  getData: (format: string) => string;
  files: ArrayLike<TFile>;
  items?: ArrayLike<{ webkitGetAsEntry?: (() => { isDirectory: boolean } | null) | undefined }> | null;
}

export interface DropContext<TFile> {
  /** Absolute path of the project the gateway is currently bound to. */
  root: string;
  /** `window.teminali.media.getPathForFile`, or nothing outside Electron. */
  getPathForFile?: ((file: TFile) => string | null) | null;
}

/** Separators unified and any trailing slash dropped, so two spellings of one path compare equal. */
function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * `absolute` expressed relative to `root`, or null when it is not inside it.
 *
 * The `/` in the prefix is what stops `/work/site-old` from reading as a file
 * inside `/work/site`, and the root itself returns null because it is a folder
 * rather than a file the pane could open.
 */
export function workspaceRelative(absolute: string, root: string): string | null {
  const target = normalise(absolute);
  const base = normalise(root);
  if (!target || !base || target === base) return null;
  if (!target.startsWith(`${base}/`)) return null;
  return target.slice(base.length + 1);
}

/** The folder that holds `absolute` — what an outside drop offers to open as the project. */
export function containingFolder(absolute: string): string {
  const path = normalise(absolute);
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

function basenameOf(absolute: string): string {
  const path = normalise(absolute);
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/**
 * Whether to light the pane up for this drag.
 *
 * `dragover` may not read the payload — only its types — so this is everything
 * that can be known before the drop actually happens.
 */
export function describesWorkspaceDrop(types: readonly string[] | undefined | null): boolean {
  const list = Array.from(types ?? []);
  return list.includes(WORKSPACE_PATH_MIME) || list.includes("Files");
}

/** Paths from an Explorer row: already workspace-relative, one per line. */
function readInternalPaths<TFile>(transfer: DroppedItems<TFile>): string[] {
  if (!Array.from(transfer.types ?? []).includes(WORKSPACE_PATH_MIME)) return [];
  return (transfer.getData(WORKSPACE_PATH_MIME) || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * `items` and `files` are parallel lists, and only `items` knows whether an
 * entry is a folder. Missing on a synthetic drop, in which case a file is the
 * safe reading: the workspace route refuses a folder anyway, with a reason.
 */
function isDirectoryAt<TFile>(transfer: DroppedItems<TFile>, index: number): boolean {
  const item = transfer.items?.[index];
  if (!item?.webkitGetAsEntry) return false;
  try {
    return Boolean(item.webkitGetAsEntry()?.isDirectory);
  } catch {
    return false;
  }
}

export function resolveWorkspaceDrop<TFile>(
  transfer: DroppedItems<TFile>,
  { root, getPathForFile }: DropContext<TFile>,
): WorkspaceDrop | null {
  const internal = readInternalPaths(transfer);
  if (internal.length) return { kind: "open", paths: internal, skipped: 0 };

  const count = transfer.files?.length ?? 0;
  if (!count) return null;
  if (!getPathForFile) {
    return { kind: "unavailable", reason: "Dropping a file from Finder needs the desktop app." };
  }

  const paths: string[] = [];
  const elsewhere: { absolute: string; isDirectory: boolean }[] = [];
  let unreadable = 0;

  for (let index = 0; index < count; index += 1) {
    const absolute = getPathForFile(transfer.files[index]);
    if (!absolute) {
      unreadable += 1;
      continue;
    }
    const isDirectory = isDirectoryAt(transfer, index);
    const relative = isDirectory ? null : workspaceRelative(absolute, root);
    if (relative) paths.push(relative);
    else elsewhere.push({ absolute, isDirectory });
  }

  // Anything this project already contains wins: opening it is what the drop
  // asked for, and switching away would close the very tree it came from.
  if (paths.length) return { kind: "open", paths, skipped: elsewhere.length + unreadable };

  const first = elsewhere[0];
  if (first) {
    const folder = first.isDirectory ? normalise(first.absolute) : containingFolder(first.absolute);
    // The current project dropped onto itself is not an offer, it is a no-op.
    if (folder === normalise(root)) return null;
    return { kind: "switch", folder, file: first.isDirectory ? null : basenameOf(first.absolute) };
  }

  if (unreadable) {
    return { kind: "unavailable", reason: "That drop carried no path this app could read." };
  }
  return null;
}
