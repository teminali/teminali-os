/**
 * The macOS pointer helper, as a Node module.
 *
 * Every call spawns the helper with an argument array — never a shell string.
 * The arguments carry element labels and, for `type`, arbitrary operator text,
 * and a `;` in either must reach the helper as a semicolon rather than as a
 * command separator. This is the same rule agent-cli.js follows, for the same
 * reason.
 *
 * Nothing here decides *whether* an action is allowed. That judgement needs the
 * observation the action refers to, so it lives in assistant.js; this module is
 * only the transport.
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const POINTER_LIMITS = Object.freeze({
  /** A tree walk on a large document is the slow case; a click is instant. */
  timeoutMs: 8_000,
  maxOutputBytes: 8 * 1024 * 1024,
  /** What the helper is asked to emit. Ranking and pruning happen after. */
  maxElements: 400,
  maxTypeLength: 4_000,
});

/**
 * Where the helper is.
 *
 * Two places, because there are two kinds of run. In the repository it sits
 * beside its source under `native/macos/bin`. In a packaged app it ships as an
 * extra resource — macOS will not execute a binary out of an asar archive — so
 * `process.resourcesPath/pointer` is checked first when Electron has set it.
 */
function helperCandidates() {
  const candidates = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(resolve(process.resourcesPath, "pointer", "teminali-pointer"));
  }
  candidates.push(resolve(here, "..", "native", "macos", "bin", "teminali-pointer"));
  return candidates;
}

export const HELPER_CANDIDATES = helperCandidates();
export const HELPER_BINARY = HELPER_CANDIDATES[HELPER_CANDIDATES.length - 1];

export class PointerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PointerError";
    this.code = code;
  }
}

/** True when the compiled helper exists and is executable. */
export async function helperAvailable(binary = null) {
  for (const candidate of binary ? [binary] : HELPER_CANDIDATES) {
    try {
      const info = await stat(candidate);
      if (info.isFile() && (info.mode & 0o111) !== 0) return true;
    } catch {
      /* Try the next one. */
    }
  }
  return false;
}

/** The first candidate that is actually there, or the repository path. */
export async function resolveHelper() {
  for (const candidate of HELPER_CANDIDATES) {
    try {
      const info = await stat(candidate);
      if (info.isFile() && (info.mode & 0o111) !== 0) return candidate;
    } catch {
      /* Try the next one. */
    }
  }
  return HELPER_BINARY;
}

/**
 * Runs one helper command and parses its single JSON line.
 *
 * The helper's contract is that stdout is always JSON, including for failures,
 * so a parse error here means something other than the helper answered — which
 * is worth surfacing as itself rather than as an empty result.
 */
export function runPointer(command, args = [], options = {}) {
  const { timeoutMs = POINTER_LIMITS.timeoutMs, spawnImpl = spawn, signal } = options;
  if (options.binary) return spawnPointer(options.binary, command, args, { timeoutMs, spawnImpl, signal });
  return resolveHelper().then((binary) => spawnPointer(binary, command, args, { timeoutMs, spawnImpl, signal }));
}

function spawnPointer(binary, command, args, { timeoutMs, spawnImpl, signal }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnImpl(binary, [command, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      rejectPromise(new PointerError("POINTER_HELPER_MISSING", error.message));
      return;
    }

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(new PointerError("POINTER_TIMEOUT", `The pointer helper did not answer within ${timeoutMs}ms.`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      rejectPromise(new PointerError("POINTER_ABORTED", "The pointer call was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > POINTER_LIMITS.maxOutputBytes) {
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectPromise(
        new PointerError(
          "POINTER_HELPER_MISSING",
          "The pointer helper is not built. Run: npm run build:pointer",
        ),
      );
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      let payload;
      try {
        payload = JSON.parse(stdout.trim());
      } catch {
        rejectPromise(
          new PointerError("POINTER_BAD_OUTPUT", stderr.trim().slice(0, 200) || "The pointer helper returned no JSON."),
        );
        return;
      }
      if (payload && payload.error) {
        rejectPromise(new PointerError(payload.error.code || "POINTER_FAILED", payload.error.message || "The pointer helper failed."));
        return;
      }
      resolvePromise(payload);
    });
  });
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

/**
 * The two permissions that cannot be scripted around.
 *
 * Both are switches in System Settings that only a human can flip, so the only
 * honest thing to do is report them and say which one is missing. `prompt`
 * raises the system's own Accessibility dialog — worth doing once, on an
 * explicit operator action, and never on a poll.
 */
export async function pointerPermissions({ prompt = false, ...options } = {}) {
  if (process.platform !== "darwin") {
    return {
      supported: false,
      helperBuilt: false,
      accessibilityTrusted: false,
      screenRecordingGranted: false,
      detail: "Screen control is macOS-only.",
    };
  }
  const built = await helperAvailable(options.binary);
  if (!built) {
    return {
      supported: true,
      helperBuilt: false,
      accessibilityTrusted: false,
      screenRecordingGranted: false,
      detail: "The pointer helper has not been built yet.",
    };
  }
  try {
    const payload = await runPointer("permissions", prompt ? ["--prompt", "true"] : [], options);
    return {
      supported: true,
      helperBuilt: true,
      accessibilityTrusted: Boolean(payload.accessibilityTrusted),
      screenRecordingGranted: Boolean(payload.screenRecordingGranted),
      detail: null,
    };
  } catch (error) {
    return {
      supported: true,
      helperBuilt: true,
      accessibilityTrusted: false,
      screenRecordingGranted: false,
      detail: error.message,
    };
  }
}

export async function pointerScreens(options = {}) {
  const payload = await runPointer("screens", [], options);
  return Array.isArray(payload.screens) ? payload.screens : [];
}

/** Which application is in front, right now. One cheap spawn. */
export async function pointerFrontmost(options = {}) {
  const payload = await runPointer("frontmost", [], options);
  return payload.application ?? null;
}

export async function pointerCursor(options = {}) {
  const payload = await runPointer("cursor", [], options);
  return payload.cursor ?? null;
}

/** The accessibility tree of the frontmost application, or of one named pid. */
export async function pointerTree({ pid = null, max = POINTER_LIMITS.maxElements, ...options } = {}) {
  const args = ["--max", String(Math.max(1, Math.min(POINTER_LIMITS.maxElements, max)))];
  if (Number.isInteger(pid) && pid > 0) args.push("--pid", String(pid));
  return runPointer("tree", args, options);
}

/**
 * Bring an application to the front, addressed by pid or by bundle id.
 *
 * Two addresses because there are two callers with two different pieces of
 * knowledge. `act()` restores the application an observation was taken of and
 * holds its pid. A `focus` step names an application from the catalogue and
 * holds only its bundle id, because the whole point is that the process
 * belongs to somebody else and was not started by us.
 */
export function pointerActivate(target, options = {}) {
  if (Number.isInteger(target) && target > 0) {
    return runPointer("activate", ["--pid", String(target)], options);
  }
  if (typeof target === "string" && target.trim()) {
    return runPointer("activate", ["--bundle", target.trim()], options);
  }
  throw new PointerError("PID_REQUIRED", "A positive integer pid or a bundle identifier is required.");
}

/* ── Acting ──────────────────────────────────────────────────────────────── */

function point(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PointerError("POINT_REQUIRED", "A finite point is required.");
  return ["--x", String(Math.round(x)), "--y", String(Math.round(y))];
}

export function pointerMove(x, y, options = {}) {
  return runPointer("move", point(x, y), options);
}

export function pointerClick(x, y, { button = "left", count = 1, ...options } = {}) {
  const args = point(x, y);
  if (button === "right") args.push("--button", "right");
  if (count > 1) args.push("--count", String(Math.min(3, count)));
  return runPointer("click", args, options);
}

/**
 * Press at one point, travel to another, release.
 *
 * The path is the payload. An application that implements a drag reads the
 * intermediate positions — a slider tracks each one, a list reorders against
 * whatever row is under the pointer — so a down at the origin and an up at the
 * destination is not a slow click, it is a gesture that does nothing at all.
 * The helper walks the line; this only decides how finely.
 */
export function pointerDrag(x, y, toX, toY, { button = "left", steps = 24, holdMs = 90, ...options } = {}) {
  const args = [...point(x, y)];
  if (!Number.isFinite(toX) || !Number.isFinite(toY)) {
    throw new PointerError("POINT_REQUIRED", "A finite destination is required.");
  }
  args.push("--tox", String(Math.round(toX)), "--toy", String(Math.round(toY)));
  if (button === "right") args.push("--button", "right");
  args.push("--steps", String(Math.min(200, Math.max(2, Math.round(steps)))));
  args.push("--holdms", String(Math.min(2_000, Math.max(0, Math.round(holdMs)))));
  return runPointer("drag", args, options);
}

export function pointerScroll(x, y, { dx = 0, dy = 0, ...options } = {}) {
  return runPointer("scroll", [...point(x, y), "--dx", String(Math.round(dx)), "--dy", String(Math.round(dy))], options);
}

export function pointerType(text, options = {}) {
  if (typeof text !== "string" || text.length === 0) throw new PointerError("TEXT_REQUIRED", "Text to type is required.");
  if (text.length > POINTER_LIMITS.maxTypeLength) throw new PointerError("TEXT_TOO_LONG", "The text to type is too long.");
  return runPointer("type", ["--text", text], options);
}

export function pointerKey(chord, options = {}) {
  if (typeof chord !== "string" || chord.length === 0) throw new PointerError("CHORD_REQUIRED", "A key chord is required.");
  return runPointer("key", ["--chord", chord], options);
}
