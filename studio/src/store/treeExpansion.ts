/**
 * Which folders the file tree has open.
 *
 * This lived as a per-row `useState` inside `FileTree.tsx`, which meant the set
 * of open folders existed only as scattered component state: nothing outside a
 * row could open one. That is why the agent could not show you a folder — there
 * was no address to write to. The state now lives in `studioStore`, and these
 * are the pure functions it is moved by, kept out of the component so the node
 * test runner can import them the way it imports `tabIdentity.ts`.
 *
 * Paths are workspace-relative and `/`-separated, exactly as the gateway's
 * `FileItem.path` gives them. A file path may end up in the set; only
 * directories ever read it back, so that is harmless.
 */

/** Every ancestor of `path`, outermost first, plus `path` itself. */
export function ancestorPaths(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  const prefixes: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    prefixes.push(segments.slice(0, index + 1).join("/"));
  }
  return prefixes;
}

/**
 * Open every folder on the way to `path`.
 *
 * Returns the original set when the path is already fully revealed, so a
 * repeated reveal does not re-render the tree.
 */
export function expandForReveal(current: ReadonlySet<string>, path: string): Set<string> {
  const wanted = ancestorPaths(path);
  if (wanted.length === 0) return current as Set<string>;
  if (wanted.every((prefix) => current.has(prefix))) return current as Set<string>;
  const next = new Set(current);
  for (const prefix of wanted) next.add(prefix);
  return next;
}

/** Flip one folder open or shut. Ancestors are left alone. */
export function toggleExpansion(current: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(current);
  if (next.has(path)) next.delete(path); else next.add(path);
  return next;
}

/**
 * The folders a fresh workspace boots with open.
 *
 * These are top-level paths, so a nested `studio/src` is not caught by the
 * `src` entry — matching the old `depth === 0` check that seeded the useState.
 */
export const DEFAULT_EXPANDED_PATHS = ["src", "studio"] as const;
