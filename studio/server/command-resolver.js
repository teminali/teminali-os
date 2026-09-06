/**
 * Spawning a command by name, on the platform this is actually running on.
 *
 * On macOS and Linux `spawn("claude", args)` does what it says. On Windows it
 * does not. A CLI installed by npm is a `claude.cmd` shim, CreateProcess finds
 * only `.exe` and `.com` on its own, and Node refuses to run a `.cmd` or `.bat`
 * without a shell at all (CVE-2024-27980, Node 18.20.2 and later — the Node
 * inside Electron 44 included). The bare name therefore reports ENOENT on every
 * Windows machine that has the tool, and the pane reads that as "not installed".
 *
 * So on Windows the name is resolved here first, the way the shell would: each
 * directory on PATH times each extension in PATHEXT. What is found decides how
 * it runs.
 *
 *   `.exe` / `.com`   Spawned directly, arguments verbatim.
 *
 *   `.cmd` / `.bat`   If it is an npm shim, the script it wraps is run under
 *                     node directly and cmd.exe never sees the arguments. That
 *                     is the case that matters: an agent's prompt is a
 *                     positional argument, and a prompt with a newline in it
 *                     does not survive `cmd.exe /c`, whatever the quoting.
 *                     Anything else goes through cmd.exe with the escaping
 *                     cross-spawn uses.
 *
 * Nothing here changes on the other two platforms: `resolveCommand` hands the
 * name straight back, so the call sites read the same everywhere.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** The environment's PATH key with whatever case it was given (`Path` on Windows). */
export function pathKey(env = process.env) {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Where `command` is on this Windows machine, or null.
 *
 * A name with a directory in it is taken as given, with PATHEXT tried when it
 * has no extension. A bare name is searched for along PATH.
 */
export function findExecutable(command, env = process.env, platform = process.platform) {
  if (platform !== "win32") return command;
  if (typeof command !== "string" || !command) return null;

  const extensions = (env.PATHEXT || DEFAULT_PATHEXT).split(";").filter(Boolean);
  const lower = command.toLowerCase();
  const hasExtension = extensions.some((extension) => lower.endsWith(extension.toLowerCase()));
  const hasDirectory = command.includes("\\") || command.includes("/");

  const directories = hasDirectory ? [""] : (env[pathKey(env)] || "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const base = directory ? path.join(directory, command) : command;
    const candidates = hasExtension ? [base] : extensions.map((extension) => base + extension.toLowerCase());
    for (const candidate of candidates) {
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The script an npm `.cmd` shim runs, and the node it runs it with.
 *
 * npm's cmd-shim writes a known shape: `"%_prog%" "%dp0%\node_modules\...\cli.js" %*`,
 * with `_prog` set to `%dp0%\node.exe` when one sits beside the shim and to
 * `node` otherwise. Anything that does not match — a shim for some other
 * interpreter, or a hand-written batch file — returns null and the caller goes
 * through cmd.exe instead.
 */
export function parseNpmShim(shimPath, { readFile = readFileSync, exists = existsSync } = {}) {
  let text;
  try {
    text = readFile(shimPath, "utf8");
  } catch {
    return null;
  }
  if (!/SET\s+"?_prog=node"?/i.test(text)) return null;
  const match = /"%dp0%\\([^"]+)"\s+%\*/.exec(text);
  if (!match) return null;
  const directory = path.dirname(shimPath);
  // The shim writes the path with backslashes; split so the join is right on
  // whichever platform is reading it (the tests read it on macOS).
  const script = path.join(directory, ...match[1].split("\\"));
  const localNode = path.join(directory, "node.exe");
  return { script, node: exists(localNode) ? localNode : null };
}

/* cmd.exe escaping, as cross-spawn does it: the argument is quoted, backslashes
   before a quote are doubled, and every character cmd.exe treats as an operator
   is prefixed with a caret. A `.cmd` target is expanded twice by cmd.exe, so its
   arguments are escaped twice. */
const META = /[()\][%!^"`<>&|;, *?]/g;

export function escapeCommand(command) {
  return command.replace(META, "^$&");
}

export function escapeArgument(argument, doubleEscape = false) {
  let escaped = `${argument}`;
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(META, "^$&");
  if (doubleEscape) escaped = escaped.replace(META, "^$&");
  return escaped;
}

/**
 * What to hand `spawn` for `command args`, on `platform`.
 *
 * Returns `{ file, args, env, windowsVerbatimArguments, via }`. `via` names the
 * route taken — "direct", "node", "cmd" — and "direct" with an unresolved name
 * lets `spawn` raise the same ENOENT it always did, which the callers already
 * report as "not installed".
 */
export function resolveCommand(command, args = [], {
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  find = findExecutable,
  parseShim = parseNpmShim,
} = {}) {
  const plain = { file: command, args, env, windowsVerbatimArguments: false, via: "direct" };
  if (platform !== "win32") return plain;

  const file = find(command, env, platform);
  if (!file) return plain;
  const extension = path.extname(file).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") return { ...plain, file };

  const shim = parseShim(file);
  if (shim) {
    // The shim's own node, else the one on PATH, else this process run as node
    // — which is what the packaged app is, and the only node it can be sure of.
    const node = shim.node ?? find("node", env, platform);
    return {
      file: node ?? execPath,
      args: [shim.script, ...args],
      env: node ? env : { ...env, ELECTRON_RUN_AS_NODE: "1" },
      windowsVerbatimArguments: false,
      via: "node",
    };
  }

  const line = [escapeCommand(path.normalize(file)), ...args.map((arg) => escapeArgument(arg, extension === ".cmd"))].join(" ");
  return {
    file: env.ComSpec || env.comspec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    env,
    windowsVerbatimArguments: true,
    via: "cmd",
  };
}

/**
 * Where `command` is on this machine, or null — `which`, without a subprocess.
 *
 * There is a real `which` on macOS and Linux and none on Windows, which has
 * `where.exe` and a different output shape. Both call sites used to spawn the
 * Unix one, so on Windows every tool answered "not installed": file ingestion
 * reported no video, no audio, no OCR and no archives on a machine with ffmpeg
 * on PATH. Walking PATH ourselves also fixes the macOS half of the same bug —
 * a Finder-launched app inherits launchd's PATH, so `which ffmpeg` found
 * nothing there either unless the caller passed an augmented environment.
 *
 * Pass `withBinPaths()` as the environment to search the package-manager
 * prefixes too; that is what both callers do.
 */
export function lookupCommand(command, env = process.env, platform = process.platform) {
  if (typeof command !== "string" || !command) return null;
  if (platform === "win32") return findExecutable(command, env, platform);

  const directories = (env[pathKey(env)] ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, command);
    // Executable, not merely present: a directory or a data file of the same
    // name on an earlier PATH entry must not shadow the real tool.
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* next directory */
    }
  }
  return null;
}

/**
 * `spawn`, with the command resolved for this platform.
 *
 * `windowsHide` is set because every caller here is a GUI process with piped
 * stdio: without it Windows opens a console window for each child.
 */
export function spawnCommand(command, args = [], options = {}) {
  const resolved = resolveCommand(command, args, { env: options.env ?? process.env });
  return spawn(resolved.file, resolved.args, {
    ...options,
    env: resolved.env,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    windowsHide: true,
  });
}
