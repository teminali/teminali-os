/**
 * Where the command line tools we shell out to actually live.
 *
 * A GUI app launched from Finder inherits launchd's PATH —
 * /usr/bin:/bin:/usr/sbin:/sbin — not the shell's. Every tool the studio
 * spawns (claude, codex, gh, whisper, ffmpeg, and whatever a workspace command
 * names) is installed by a package manager into a prefix that launchd's PATH
 * never mentions. The packaged build therefore reports them missing while the
 * same tools resolve fine from a terminal-launched dev build, which reads as a
 * broken install rather than a broken PATH. Search the usual prefixes
 * explicitly instead of trusting whatever PATH we were handed.
 *
 * Appended rather than prepended: someone who has put a specific build ahead on
 * PATH means it, and this list is a fallback, not an override.
 */
import os from "node:os";
import path from "node:path";

export const BIN_SEARCH_PATHS = [
  "/opt/homebrew/bin", // Homebrew on Apple silicon.
  "/usr/local/bin", // Homebrew on Intel, and most `npm install -g` prefixes.
  "/opt/local/bin", // MacPorts.
  path.join(os.homedir(), ".local/bin"), // Claude Code's native installer, pipx.
  path.join(os.homedir(), ".bun/bin"),
];

/**
 * `source` with the known prefixes appended to PATH.
 *
 * Idempotent: a prefix already on PATH is left where it is rather than
 * duplicated, so calling this on an already-augmented environment is a no-op.
 */
export function withBinPaths(source = process.env) {
  const present = (source.PATH ?? "").split(path.delimiter).filter(Boolean);
  const missing = BIN_SEARCH_PATHS.filter((dir) => !present.includes(dir));
  return { ...source, PATH: [...present, ...missing].join(path.delimiter) };
}
