import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  escapeArgument,
  escapeCommand,
  findExecutable,
  parseNpmShim,
  pathKey,
  resolveCommand,
} from "../server/command-resolver.js";

/* The shape npm's cmd-shim writes for a global install. */
const NPM_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r
`;

test("pathKey keeps the case Windows gave it", () => {
  assert.equal(pathKey({ Path: "C:\\x" }), "Path");
  assert.equal(pathKey({ PATH: "/usr/bin" }), "PATH");
  assert.equal(pathKey({}), "PATH");
});

test("off Windows, a command name is handed back untouched", () => {
  assert.equal(findExecutable("claude", {}, "darwin"), "claude");
  const resolved = resolveCommand("claude", ["-p", "hi"], { platform: "linux" });
  assert.deepEqual([resolved.file, resolved.args, resolved.via], ["claude", ["-p", "hi"], "direct"]);
});

test("on Windows a bare name is searched along PATH with PATHEXT", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolver-"));
  writeFileSync(path.join(dir, "claude.cmd"), NPM_SHIM);
  const env = { Path: `C:\\nowhere${path.delimiter}${dir}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(findExecutable("claude", env, "win32"), path.join(dir, "claude.cmd"));
  assert.equal(findExecutable("missing", env, "win32"), null);
});

test("an npm shim resolves to its script under node, arguments verbatim", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolver-"));
  mkdirSync(path.join(dir, "node_modules", "@anthropic-ai", "claude-code"), { recursive: true });
  const shim = path.join(dir, "claude.cmd");
  writeFileSync(shim, NPM_SHIM);

  const parsed = parseNpmShim(shim);
  assert.equal(parsed.script, path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"));
  assert.equal(parsed.node, null);

  const prompt = "line one\nline \"two\" & three";
  const resolved = resolveCommand("claude", ["-p", prompt], {
    platform: "win32",
    env: { Path: dir, PATHEXT: ".EXE;.CMD" },
    execPath: "C:\\Teminali OS\\Teminali OS.exe",
    // Only the agent resolves; there is no node.exe on this PATH.
    find: (name) => (name === "claude" ? shim : null),
  });
  assert.equal(resolved.via, "node");
  // No node on this PATH, so the app itself runs the script as node.
  assert.equal(resolved.file, "C:\\Teminali OS\\Teminali OS.exe");
  assert.equal(resolved.env.ELECTRON_RUN_AS_NODE, "1");
  assert.deepEqual(resolved.args, [parsed.script, "-p", prompt]);
  assert.equal(resolved.windowsVerbatimArguments, false);
});

test("a batch file that is not an npm shim goes through cmd.exe, escaped", () => {
  const resolved = resolveCommand("tool", ["a b", 'say "hi"'], {
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
    find: () => "C:\\tools\\tool.bat",
    parseShim: () => null,
  });
  assert.equal(resolved.via, "cmd");
  assert.equal(resolved.file, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(resolved.windowsVerbatimArguments, true);
  assert.deepEqual(resolved.args.slice(0, 3), ["/d", "/s", "/c"]);
  // Every cmd.exe operator is caret-escaped, the space in "a b" included.
  assert.equal(resolved.args[3], '"C:\\tools\\tool.bat ^"a^ b^" ^"say^ \\^"hi\\^"^""');
});

test("an .exe on PATH is spawned directly", () => {
  const resolved = resolveCommand("gh", ["--version"], {
    platform: "win32",
    find: () => "C:\\Program Files\\GitHub CLI\\gh.exe",
  });
  assert.deepEqual([resolved.file, resolved.args, resolved.via], ["C:\\Program Files\\GitHub CLI\\gh.exe", ["--version"], "direct"]);
});

test("escaping matches what cmd.exe expects", () => {
  assert.equal(escapeCommand("C:\\a b\\x.cmd"), "C:\\a^ b\\x.cmd");
  assert.equal(escapeArgument("plain"), '^"plain^"');
  assert.equal(escapeArgument('say "hi"'), '^"say^ \\^"hi\\^"^"');
  assert.equal(escapeArgument("trail\\"), '^"trail\\\\^"');
  // A .cmd target is expanded twice, so its arguments are escaped twice.
  assert.equal(escapeArgument("a&b", true), '^^^"a^^^&b^^^"');
});
