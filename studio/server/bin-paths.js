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
 * The same shape of problem exists on the other two platforms with different
 * directories. A Linux desktop launcher reads the login PATH, which usually
 * has ~/.local/bin only if a shell profile added it; Windows has the user's
 * PATH but npm, Claude Code's installer and winget each keep their own bin
 * directory that a fresh install may not have added yet.
 *
 * Appended rather than prepended: someone who has put a specific build ahead on
 * PATH means it, and this list is a fallback, not an override.
 */
import os from "node:os";
import path from "node:path";

import { pathKey } from "./command-resolver.js";

function searchPathsFor(platform, env, home) {
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
      path.join(appData, "npm"), // `npm install -g` shims.
      path.join(home, ".local", "bin"), // Claude Code's native installer.
      path.join(home, ".bun", "bin"),
      path.join(localAppData, "Microsoft", "WinGet", "Links"), // winget-installed CLIs.
      path.join(programFiles, "nodejs"),
      path.join(programFiles, "Git", "cmd"),
      path.join(programFiles, "GitHub CLI"),
      path.join(programFiles, "ffmpeg", "bin"),
      path.join(programFilesX86, "ffmpeg", "bin"),
      path.join(localAppData, "Programs", "ffmpeg", "bin"),
      "C:\\ProgramData\\chocolatey\\bin",
      path.join(home, "scoop", "shims"),
    ];
  }
  if (platform === "linux") {
    return [
      path.join(home, ".local", "bin"), // Claude Code's native installer, pipx.
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".bun", "bin"),
      "/usr/local/bin",
      "/snap/bin",
    ];
  }
  return [
    "/opt/homebrew/bin", // Homebrew on Apple silicon.
    "/usr/local/bin", // Homebrew on Intel, and most `npm install -g` prefixes.
    "/opt/local/bin", // MacPorts.
    path.join(home, ".local", "bin"), // Claude Code's native installer, pipx.
    path.join(home, ".bun", "bin"),
  ];
}

export const BIN_SEARCH_PATHS = searchPathsFor(process.platform, process.env, os.homedir());

/**
 * `source` with the known prefixes appended to PATH.
 *
 * Idempotent: a prefix already on PATH is left where it is rather than
 * duplicated, so calling this on an already-augmented environment is a no-op.
 * The variable keeps whatever case it had — `Path` on Windows — because a
 * second key that differs only in case is two PATHs, and which one a child
 * process reads is not ours to decide.
 */
export function withBinPaths(source = process.env) {
  const key = pathKey(source);
  const present = (source[key] ?? "").split(path.delimiter).filter(Boolean);
  const missing = BIN_SEARCH_PATHS.filter((dir) => !present.includes(dir));
  return { ...source, [key]: [...present, ...missing].join(path.delimiter) };
}
