/**
 * One photograph, from the operator's camera, on request.
 *
 * The gateway has `screencapture` for the screen and nothing at all for a
 * camera: on macOS the only way to open one is `getUserMedia`, which exists in
 * a renderer and nowhere else. So the agent's request travels out on the run's
 * own NDJSON stream and is answered here — see `requestCameraFrame` in
 * `server/permission-bridge.js` for the other end of it.
 *
 * The camera is opened for the length of one frame and closed again. Not as a
 * courtesy: the light beside the lens is the only honest indicator a person
 * has, and a stream left running would leave it on long after the assistant
 * had stopped looking.
 */

import { GatewayClient } from "./gatewayClient";

/**
 * How long to let the sensor settle before reading it.
 *
 * A webcam's first frames are black, then grey, then correctly exposed; a
 * photograph taken the instant the track goes live is of nothing. This is the
 * shortest wait that reliably comes back with a picture of a room, and it is
 * spent with the camera already on, which is why it is not longer.
 */
const WARMUP_MS = 700;

/** Wide enough to be worth looking at, small enough to be worth sending. */
const FRAME_WIDTH = 1024;
const FRAME_QUALITY = 0.82;

/** What the camera gave back, or why it gave nothing. */
export type CameraFrame = { image: string } | { error: string };

function readable(error: unknown): string {
  const name = (error as DOMException)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "The operator has not allowed this app to use the camera. macOS asks once, in System Settings › Privacy & Security › Camera.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "There is no camera on this machine.";
  if (name === "NotReadableError") return "The camera is in use by something else.";
  return error instanceof Error ? error.message : "The camera could not be opened.";
}

/**
 * Take one frame and return it as base64 JPEG, without the data URL prefix.
 *
 * Never throws. Every failure is a sentence the agent can repeat to the
 * operator, because "there is no camera on this machine" is an answer and a
 * rejected promise is not.
 */
export async function captureCameraFrame(): Promise<CameraFrame> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { error: "This build has no camera access." };
  }

  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    await new Promise<void>((resolve) => { setTimeout(resolve, WARMUP_MS); });

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    if (!width || !height) return { error: "The camera opened but produced no picture." };

    const scale = Math.min(1, FRAME_WIDTH / width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    if (!context) return { error: "This build cannot read a frame from the camera." };
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    video.srcObject = null;

    const dataUrl = canvas.toDataURL("image/jpeg", FRAME_QUALITY);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return { error: "The frame could not be encoded." };
    return { image: dataUrl.slice(comma + 1) };
  } catch (error) {
    return { error: readable(error) };
  } finally {
    // Whatever happened, the light goes off.
    for (const track of stream?.getTracks() ?? []) track.stop();
  }
}

/**
 * Answer one request from a live agent run.
 *
 * The answer goes back on its own request rather than on the stream, which
 * only runs one way — the same shape an approval's answer takes.
 */
export async function answerCameraRequest(runId: string, id: string): Promise<void> {
  const frame = await captureCameraFrame();
  try {
    await GatewayClient.request("/api/assistant/camera-frame", {
      method: "POST",
      body: JSON.stringify({ runId, id, ...frame }),
    });
  } catch {
    /* The bridge times out on its own; a failed POST needs no second failure. */
  }
}
