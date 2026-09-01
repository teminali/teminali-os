import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { AgentRuntimeError, throwIfAborted } from "./errors.js";

const DEFAULT_IGNORES = new Set([".git", ".frontier-agent", "node_modules", "dist", "build", "coverage"]);
const SENSITIVE_NAMES = new Set([".env", ".npmrc", ".netrc", "credentials", "credentials.json", "id_rsa", "id_ed25519"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function normalizeRelative(path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) {
    throw new AgentRuntimeError("INVALID_PATH", "Tool paths must be non-empty and relative to the workspace.");
  }
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) throw new AgentRuntimeError("PATH_ESCAPE", `Path escapes the workspace: ${path}`);
  return normalized.replace(/^\.\//, "");
}

export class WorkspaceTools {
  constructor(options) {
    this.workspace = resolve(options.workspace);
    this.editablePaths = new Set((options.editablePaths || []).map(normalizeRelative));
    this.allowedCommands = new Set(options.allowedCommands || ["node", "npm", "npx"]);
    this.maxFileBytes = options.maxFileBytes ?? 256 * 1024;
    this.maxFiles = options.maxFiles ?? 500;
    this.maxSearchResults = options.maxSearchResults ?? 200;
    this.maxInspectionBytes = options.maxInspectionBytes ?? 1024 * 1024;
    this.maxSearchBytes = options.maxSearchBytes ?? 2 * 1024 * 1024;
    this.maxOutputBytes = options.maxOutputBytes ?? 512 * 1024;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  }

  async initialize() {
    this.workspace = await realpath(this.workspace);
    const info = await stat(this.workspace);
    if (!info.isDirectory()) throw new AgentRuntimeError("INVALID_WORKSPACE", "The workspace must be a directory.");
    if (this.editablePaths.size === 0) throw new AgentRuntimeError("EMPTY_EDIT_SCOPE", "At least one editable path is required.");
  }

  async resolvePath(path, options = {}) {
    const normalized = normalizeRelative(path);
    const absolute = resolve(this.workspace, normalized);
    if (absolute !== this.workspace && !absolute.startsWith(`${this.workspace}${sep}`)) {
      throw new AgentRuntimeError("PATH_ESCAPE", `Path escapes the workspace: ${path}`);
    }
    const parent = await realpath(dirname(absolute)).catch(() => null);
    if (!parent || (parent !== this.workspace && !parent.startsWith(`${this.workspace}${sep}`))) {
      throw new AgentRuntimeError("SYMLINK_ESCAPE", `Path resolves outside the workspace: ${path}`);
    }
    if (options.edit && !this.editablePaths.has(normalized)) {
      throw new AgentRuntimeError("OUTSIDE_EDIT_SCOPE", `The agent is not allowed to edit ${normalized}.`);
    }
    if (!options.allowMissing) {
      const resolved = await realpath(absolute);
      if (resolved !== this.workspace && !resolved.startsWith(`${this.workspace}${sep}`)) {
        throw new AgentRuntimeError("SYMLINK_ESCAPE", `Path resolves outside the workspace: ${path}`);
      }
    }
    return { absolute, relative: normalized };
  }

  async listFiles() {
    const files = [];
    const visit = async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files.length >= this.maxFiles) throw new AgentRuntimeError("FILE_LIMIT", `Workspace contains more than ${this.maxFiles} inspectable files.`);
        if (DEFAULT_IGNORES.has(entry.name) || SENSITIVE_NAMES.has(entry.name) || /\.(?:pem|key|p12|pfx)$/i.test(entry.name)) continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) files.push(relative(this.workspace, absolute).replaceAll("\\", "/"));
      }
    };
    await visit(this.workspace);
    return files;
  }

  async read(path) {
    const resolved = await this.resolvePath(path);
    const info = await lstat(resolved.absolute);
    if (!info.isFile()) throw new AgentRuntimeError("NOT_A_FILE", `${resolved.relative} is not a regular file.`);
    if (info.size > this.maxFileBytes) throw new AgentRuntimeError("FILE_TOO_LARGE", `${resolved.relative} exceeds the ${this.maxFileBytes}-byte read limit.`);
    const buffer = await readFile(resolved.absolute);
    if (buffer.includes(0)) throw new AgentRuntimeError("BINARY_FILE", `${resolved.relative} is binary and cannot be read as source text.`);
    const content = buffer.toString("utf8");
    return { path: resolved.relative, content, bytes: Buffer.byteLength(content), sha256: sha256(content) };
  }

  async inspect() {
    const files = await this.listFiles();
    const inspected = [];
    let includedBytes = 0;
    for (const path of files) {
      const resolved = await this.resolvePath(path);
      const info = await lstat(resolved.absolute);
      if (info.size > this.maxFileBytes || includedBytes + info.size > this.maxInspectionBytes) {
        inspected.push({ path, bytes: info.size, sha256: await hashFile(resolved.absolute), content: null, omitted: info.size > this.maxFileBytes ? "file_too_large" : "inspection_budget" });
        continue;
      }
      try {
        const file = await this.read(path);
        includedBytes += file.bytes;
        inspected.push(file);
      } catch (error) {
        if (error.code !== "BINARY_FILE") throw error;
        inspected.push({ path, bytes: info.size, sha256: await hashFile(resolved.absolute), content: null, omitted: "binary" });
      }
    }
    return inspected;
  }

  async search(query) {
    if (typeof query !== "string" || query.length === 0 || query.length > 512) {
      throw new AgentRuntimeError("INVALID_SEARCH", "Search text must contain between 1 and 512 characters.");
    }
    const matches = [];
    let searchedBytes = 0;
    for (const path of await this.listFiles()) {
      let file;
      try {
        file = await this.read(path);
      } catch (error) {
        if (["BINARY_FILE", "FILE_TOO_LARGE"].includes(error.code)) continue;
        throw error;
      }
      searchedBytes += file.bytes;
      if (searchedBytes > this.maxSearchBytes) break;
      const { content } = file;
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(query)) continue;
        matches.push({ path, line: index + 1, text: lines[index].slice(0, 500) });
        if (matches.length >= this.maxSearchResults) return matches;
      }
    }
    return matches;
  }

  async applyPatch(edit) {
    if (!edit || typeof edit.path !== "string" || typeof edit.before !== "string" || typeof edit.after !== "string") {
      throw new AgentRuntimeError("INVALID_EDIT", "Edits require path, before, and after strings.");
    }
    if (edit.before.length === 0) throw new AgentRuntimeError("INVALID_EDIT", "Exact replacement patches require a non-empty before string.");
    const resolved = await this.resolvePath(edit.path, { edit: true });
    const current = await this.read(resolved.relative);
    const currentMode = (await lstat(resolved.absolute)).mode;
    const occurrences = current.content.split(edit.before).length - 1;
    if (occurrences === 0 && current.content.includes(edit.after)) {
      return { tool: "applyPatch", path: resolved.relative, changed: false, reason: "already_applied", beforeSha256: current.sha256, afterSha256: current.sha256 };
    }
    if (occurrences !== 1) {
      throw new AgentRuntimeError("PATCH_CONTEXT_MISMATCH", `Expected exactly one patch context in ${resolved.relative}, found ${occurrences}.`);
    }
    const next = current.content.replace(edit.before, edit.after);
    const temporary = `${resolved.absolute}.${process.pid}.agent-tmp`;
    await mkdir(dirname(resolved.absolute), { recursive: true });
    await writeFile(temporary, next, { mode: currentMode });
    await rename(temporary, resolved.absolute);
    return { tool: "applyPatch", path: resolved.relative, changed: true, beforeSha256: current.sha256, afterSha256: sha256(next), bytes: Buffer.byteLength(next) };
  }

  async run(command, signal) {
    throwIfAborted(signal);
    if (!command || !Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((value) => typeof value !== "string")) {
      throw new AgentRuntimeError("INVALID_COMMAND", "Commands require a non-empty argv string array.");
    }
    const [executable, ...args] = command.argv;
    if (!this.allowedCommands.has(executable)) throw new AgentRuntimeError("COMMAND_NOT_ALLOWED", `${executable} is not in the command allowlist.`);
    const startedAt = performance.now();
    const childEnvironment = { ...process.env, NO_COLOR: "1" };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(executable, args, { cwd: this.workspace, env: childEnvironment, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let killedForOutput = false;
    let timedOut = false;
    const append = (current, chunk) => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length <= this.maxOutputBytes) return combined;
      killedForOutput = true;
      child.kill("SIGTERM");
      return combined.subarray(0, this.maxOutputBytes);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const cancel = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, this.commandTimeoutMs);
    timeout.unref?.();
    const result = await new Promise((resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", (code, childSignal) => resolveResult({ code, signal: childSignal }));
    }).finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    });
    throwIfAborted(signal);
    return {
      tool: "shell",
      argv: command.argv,
      exitCode: result.code,
      signal: result.signal,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      durationMs: Math.round(performance.now() - startedAt),
      timedOut,
      outputTruncated: killedForOutput,
      passed: result.code === 0 && !timedOut && !killedForOutput,
    };
  }

  async hashes() {
    const result = {};
    for (const path of await this.listFiles()) {
      const resolved = await this.resolvePath(path);
      result[path] = await hashFile(resolved.absolute);
    }
    return result;
  }
}

export function patchSignature(edits) {
  return sha256(JSON.stringify(edits.map(({ path, before, after }) => ({ path, before, after }))));
}
