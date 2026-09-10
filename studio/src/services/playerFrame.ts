/**
 * One frame of what the operator is watching, on request.
 *
 * `player` tells the agent where the position is and `player_control` moves
 * it; neither is *seeing* the film. This is the third channel: the gateway
 * asks on the run's own NDJSON stream, the pane that owns the picture answers
 * here, and the answer goes back on its own POST because the stream runs one
 * way. `requestPlayerFrame` in `server/permission-bridge.js` is the other end
 * of it, and `services/cameraFrame.ts` is the precedent this follows.
 *
 * ## Why the pane registers a source rather than this file finding one
 *
 * There is no `document.querySelector("video")` here, deliberately. A window
 * can hold more than one video element at once — the editor's compositor
 * keeps one per clip (`src/video/engine/videoEngine.ts`), and a camera capture
 * makes one that is never in the document — and picking "the first one" would
 * quietly photograph the wrong surface. The pane that is actually showing the
 * player registers itself and unregisters on unmount, so the answer is either
 * that pane's picture or an honest "nothing is playing".
 *
 * ## Why the capture is here and not in playerControl.ts
 *
 * That module is imported by `tests/player-state.test.mjs` under plain node
 * and must stay free of runtime imports. This one draws on a canvas and talks
 * to the gateway, so it is a renderer module and says so.
 */

import { GatewayClient } from "./gatewayClient";

/**
 * What the agent gets, or why it did not.
 *
 * `image` is base64 JPEG with no data-URI prefix, the same shape
 * `cameraFrame.ts` sends — and the word is `image`, singular, at every step
 * from here to `resolvePlayerFrame`. The camera's path says `images` at one
 * end and `image` at the other, which is why `look_at_me` fails; this one is
 * pinned by `tests/player-frame.test.mjs`.
 */
export interface PlayerFrameCapture {
  image?: string;
  time?: number;
  duration?: number | null;
  title?: string | null;
  error?: string;
}

/** What a registered pane hands back: the element it is showing, and what it is. */
export interface PlayerFrameSource {
  element: HTMLVideoElement | null;
  title: string | null;
  /**
   * Where mpv owns the picture, the pane hands a capture instead of an element.
   *
   * There is no third way to write this. An embedded mpv draws into a native
   * window layered over the document — the frame is in another process, on a
   * surface `drawImage` cannot read and `document.querySelector` cannot find —
   * so the canvas below has nothing to photograph and `element` is honestly
   * null. main asks mpv for the frame instead (`mpv-view:frame`).
   *
   * The pane supplies the position and duration with it, because they are
   * mpv's answer rather than an element's and the pane is already holding
   * them; `title` stays this side, since it is the same either way.
   */
  engine?: (() => Promise<Omit<PlayerFrameCapture, "title">>) | null;
}

/**
 * How big a frame is worth sending.
 *
 * `cameraFrame.ts` sends a still at 1024px because a face at arm's length
 * fills it. A film frame carries text — a caption, a sign, a name in the
 * credits — and text is the first thing a downscale destroys, so this is
 * wider. Still an order of magnitude smaller than a 1080p frame at full size.
 */
const FRAME_WIDTH = 1280;
const FRAME_QUALITY = 0.82;

let source: (() => PlayerFrameSource) | null = null;

/** The pane showing the player registers here for as long as it is mounted. */
export function registerPlayerFrameSource(next: () => PlayerFrameSource): () => void {
  source = next;
  return () => {
    if (source === next) source = null;
  };
}

/**
 * One frame, encoded. Never throws: every failure is a sentence the agent can
 * repeat to the operator, because "the file is still loading" is an answer and
 * a rejected promise is not.
 *
 * Async because one of the two paths crosses a process boundary — mpv is asked
 * for its frame — and the element path stays synchronous inside this promise
 * rather than being made to wait for anything.
 */
export async function capturePlayerFrame(): Promise<PlayerFrameCapture> {
  const showing = source?.();
  /*
    The engine path first, and it is not a fallback: while mpv holds the
    picture the pane's `element` is null on purpose, so asking the element
    first would answer "No video is open" about a film that is playing.
  */
  if (showing?.engine) {
    try {
      return { title: showing.title ?? null, ...(await showing.engine()) };
    } catch {
      return { error: "The player could not be asked for a frame." };
    }
  }
  const video = showing?.element ?? null;
  if (!video) return { error: "No video is open in the operator's player." };
  /*
    `readyState` below HAVE_CURRENT_DATA means the element has no frame to
    give — it is opening the file, or a transcoded stream is reloading after a
    seek. Drawing anyway paints a blank canvas, and a black rectangle is worse
    than a sentence: the model cannot tell it from a dark scene.
  */
  if (video.readyState < 2 || !(video.videoWidth > 0)) {
    return { error: "The player has no picture yet — it is still opening the file. Try again in a moment." };
  }

  const scale = Math.min(1, FRAME_WIDTH / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return { error: "This build could not encode a frame." };

  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", FRAME_QUALITY);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return { error: "This build could not encode a frame." };
    return {
      image: dataUrl.slice(comma + 1),
      time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      title: showing?.title ?? null,
    };
  } catch {
    /*
      A canvas that has drawn cross-origin video is tainted and `toDataURL`
      throws a SecurityError. It should not happen — the player reads files
      through the gateway on this origin — but a remote source would fail here
      rather than anywhere useful, so it gets its own sentence.
    */
    return { error: "That video cannot be read as a picture in this window." };
  }
}

/**
 * Answer one request from a live agent run. The answer goes back on its own
 * request, the same shape an approval's and a camera frame's do.
 */
export async function answerPlayerFrameRequest(runId: string, id: string): Promise<void> {
  const capture = await capturePlayerFrame();
  try {
    await GatewayClient.request("/api/workspace/player-frame", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, id, ...capture }),
    });
  } catch {
    /* The bridge times out on its own; a failed POST needs no second failure. */
  }
}
