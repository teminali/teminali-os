/**
 * The operator's camera, on request — one look, or a sequence of them.
 *
 * The gateway has `screencapture` for the screen and nothing at all for a
 * camera: on macOS the only way to open one is `getUserMedia`, which exists in
 * a renderer and nowhere else. So the agent's request travels out on the run's
 * own NDJSON stream and is answered here — see `requestCameraFrame` in
 * `server/permission-bridge.js` for the other end of it.
 *
 * ## What costs what, measured
 *
 * Measured in Electron on this machine, against the real camera:
 *
 * | | |
 * | --- | --- |
 * | `getUserMedia` resolving (the hardware opening) | 320–700 ms |
 * | first presented frame after that | ~540 ms |
 * | **cold, to a frame worth looking at** | **~0.9 s** |
 * | **a second look while the camera is still open** | **~31 ms** |
 * | encoding one frame, 1024 px q0.82 | 6 ms, ~100 KB |
 * | encoding one frame, 640 px q0.70 | 2 ms, ~38 KB |
 *
 * Two things follow from that table, and they are the whole design.
 *
 * **The waiting was in the wrong place.** The first version awaited `play()`
 * and then slept a flat 700 ms for the sensor to settle. Both were guesses:
 * `play()` resolving is not the same event as a frame arriving, and on this
 * camera the very first presented frame is already correctly exposed — the
 * sleep was 700 ms of a lit camera and no picture. Waiting on
 * `requestVideoFrameCallback` waits for the actual thing being waited for, is
 * shorter here, and is *longer* exactly where it should be: on a camera whose
 * first frames really are black, it waits for a real one rather than for a
 * number somebody picked.
 *
 * **A look is only expensive the first time.** 31 ms against 900 ms is the
 * difference between "take a photograph" and "watch what I am doing", so the
 * stream is held open for `WARM_HOLD_MS` after each capture and the next look
 * inside that window skips the whole opening. It is what makes a conversation
 * with a camera in it feel like being seen rather than being photographed.
 *
 * ## Why the light is allowed to stay on
 *
 * The first version closed the camera the instant it had its frame, on the
 * grounds that the light beside the lens is the only honest indicator a person
 * has. Holding the stream open keeps that light on for a few seconds longer —
 * and that is the more honest signal, not the less: during those seconds the
 * assistant genuinely may look again, and a light that goes dark between two
 * looks a second apart says something untrue. The hold is bounded, it is reset
 * only by an actual capture, and nothing renews it silently.
 */

import { GatewayClient } from "./gatewayClient";
import { clampSequence, frameGapMs } from "../utils/cameraSequence";

/**
 * How long the camera stays open after a look.
 *
 * Long enough to cover a model thinking about what it just saw and asking for
 * another frame; short enough that a single question does not leave the light
 * on while the operator has moved on. A capture resets it; nothing else does.
 */
const WARM_HOLD_MS = 10_000;

/** Give up rather than hold a camera that is producing nothing. */
const FIRST_FRAME_TIMEOUT_MS = 4_000;

/** One look: worth looking at, and worth sending. */
const STILL_WIDTH = 1024;
const STILL_QUALITY = 0.82;

/**
 * A sequence: smaller and cheaper per frame, deliberately.
 *
 * A burst is asked for to see *movement*, and movement survives a smaller
 * frame far better than it survives having only one of them. Six at this size
 * cost about what two stills do.
 */
const SEQUENCE_WIDTH = 640;
const SEQUENCE_QUALITY = 0.7;

/** What the camera gave back, or why it gave nothing. */
export type CameraCapture = { images: string[]; warm: boolean; tookMs: number } | { error: string };

interface WarmSession {
  stream: MediaStream;
  video: HTMLVideoElement;
  closeTimer: ReturnType<typeof setTimeout> | null;
}

let session: WarmSession | null = null;

function closeSession(): void {
  if (!session) return;
  if (session.closeTimer) clearTimeout(session.closeTimer);
  for (const track of session.stream.getTracks()) track.stop();
  session.video.srcObject = null;
  session = null;
}

function holdOpen(): void {
  if (!session) return;
  if (session.closeTimer) clearTimeout(session.closeTimer);
  session.closeTimer = setTimeout(closeSession, WARM_HOLD_MS);
}

/** Resolves on the next frame the compositor actually presents. */
function nextFrame(video: HTMLVideoElement, timeoutMs: number): Promise<boolean> {
  const withCallback = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: () => void) => number;
  };
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const onFrame = () => {
      clearTimeout(timer);
      done(true);
    };
    if (typeof withCallback.requestVideoFrameCallback === "function") {
      withCallback.requestVideoFrameCallback(onFrame);
    } else {
      // Anything without the callback still has a readyState to wait on. The
      // poll is the fallback, not the path.
      const poll = setInterval(() => {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          clearInterval(poll);
          onFrame();
        }
      }, 30);
      setTimeout(() => clearInterval(poll), timeoutMs);
    }
  });
}

function readable(error: unknown): string {
  const name = (error as DOMException)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "The operator has not allowed this app to use the camera. macOS asks once, in System Settings › Privacy & Security › Camera.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "There is no camera on this machine.";
  if (name === "NotReadableError") return "The camera is in use by something else.";
  return error instanceof Error ? error.message : "The camera could not be opened.";
}

/** The open camera, opening it first if it is not already open. */
async function ensureSession(): Promise<WarmSession> {
  if (session) return session;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  /*
    Deliberately not awaited. `play()` resolving is a promise about playback
    having started, not about a frame having arrived, and waiting on it cost
    ~540 ms more than waiting for the frame itself.
  */
  void video.play().catch(() => {});

  session = { stream, video, closeTimer: null };
  if (!(await nextFrame(video, FIRST_FRAME_TIMEOUT_MS))) {
    closeSession();
    throw new Error("The camera opened but produced no picture.");
  }
  return session;
}

function encode(video: HTMLVideoElement, width: number, quality: number): string | null {
  const sourceWidth = video.videoWidth || 1280;
  const sourceHeight = video.videoHeight || 720;
  const scale = Math.min(1, width / sourceWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const comma = dataUrl.indexOf(",");
  return comma < 0 ? null : dataUrl.slice(comma + 1);
}

/**
 * Take one frame, or a short sequence of them.
 *
 * Never throws. Every failure is a sentence the agent can repeat to the
 * operator, because "there is no camera on this machine" is an answer and a
 * rejected promise is not.
 */
export async function captureCameraFrames(options: { frames?: number; spanMs?: number } = {}): Promise<CameraCapture> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { error: "This build has no camera access." };
  }

  const { frames, spanMs } = clampSequence(options.frames, options.spanMs);
  const startedWarm = session !== null;
  const startedAt = Date.now();

  try {
    const open = await ensureSession();
    const width = frames > 1 ? SEQUENCE_WIDTH : STILL_WIDTH;
    const quality = frames > 1 ? SEQUENCE_QUALITY : STILL_QUALITY;
    const gap = frameGapMs(frames, spanMs);

    const images: string[] = [];
    for (let taken = 0; taken < frames; taken += 1) {
      if (taken > 0 && gap > 0) await new Promise((resolve) => { setTimeout(resolve, gap); });
      // Always encode a frame the compositor has presented, never whatever the
      // element happens to be holding.
      await nextFrame(open.video, FIRST_FRAME_TIMEOUT_MS);
      const image = encode(open.video, width, quality);
      if (image) images.push(image);
    }

    if (images.length === 0) return { error: "The camera opened but no frame could be encoded." };
    holdOpen();
    return { images, warm: startedWarm, tookMs: Date.now() - startedAt };
  } catch (error) {
    closeSession();
    return { error: readable(error) };
  }
}

/**
 * Answer one request from a live agent run.
 *
 * The answer goes back on its own request rather than on the stream, which
 * only runs one way — the same shape an approval's answer takes.
 */
export async function answerCameraRequest(
  runId: string,
  id: string,
  options: { frames?: number; spanMs?: number } = {},
): Promise<void> {
  const capture = await captureCameraFrames(options);
  try {
    await GatewayClient.request("/api/assistant/camera-frame", {
      method: "POST",
      body: JSON.stringify({ runId, id, ...capture }),
    });
  } catch {
    /* The bridge times out on its own; a failed POST needs no second failure. */
  }
}
