import { spawn } from "node:child_process";
import { withBinPaths } from "./bin-paths.js";
import { resolve, sep } from "node:path";

export const TERMINAL_LIMITS = Object.freeze({
  maxCommandLength: 8_000,
  maxOutputBytes: 1024 * 1024,
  timeoutMs: 120_000,
  killGraceMs: 2_000,
});

// A shell command inherits the gateway's environment. Provider credentials and the
// session token have no legitimate use inside a workspace command, and leaving them
// readable would turn any `env`-capable command into a credential exfiltration path.
const SCRUBBED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "FRONTIER_SESSION_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
];

export function resolveCommandCwd(root, requestedCwd = "") {
  if (typeof requestedCwd !== "string" || requestedCwd.includes("\0")) throw new Error("INVALID_TERMINAL_CWD");
  const workspaceRoot = resolve(root);
  const candidate = resolve(workspaceRoot, requestedCwd);
  if (candidate !== workspaceRoot && !candidate.startsWith(`${workspaceRoot}${sep}`)) throw new Error("TERMINAL_CWD_ESCAPE");
  return candidate;
}

export function childEnvironment(source = process.env) {
  const environment = withBinPaths(source);
  for (const key of SCRUBBED_ENV_KEYS) delete environment[key];
  return environment;
}

/**
 * Runs one shell command inside the workspace and streams its output.
 *
 * Bounds enforced here rather than trusted to the caller: the working directory
 * cannot escape the workspace root, output is capped, and the process is killed
 * on timeout, on the cap, or when the requesting client disconnects.
 */
export function runWorkspaceCommand(options) {
  const {
    root,
    command,
    cwd = "",
    onChunk,
    signal,
    timeoutMs = TERMINAL_LIMITS.timeoutMs,
    maxOutputBytes = TERMINAL_LIMITS.maxOutputBytes,
    env = process.env,
    spawnImpl = spawn,
  } = options;

  if (typeof command !== "string" || command.trim().length === 0) {
    return Promise.reject(new Error("TERMINAL_COMMAND_REQUIRED"));
  }
  if (command.length > TERMINAL_LIMITS.maxCommandLength) {
    return Promise.reject(new Error("TERMINAL_COMMAND_TOO_LONG"));
  }

  const workingDirectory = resolveCommandCwd(root, cwd);
  const startedAt = Date.now();

  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnImpl(command, {
        cwd: workingDirectory,
        shell: true,
        env: childEnvironment(env),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    let emitted = 0;
    let truncated = false;
    let settled = false;
    let killTimer = null;
    let timeoutTimer = null;
    let reason = null;

    const emit = (stream, buffer) => {
      if (settled || truncated) return;
      const remaining = maxOutputBytes - emitted;
      if (remaining <= 0) return;
      const slice = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
      emitted += slice.length;
      onChunk?.({ type: stream, data: slice.toString("utf8") });
      if (emitted >= maxOutputBytes) {
        truncated = true;
        reason = reason || "output_limit";
        terminate();
      }
    };

    function terminate() {
      if (!child.killed) child.kill("SIGTERM");
      if (killTimer === null) {
        killTimer = setTimeout(() => {
          if (!child.killed || child.exitCode === null) child.kill("SIGKILL");
        }, TERMINAL_LIMITS.killGraceMs);
        killTimer.unref?.();
      }
    }

    const onAbort = () => {
      reason = reason || "cancelled";
      terminate();
    };

    const cleanup = () => {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      signal?.removeEventListener?.("abort", onAbort);
    };

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        reason = reason || "timeout";
        terminate();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener?.("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (buffer) => emit("stdout", buffer));
    child.stderr?.on("data", (buffer) => emit("stderr", buffer));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    });

    child.on("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        code: code === null ? null : code,
        signal: closeSignal || null,
        truncated,
        reason,
        durationMs: Date.now() - startedAt,
        bytes: emitted,
      });
    });
  });
}
