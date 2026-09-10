/*
 * What may be moved to the Trash, as a rule rather than a branch.
 *
 * The sidebar's action menu can now send a project to the Trash. That is the
 * only control in Teminali OS that removes something from the operator's disk,
 * so the question "is this a project or is it their life's work" is worth
 * writing down once, in a file a test can reach, instead of inline in an IPC
 * handler that no test on this machine can call.
 *
 * The rule refuses upward. A project directory can live anywhere — no allowlist
 * would survive contact with how people actually arrange their disks — so what
 * is checked is the other end: nothing at or above the home folder is a
 * project, and neither is the disk root. `~/Documents/my_projects/thing` passes;
 * `/`, `/Users` and `~` do not, and neither does a relative path, because a
 * relative path resolved against whatever the main process happens to consider
 * its working directory is how a delete lands somewhere nobody chose.
 *
 * It returns the sentence to show, or null to mean "allowed" — the same shape
 * as `subtitleFileToLoad` and for the same reason: the caller shows what comes
 * back and does not compose its own wording.
 */

/**
 * Strips trailing separators so `/a/b/` and `/a/b` are one path.
 *
 * Root survives the strip deliberately: `/` and `//` both strip to the empty
 * string, and an empty string is not a shorter root — it fails the absolute
 * check below and would be refused with the wrong sentence, which is the
 * difference between "that is the disk root" and "that is not a path".
 */
function normalise(value) {
  const trimmed = String(value).trim();
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped === "" && trimmed.startsWith("/") ? "/" : stripped;
}

/** True when `candidate` is `descendant` itself or a directory above it. */
function isAtOrAbove(candidate, descendant) {
  if (candidate === descendant) return true;
  return descendant.startsWith(`${candidate}/`);
}

/**
 * Why this path must not be trashed, or null when it may be.
 *
 * @param {string} target absolute path to the project directory
 * @param {{ home?: string }} [context] the operator's home folder, when known
 * @returns {string | null}
 */
function trashRefusalReason(target, context = {}) {
  if (typeof target !== "string" || !target.trim()) {
    return "No project path was given, so nothing was moved.";
  }

  const path = normalise(target);

  // A relative path is not a weaker absolute path; it is a different path
  // depending on where the process happens to be standing.
  if (!path.startsWith("/")) {
    return "Only an absolute path can be moved to the Trash.";
  }

  if (path === "/") {
    return "That is the disk root, not a project.";
  }

  const home = context.home ? normalise(context.home) : null;
  if (home && home.startsWith("/") && isAtOrAbove(path, home)) {
    return path === home
      ? "That is your home folder, not a project."
      : `${path} contains your home folder, so it is not a project.`;
  }

  return null;
}

module.exports = { trashRefusalReason };
