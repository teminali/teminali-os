/**
 * The screen assistant's server half: what it saw, and what it may do about it.
 *
 * Two jobs, and the split between them is the whole safety story.
 *
 * `observe()` takes one look at the screen — a frame from `screencapture`, the
 * accessibility tree from the pointer helper, and a description of the frame
 * from the local vision model — and stores it under an id.
 *
 * `act()` will only execute a step that names an element **from a stored
 * observation**. It resolves the element to the frame the operating system
 * reported and clicks that. There is no route that accepts a coordinate, so
 * there is no way for a model's guess at one to reach the screen. The renderer
 * validates plans too (src/services/assistant/plan.ts), but that validation is
 * for the operator's benefit; this one is the boundary.
 *
 * Three further conditions are checked here and nowhere else, because only the
 * gateway can check them:
 *
 *  - **The observation must be fresh.** A frame that was right ninety seconds
 *    ago is now just a coordinate on top of whatever is there instead.
 *  - **The application must still be the one that was observed.** Switching
 *    apps between the look and the click is the same failure, faster.
 *  - **The point must be on a screen.** A frame from a display that has since
 *    been unplugged resolves to nowhere.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PointerError,
  pointerClick,
  pointerFrontmost,
  pointerKey,
  pointerMove,
  pointerPermissions,
  pointerScreens,
  pointerScroll,
  pointerTree,
  pointerType,
} from "./pointer.js";

export const ASSISTANT_LIMITS = Object.freeze({
  /** How long a look stays actionable. Beyond this the screen is a guess. */
  observationTtlMs: 90_000,
  /** Observations kept in memory. A session is a handful; this is generous. */
  maxObservations: 8,
  /** Frames kept on disk, newest first. */
  maxFrames: 12,
  maxElements: 400,
  captureTimeoutMs: 8_000,
  visionTimeoutMs: 45_000,
  maxTypeLength: 2_000,
  /**
   * Longest edge of the frame handed to the vision model, in pixels.
   *
   * A full 2× capture is 3024×1964 and costs ~2000 prompt tokens. Halving it
   * costs ~1650 and loses nothing that matters, because this frame is context
   * for reasoning and never a source of geometry — the positions come from the
   * accessibility tree. `sips` does the resize in about 130 ms.
   */
  visionMaxEdge: 1_600,
  /**
   * Context window for the vision pass.
   *
   * Measured, not chosen: at 4096 the image tokens plus the answer overflow and
   * Ollama returns HTTP 200 with an empty `response` and `done_reason: length`.
   * That failure is silent, which is exactly why the number is written down.
   */
  visionContextTokens: 8_192,
});

/** The local model that looks at the frame. Small, fast, and never leaves the machine. */
export const ASSISTANT_VISION_MODEL = "qwen3-vl:2b";

const VISION_PROMPT =
  "Describe this screen for someone who cannot see it: which application it appears to be, "
  + "the overall layout, what the main region shows, and any dialog, alert, or error visible. "
  + "Three sentences at most. Do not list coordinates or guess at pixel positions.";

/* ── Observation store ───────────────────────────────────────────────────── */

/**
 * In memory, on purpose. An observation is a photograph of the operator's
 * screen with every control on it enumerated; it is the most sensitive thing
 * this application handles, and it has no business outliving the process.
 */
const observations = new Map();

function pruneObservations(now = Date.now()) {
  for (const [id, entry] of observations) {
    if (now - entry.storedAt > ASSISTANT_LIMITS.observationTtlMs) observations.delete(id);
  }
  while (observations.size > ASSISTANT_LIMITS.maxObservations) {
    const oldest = observations.keys().next();
    if (oldest.done) break;
    observations.delete(oldest.value);
  }
}

export function rememberObservation(observation) {
  observations.set(observation.id, { ...observation, storedAt: Date.now() });
  pruneObservations();
  return observation;
}

export function recallObservation(id) {
  pruneObservations();
  return observations.get(id) ?? null;
}

/** Used by the tests and by a "forget what you saw" control in the interface. */
export function forgetObservations() {
  observations.clear();
}

/* ── Capture ─────────────────────────────────────────────────────────────── */

function runCapture(path, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    // -x: no shutter sound. -t jpg: a full-screen PNG at 2× is ~8 MB and the
    // vision model does not benefit from any of it.
    const child = spawn("/usr/sbin/screencapture", ["-x", "-t", "jpg", path], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new PointerError("CAPTURE_TIMEOUT", "The screen capture did not finish."));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.on("error", () => {
      clearTimeout(timer);
      rejectPromise(new PointerError("CAPTURE_UNAVAILABLE", "screencapture is not available on this system."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(path);
      // screencapture exits non-zero when Screen Recording has not been granted,
      // which is a permission problem and must be named as one.
      else rejectPromise(new PointerError("SCREEN_RECORDING_DENIED", "The screen could not be captured. Screen Recording permission is required."));
    });
  });
}

async function pruneFrames(directory) {
  try {
    const entries = await readdir(directory);
    const frames = entries.filter((name) => name.endsWith(".jpg")).sort();
    // Each frame has a downscaled sibling; the cap counts both, which is why it
    // is doubled here rather than halved in the limit.
    for (const stale of frames.slice(0, Math.max(0, frames.length - ASSISTANT_LIMITS.maxFrames * 2))) {
      await rm(join(directory, stale), { force: true });
    }
  } catch {
    /* A directory that cannot be read is a directory with nothing to prune. */
  }
}

/**
 * A copy of the frame at a size the vision model is happy with.
 *
 * Written beside the original with a `-small` suffix rather than in place, so
 * the full-resolution frame stays on disk for the operator to look at. If sips
 * is unavailable the original is used — a slower description is better than
 * none.
 */
async function downscaleForVision(framePath) {
  const small = framePath.replace(/\.jpg$/, "-small.jpg");
  try {
    const { copyFile } = await import("node:fs/promises");
    await copyFile(framePath, small);
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("/usr/bin/sips", ["-Z", String(ASSISTANT_LIMITS.visionMaxEdge), small], { stdio: "ignore" });
      child.on("error", rejectPromise);
      child.on("close", (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error("sips failed"))));
    });
    return small;
  } catch {
    return framePath;
  }
}

/**
 * What the local vision model sees.
 *
 * Context for reasoning, never a source of geometry — the element inventory is
 * where positions come from. A failure here is not a failure of the
 * observation: an assistant that can name every control on screen but cannot
 * describe the wallpaper is still an assistant.
 */
async function describeFrame(config, framePath, fetchImpl) {
  const { readFile } = await import("node:fs/promises");
  try {
    const bytes = await readFile(await downscaleForVision(framePath));
    const response = await fetchImpl(new URL("api/generate", config.ollamaUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(ASSISTANT_LIMITS.visionTimeoutMs),
      body: JSON.stringify({
        model: ASSISTANT_VISION_MODEL,
        stream: false,
        keep_alive: "5m",
        options: { num_ctx: ASSISTANT_LIMITS.visionContextTokens, num_predict: 260, temperature: 0.1 },
        prompt: VISION_PROMPT,
        images: [bytes.toString("base64")],
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const text = typeof payload?.response === "string" ? payload.response.trim() : "";
    return text || null;
  } catch {
    return null;
  }
}

/**
 * One look at the screen.
 *
 * Degrades rather than fails. Without Accessibility there is no element
 * inventory, so the assistant can describe the screen but cannot point at or
 * touch anything — and `limits` says exactly that, so the interface can too.
 */
export async function observe(config, options = {}) {
  const {
    pid = null,
    maxElements = 120,
    describe = true,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
  } = options;

  const permissions = await pointerPermissions();
  if (!permissions.supported) throw new PointerError("PLATFORM_UNSUPPORTED", "Screen control is macOS-only.");
  if (!permissions.helperBuilt) {
    throw new PointerError("POINTER_HELPER_MISSING", "The pointer helper has not been built. Run: npm run build:pointer");
  }

  const limits = [];
  const directory = config.assistantFramePath;
  await mkdir(directory, { recursive: true });

  const capturedAt = now();
  const id = `obs_${randomUUID()}`;
  const framePath = join(directory, `${capturedAt.toISOString().replace(/[:.]/g, "-")}.jpg`);

  let frame = null;
  try {
    await runCapture(framePath, ASSISTANT_LIMITS.captureTimeoutMs);
    frame = { path: framePath };
  } catch (error) {
    // A missing frame is survivable: the element inventory is the part the
    // assistant actually acts on.
    limits.push(error.code === "SCREEN_RECORDING_DENIED"
      ? "Screen Recording is not granted, so the assistant cannot see the screen — only the controls the accessibility API reports."
      : "The screen could not be captured.");
  }

  let tree = { application: null, elements: [], truncated: false, screens: [], window: null };
  try {
    tree = await pointerTree({ pid, max: Math.min(ASSISTANT_LIMITS.maxElements, maxElements * 4) });
  } catch (error) {
    if (error.code === "ACCESSIBILITY_DENIED") {
      limits.push("Accessibility is not granted, so the assistant cannot see or touch individual controls. It can still describe the screen.");
    } else {
      limits.push(`The accessibility tree could not be read: ${error.message}`);
    }
    // Display geometry needs no permission at all, and the interface uses it to
    // size the overlay. Losing the tree must not also lose the screens.
    try {
      tree.screens = await pointerScreens();
    } catch {
      /* Then there is genuinely nothing to report. */
    }
  }

  const sceneDescription = describe && frame ? await describeFrame(config, framePath, fetchImpl) : null;
  await pruneFrames(directory);

  const observation = {
    id,
    capturedAt: capturedAt.toISOString(),
    application: tree.application ?? { name: "Unknown", bundleId: "", pid: 0 },
    window: tree.window ?? null,
    screens: Array.isArray(tree.screens) ? tree.screens : [],
    elements: Array.isArray(tree.elements) ? tree.elements : [],
    truncated: Boolean(tree.truncated),
    sceneDescription,
    frame,
    limits,
  };

  return rememberObservation(observation);
}

/* ── Acting ──────────────────────────────────────────────────────────────── */

function centre(frame) {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

function onAnyScreen(screens, point) {
  if (!Array.isArray(screens) || screens.length === 0) return true;
  return screens.some(
    (screen) => point.x >= screen.x
      && point.y >= screen.y
      && point.x <= screen.x + screen.width
      && point.y <= screen.y + screen.height,
  );
}

/**
 * Executes one step against one stored observation.
 *
 * `step` arrives already shaped by the renderer's validator, but nothing here
 * trusts that: the same checks run again, because this function is reachable
 * over HTTP and the renderer is not the only thing that can call it.
 */
export async function act(observationId, step, options = {}) {
  const { checkFrontmost = true } = options;
  const observation = recallObservation(observationId);
  if (!observation) {
    throw new PointerError("OBSERVATION_EXPIRED", "That look at the screen is no longer current. Take another one.");
  }
  if (Date.now() - observation.storedAt > ASSISTANT_LIMITS.observationTtlMs) {
    throw new PointerError("OBSERVATION_EXPIRED", "That look at the screen is no longer current. Take another one.");
  }

  const kind = step?.kind;
  if (typeof kind !== "string") throw new PointerError("INVALID_STEP", "The step named no action.");

  // Steps that never touch a coordinate need no target and no app check.
  if (kind === "wait") {
    const ms = Math.min(5_000, Math.max(0, Number(step.ms) || 0));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
    return { kind, waitedMs: ms };
  }

  if (checkFrontmost && observation.application?.pid) {
    let frontmost = null;
    try {
      frontmost = await pointerFrontmost();
    } catch {
      frontmost = null;
    }
    if (frontmost && frontmost.pid !== observation.application.pid) {
      throw new PointerError(
        "APPLICATION_CHANGED",
        `The front application is now ${frontmost.name}, not ${observation.application.name}. Take another look before acting.`,
      );
    }
  }

  if (kind === "type") {
    const text = typeof step.text === "string" ? step.text : "";
    if (!text) throw new PointerError("TEXT_REQUIRED", "There was no text to type.");
    if (text.length > ASSISTANT_LIMITS.maxTypeLength) throw new PointerError("TEXT_TOO_LONG", "The text to type is too long.");
    await pointerType(text);
    return { kind, characters: text.length };
  }

  if (kind === "key") {
    if (typeof step.chord !== "string" || !step.chord) throw new PointerError("CHORD_REQUIRED", "There was no chord to press.");
    await pointerKey(step.chord);
    return { kind, chord: step.chord };
  }

  // Everything remaining aims at a point, and the point comes from the
  // operating system's own report of where the element is.
  const element = observation.elements.find((entry) => entry.id === step.element);
  if (!element) {
    throw new PointerError("UNKNOWN_ELEMENT", `"${step.element}" is not an element from that look at the screen.`);
  }
  if (element.enabled === false) {
    throw new PointerError("ELEMENT_DISABLED", `"${element.label ?? element.id}" is disabled.`);
  }

  const point = centre(element.frame);
  if (!onAnyScreen(observation.screens, point)) {
    throw new PointerError("OFF_SCREEN", "That element is no longer on any connected screen.");
  }

  switch (kind) {
    case "point":
      await pointerMove(point.x, point.y);
      return { kind, element: element.id, point };
    case "click":
      await pointerClick(point.x, point.y, {
        button: step.button === "right" ? "right" : "left",
        count: Math.min(3, Math.max(1, Number(step.count) || 1)),
      });
      return { kind, element: element.id, point };
    case "scroll":
      await pointerScroll(point.x, point.y, { dx: Number(step.dx) || 0, dy: Number(step.dy) || 0 });
      return { kind, element: element.id, point };
    default:
      throw new PointerError("INVALID_STEP", `"${kind}" is not something this assistant can do.`);
  }
}

/** What the interface needs to tell the operator what is and is not possible. */
export async function assistantCapabilities() {
  return pointerPermissions();
}

/** Raises the system's own Accessibility dialog. Only on an explicit request. */
export async function requestAccessibility() {
  return pointerPermissions({ prompt: true });
}
