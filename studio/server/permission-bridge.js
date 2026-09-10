/**
 * Answering a headless agent's permission prompts.
 *
 * `claude -p` has no terminal. Anything its permission mode does not settle
 * outright is therefore refused by default, which is the failure the operator
 * sees as "I can't launch VLC — the command needs your approval and this
 * session can't prompt for it": the turn ends having done nothing, and the
 * only way forward was to widen the mode for every future call as well.
 *
 * The CLI's way out is `--permission-prompt-tool`: name an MCP tool and it is
 * called instead of the terminal prompt. This is the other end of that tool.
 *
 * ## Why a token per run rather than the session bearer
 *
 * `agentEnvironment()` deletes `FRONTIER_SESSION_TOKEN` before spawning an
 * agent, so a CLI that shells out cannot turn around and drive the gateway.
 * Handing the shim that same token would undo it. Instead each run mints its
 * own, it reaches exactly one route, it authorises nothing but answering that
 * run's own prompts, and it dies with the run.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** A prompt nobody answers must not hold the agent open indefinitely. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** runId -> { token, emit, pending, cameras, browser, playerFrames, remembered, closed } */
const runs = new Map();

/**
 * Runs that have ended, most recent last. A caller still holding the token of
 * one — the screen shim of a turn the operator stopped — is told the turn is
 * over rather than that it was rejected, which it read as a broken connection.
 * Bounded: the ids are opaque and the point is the message, not the history.
 */
const ENDED_RUNS_REMEMBERED = 64;
const endedRuns = new Set();

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * What makes two requests "the same permission" for the purpose of
 * "always allow". The tool name alone is too coarse — allowing one `Bash`
 * would allow every command for the rest of the run — so a Bash call is keyed
 * by its first word, which is the thing an operator actually means to trust.
 */
export function approvalKey(toolName, input) {
  const name = String(toolName ?? "");
  if (name !== "Bash") return name;
  const command = String(input?.command ?? "").trim();
  const head = command.split(/\s+/)[0] ?? "";
  return head ? `Bash(${head})` : "Bash";
}

/** Begin a run. `emit` puts an event on that run's NDJSON stream. */
export function openRun(runId, emit) {
  const token = randomBytes(32).toString("base64url");
  runs.set(runId, { token, emit, pending: new Map(), cameras: new Map(), browser: new Map(), playerFrames: new Map(), remembered: new Set(), closed: false });
  return token;
}

/**
 * End a run. Every prompt still outstanding is denied: the process that asked
 * is gone, and a promise left hanging would keep a timer alive for five
 * minutes for an answer that can no longer be delivered anywhere.
 */
export function closeRun(runId) {
  const run = runs.get(runId);
  if (!run) return;
  run.closed = true;
  for (const entry of run.pending.values()) {
    clearTimeout(entry.timer);
    entry.settle({ behavior: "deny", message: "The agent turn ended before this was answered." });
  }
  run.pending.clear();
  /*
    A browser action outstanding when the turn ends is failed now rather than
    left to time out. The camera does not do this and does not need to: it is
    one call at the end of a thought, and half a minute of silence after a
    stopped turn costs nobody anything. A page is read, then clicked, then read
    again — so a stopped turn can have one of a chain in flight, and the shim
    holding it would sit there for the full timeout before the CLI could exit.
  */
  for (const entry of run.browser.values()) {
    clearTimeout(entry.timer);
    entry.settle(new Error("The agent turn ended before the browser answered."));
  }
  run.browser.clear();
  /* A frame is asked for in the same kind of chain — look, seek, look again — so it is failed now for the same reason. */
  for (const entry of run.playerFrames.values()) {
    clearTimeout(entry.timer);
    entry.settle(new Error("The agent turn ended before the player answered."));
  }
  run.playerFrames.clear();
  runs.delete(runId);
  endedRuns.add(runId);
  if (endedRuns.size > ENDED_RUNS_REMEMBERED) endedRuns.delete(endedRuns.values().next().value);
}

/** Whether `runId` was a run that has since ended, as opposed to one that never existed. */
export function runHasEnded(runId) {
  return endedRuns.has(runId);
}

export function runCount() {
  return runs.size;
}

/**
 * Ask the operator. Resolves with a verdict in the shape the CLI expects:
 * `{ behavior: "allow", updatedInput }` or `{ behavior: "deny", message }`.
 *
 * Never rejects. Every failure — an unknown run, a bad token, a prompt nobody
 * answered — is a denial with a reason, because a rejection here would surface
 * to the agent as a broken tool rather than as an answer it can act on.
 */
export function requestApproval({ runId, token, toolName, input = {} }) {
  const run = runs.get(runId);
  if (!run || run.closed) {
    return Promise.resolve({ behavior: "deny", message: "That agent turn is no longer running." });
  }
  if (!constantTimeEqual(token, run.token)) {
    return Promise.resolve({ behavior: "deny", message: "The permission bridge rejected the caller." });
  }

  const key = approvalKey(toolName, input);
  if (run.remembered.has(key)) {
    return Promise.resolve({ behavior: "allow", updatedInput: input });
  }

  const id = randomBytes(9).toString("base64url");
  return new Promise((resolve) => {
    let settled = false;
    const settle = (verdict) => {
      if (settled) return;
      settled = true;
      resolve(verdict);
    };
    const timer = setTimeout(() => {
      run.pending.delete(id);
      run.emit?.({ type: "permission-resolved", id, behavior: "deny" });
      settle({ behavior: "deny", message: "Nobody answered the approval request in time." });
    }, APPROVAL_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    // The input is kept so an allow that edits nothing can still answer with
    // it: the CLI runs `updatedInput`, and an allow that omits it runs nothing.
    run.pending.set(id, { settle, timer, key, input });
    run.emit?.({ type: "permission", id, toolName, input, key, expiresInMs: APPROVAL_TIMEOUT_MS });
  });
}

/**
 * The operator's answer, arriving on its own request because the run's stream
 * only goes one way. `remember` promotes an allow to every later call with the
 * same `approvalKey` for the rest of this run.
 */
export function resolveApproval({ runId, id, behavior, message, updatedInput, remember = false }) {
  const run = runs.get(runId);
  if (!run) return { ok: false, reason: "No such agent run." };
  const entry = run.pending.get(id);
  if (!entry) return { ok: false, reason: "That request was already answered." };

  run.pending.delete(id);
  clearTimeout(entry.timer);

  if (behavior === "allow") {
    if (remember) run.remembered.add(entry.key);
    entry.settle({ behavior: "allow", updatedInput: updatedInput ?? entry.input ?? {} });
  } else {
    entry.settle({ behavior: "deny", message: message || "The operator declined this." });
  }
  run.emit?.({ type: "permission-resolved", id, behavior: behavior === "allow" ? "allow" : "deny" });
  return { ok: true };
}

/**
 * How long the agent waits for a photograph.
 *
 * Shorter than an approval, and for the opposite reason: nobody is being asked
 * anything here. The operator has already said yes — the camera is opening,
 * a frame is being taken and sent straight back. All this covers is a window
 * that went away mid-capture, and a turn should not hang for a minute on one.
 */
const CAMERA_TIMEOUT_MS = 20_000;

/**
 * Ask the window holding this run for one frame from the camera.
 *
 * The gateway is a plain Node process. It has `screencapture` for the screen
 * and nothing at all for a camera: on macOS the only way to open one is
 * `getUserMedia`, which needs a renderer. So the request goes out on the run's
 * own NDJSON stream — the same one-way channel `emitToRun` uses for the file
 * tree — and the answer comes back on its own request, exactly as an
 * approval's does.
 *
 * Rejects rather than resolving to a failure shape: unlike an approval, there
 * is no useful "no" to hand the model. A camera that could not be opened is a
 * tool error the agent should report and move on from, not a verdict.
 */
export function requestCameraFrame({ runId, token, frames = 1, spanMs = 1200 }) {
  const run = runs.get(runId);
  if (!run || run.closed) return Promise.reject(new Error("That agent turn is no longer running."));
  if (!constantTimeEqual(token, run.token)) return Promise.reject(new Error("The camera bridge rejected the caller."));

  const id = randomBytes(9).toString("base64url");
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error, frame) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(frame);
    };
    const timer = setTimeout(() => {
      run.cameras.delete(id);
      settle(new Error("The window did not send a camera frame in time."));
    }, CAMERA_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    run.cameras.set(id, { settle, timer });
    const delivered = run.emit?.({ type: "camera", id, frames, spanMs, expiresInMs: CAMERA_TIMEOUT_MS });
    if (delivered === false) {
      run.cameras.delete(id);
      clearTimeout(timer);
      settle(new Error("This turn's stream is closed, so no window could be asked for a frame."));
    }
  });
}

/**
 * The frame, arriving on its own request because the run's stream only goes
 * one way. An `error` is the window saying why it could not — a denied camera
 * permission, no camera at all — and that reaches the agent as the tool's
 * failure rather than as a silence that times out.
 */
export function resolveCameraFrame({ runId, id, images, error, warm = false, tookMs = 0 }) {
  const run = runs.get(runId);
  if (!run) return { ok: false, reason: "No such agent run." };
  const entry = run.cameras.get(id);
  if (!entry) return { ok: false, reason: "That frame was already sent, or nothing asked for it." };

  run.cameras.delete(id);
  clearTimeout(entry.timer);
  const list = Array.isArray(images) ? images.filter((image) => typeof image === "string" && image) : [];
  if (error || list.length === 0) {
    entry.settle(new Error(String(error || "The window could not take a photograph.")));
  } else {
    entry.settle(null, { images: list, warm: Boolean(warm), tookMs: Number(tookMs) || 0, capturedAt: new Date().toISOString() });
  }
  return { ok: true };
}

/**
 * How long the agent waits for a frame of what is playing.
 *
 * Shorter than the camera's, and the difference is the hardware: a camera has
 * to be opened and has to settle, where the player's picture is already on
 * screen and the whole capture is a canvas draw. Long enough only for a pane
 * mid-reload — a transcoded stream reloads its element on a seek — to come
 * back with a frame rather than be declared missing.
 */
const PLAYER_FRAME_TIMEOUT_MS = 10_000;

/**
 * Ask the window holding this run for one frame of what is playing.
 *
 * The third of these, and the same shape for the same reason: the gateway is
 * a plain Node process with no picture in it. The frame is in a pane only the
 * renderer that owns the run can reach, so the request goes out on the run's
 * one-way NDJSON stream and the answer comes back on its own POST.
 *
 * Rejects rather than resolving to a failure shape, as the camera and the
 * browser do: "nothing is playing" is a tool error the agent reports and
 * works around, not a verdict to hand the operator.
 */
export function requestPlayerFrame({ runId, token }) {
  const run = runs.get(runId);
  if (!run || run.closed) return Promise.reject(new Error("That agent turn is no longer running."));
  if (!constantTimeEqual(token, run.token)) return Promise.reject(new Error("The player bridge rejected the caller."));

  const id = randomBytes(9).toString("base64url");
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error, frame) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(frame);
    };
    const timer = setTimeout(() => {
      run.playerFrames.delete(id);
      settle(new Error("The window did not send a frame of the player in time."));
    }, PLAYER_FRAME_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    run.playerFrames.set(id, { settle, timer });
    const delivered = run.emit?.({ type: "player-frame", id, expiresInMs: PLAYER_FRAME_TIMEOUT_MS });
    if (delivered === false) {
      run.playerFrames.delete(id);
      clearTimeout(timer);
      settle(new Error("This turn's stream is closed, so no window could be asked for a frame."));
    }
  });
}

/**
 * The frame, arriving on its own request because the run's stream only goes
 * one way.
 *
 * **`image`, singular, and the same word at both ends.** The camera's is
 * `images`, plural, at both ends of its own path — a different word for a
 * different thing, since a camera capture is a sequence and this is one frame.
 * The gateway's camera hop was once written with *this* file's spelling and
 * forwarded `image` into a reader expecting `images`, so `look_at_me` failed
 * every time it was called. Both pairs are pinned now, here by
 * `tests/player-frame.test.mjs` and there by `tests/camera-frame.test.mjs`.
 */
export function resolvePlayerFrame({ runId, id, image, error, time = null, duration = null, title = null }) {
  const run = runs.get(runId);
  if (!run) return { ok: false, reason: "No such agent run." };
  const entry = run.playerFrames.get(id);
  if (!entry) return { ok: false, reason: "That frame was already sent, or nothing asked for it." };

  run.playerFrames.delete(id);
  clearTimeout(entry.timer);
  const picture = typeof image === "string" ? image : "";
  if (error || !picture) {
    entry.settle(new Error(String(error || "The player could not produce a picture.")));
  } else {
    entry.settle(null, {
      image: picture,
      time: Number.isFinite(time) ? time : null,
      duration: Number.isFinite(duration) ? duration : null,
      title: typeof title === "string" ? title : null,
      capturedAt: new Date().toISOString(),
    });
  }
  return { ok: true };
}

/**
 * How long the agent waits for the browser panel to answer.
 *
 * Longer than a camera frame, and the sum says why: `browser-view:cdp` will
 * wait up to 5s for a navigation to settle before it starts, and then gives
 * the page 15s to answer one protocol command. A timeout shorter than
 * 5 + 15 would report "the window did not answer" for a page that was about
 * to, which is the least useful thing this could say.
 */
const BROWSER_TIMEOUT_MS = 30_000;

/**
 * Ask the window holding this run to read or drive its browser panel.
 *
 * The same shape as `requestCameraFrame`, and for the same reason: the gateway
 * is a plain Node process with no browser panel in it. The panel is a
 * `WebContentsView` owned by main, reachable only from the renderer that owns
 * the run — so the request goes out on the run's own NDJSON stream and the
 * answer comes back on its own POST.
 *
 * **Not `emitToRun`.** That is one-way, which is why `browse` can use it: it
 * puts a page in front of the operator and nothing comes back. A snapshot is
 * the whole point of the call, so this waits.
 *
 * `op` is a named operation — never a CDP method. The protocol is spoken in
 * exactly one file (electron/browserCdp.cjs) and nothing on this path knows
 * its vocabulary.
 *
 * Rejects rather than resolving to a failure shape, as the camera does: there
 * is no useful "no" to hand the model. A page that could not be read is a tool
 * error the agent reports and works around, not a verdict.
 */
export function requestBrowserAction({ runId, token, op, params = {} }) {
  const run = runs.get(runId);
  if (!run || run.closed) return Promise.reject(new Error("That agent turn is no longer running."));
  if (!constantTimeEqual(token, run.token)) return Promise.reject(new Error("The browser bridge rejected the caller."));

  const id = randomBytes(9).toString("base64url");
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      run.browser.delete(id);
      settle(new Error("The browser panel did not answer in time. The page may be showing a dialog."));
    }, BROWSER_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    run.browser.set(id, { settle, timer });
    const delivered = run.emit?.({ type: "browser", id, op, params, expiresInMs: BROWSER_TIMEOUT_MS });
    if (delivered === false) {
      run.browser.delete(id);
      clearTimeout(timer);
      settle(new Error("This turn's stream is closed, so no window could be asked about its browser."));
    }
  });
}

/**
 * The browser's answer, arriving on its own request because the run's stream
 * only goes one way. An `error` is the window saying why it could not — no
 * panel open, devtools holding the debugger, a ref that has gone — and that
 * reaches the agent as the tool's failure rather than as a silent timeout.
 */
export function resolveBrowserAction({ runId, id, result, error }) {
  const run = runs.get(runId);
  if (!run) return { ok: false, reason: "No such agent run." };
  const entry = run.browser.get(id);
  if (!entry) return { ok: false, reason: "That browser request was already answered, or nothing asked for it." };

  run.browser.delete(id);
  clearTimeout(entry.timer);
  if (error) {
    entry.settle(new Error(String(error)));
  } else if (!result || typeof result !== "object") {
    entry.settle(new Error("The browser panel answered with nothing this build could read."));
  } else {
    entry.settle(null, result);
  }
  return { ok: true };
}

/**
 * Does this token belong to this live run?
 *
 * The screen bridge asks, because it needs the same answer for a different
 * question. A run's token was minted to answer that run's approval prompts;
 * this widens it to also drive the screen on that run's behalf, and the
 * widening is deliberate rather than incidental: both are "this agent turn,
 * and only while it is running". The alternative was a second token with a
 * second lifecycle to keep in step with this one, which is a leak waiting to
 * be written.
 *
 * The authority this grants is still narrow. It reaches two routes, it opens
 * no others, and `closeRun` takes it away the moment the turn ends.
 */
export function runAuthorises(runId, token) {
  const run = runs.get(runId);
  if (!run || run.closed) return false;
  return constantTimeEqual(token, run.token);
}

/**
 * Put an event on a live run's stream, on that run's own authority.
 *
 * The renderer holds the file tree, and during an agent turn the only channel
 * that reaches it is the NDJSON stream the renderer itself opened by starting
 * the turn. The workspace bridge writes to it: an agent's `reveal` becomes a
 * `workspace` event on the stream its own turn is already being read from.
 *
 * Returns false rather than throwing when the run is gone. A turn the operator
 * stopped is a fact for the caller to report, not an exception — the gateway
 * turns it into the same 410 the screen bridge answers with.
 */
export function emitToRun(runId, token, event) {
  const run = runs.get(runId);
  if (!run || run.closed) return false;
  if (!constantTimeEqual(token, run.token)) return false;
  run.emit?.(event);
  return true;
}
