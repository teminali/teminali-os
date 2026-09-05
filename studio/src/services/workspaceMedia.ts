/**
 * The renderer's half of the media player.
 *
 * Video and audio never travel `/api/workspace/file`: that reader returns one
 * JSON document under an 8 MB cap, and a `<video>` seeks by asking for byte
 * ranges. The bytes come instead from `teminali-media://`, a protocol the
 * desktop app registers in `electron/workspaceMedia.cjs` and serves through
 * `server/workspace-media.js` — the same path guard and the same symlink
 * refusal as the reader, plus HTTP Range. The renderer never sees the root;
 * it asks the preload bridge for a URL and points an element at it.
 *
 * What lives here is what a component would otherwise have to get right in
 * JSX: which element a path needs, how the URL is spelled, what a
 * `MediaError` code means in words an operator can act on, and the clock a
 * duration reads as. All of it is pure and node-tested in
 * `tests/workspace-media.test.mjs`, which also pins this table to the
 * gateway's `MEDIA_EXTENSIONS` — a format admitted by one side and not the
 * other is a tab that opens onto nothing.
 */

/** Extension → mime type. Must equal `MEDIA_EXTENSIONS` in server/workspace.js. */
export const WORKSPACE_MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

export interface WorkspaceMedia {
  kind: "video" | "audio";
  mimeType: string;
}

/** What `window.teminali.workspaceMedia` exposes in the desktop app. */
export interface WorkspaceMediaBridge {
  /** A playable URL for an already percent-encoded workspace-relative path. */
  url(encodedPath: string): string | null;
  /** Tells main which root a relative path is under. Ignored by a packaged app, which reads it off its own gateway. */
  announceRoot(root: string): void;
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** The element a path needs, or null when it is not media at all. */
export function workspaceMediaOf(path: string): WorkspaceMedia | null {
  const mimeType = WORKSPACE_MEDIA_TYPES[extensionOf(path)];
  if (!mimeType) return null;
  return { kind: mimeType.startsWith("video/") ? "video" : "audio", mimeType };
}

/** The bridge, or null in a browser build — where there is no protocol to point at. */
export function workspaceMediaBridge(): WorkspaceMediaBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { teminali?: { workspaceMedia?: WorkspaceMediaBridge } }).teminali?.workspaceMedia;
  return bridge ?? null;
}

/**
 * Each segment encoded on its own, so a `#` or a space in a file name reaches
 * main as part of the path and not as a fragment or a break.
 */
export function workspaceMediaUrl(bridge: WorkspaceMediaBridge | null | undefined, path: string): string | null {
  if (!bridge) return null;
  return bridge.url(path.split("/").map(encodeURIComponent).join("/"));
}

export const NEEDS_DESKTOP_APP = "Playing video and audio needs the desktop app — a browser build has no media protocol to stream from.";

/**
 * A `MediaError.code` in words, naming the fix.
 *
 * Chromium's player is the whole player: H.264 and VP9 for video, AAC, MP3,
 * Opus, FLAC and WAV for audio. The container list the gateway admits says
 * nothing about the codec inside, so "not supported" arrives here often and
 * means one of a few known things. Real-time transcoding is a separate
 * project; ffmpeg on the command line is the honest fix today.
 */
export function describeMediaError(code: number, path: string): string {
  const extension = extensionOf(path);
  switch (code) {
    case 4: {
      // MEDIA_ERR_SRC_NOT_SUPPORTED
      const convert = "Convert it with ffmpeg: `ffmpeg -i input -c:v libx264 -c:a aac output.mp4`.";
      if (extension === ".mov") return `Chromium plays H.264 in a .mov, but not ProRes or HEVC, which is what a camera or Final Cut usually writes. ${convert}`;
      if (extension === ".mp4" || extension === ".m4v") return `Chromium plays H.264 + AAC in an MP4, but not HEVC (H.265) video or AC-3 audio. ${convert}`;
      if (extension === ".webm") return `Chromium plays VP8, VP9 and AV1 in WebM; this one holds something else. ${convert}`;
      return `Chromium's player reads AAC, MP3, Opus, FLAC and WAV; this file holds a codec it does not. Convert it with ffmpeg: \`ffmpeg -i input -c:a aac output.m4a\`.`;
    }
    case 3: // MEDIA_ERR_DECODE
      return "Chromium started to play this file and could not decode the rest — it is damaged, or switches to a codec the player lacks part-way through. Re-encode it with ffmpeg.";
    case 2: // MEDIA_ERR_NETWORK
      return "The stream stopped: the desktop media protocol did not answer. Reopen the file; if it keeps happening, the app's log names the refusal.";
    case 1: // MEDIA_ERR_ABORTED
      return "Playback was stopped before it started.";
    default:
      return "Chromium reported an error it did not name.";
  }
}

/** `m:ss`, or `h:mm:ss` past an hour; a stream with no end is "live". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return seconds === Number.POSITIVE_INFINITY ? "live" : "";
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`;
}

/**
 * Keeps main told which project is open, for a development build.
 *
 * A packaged app runs the gateway in its own main process and reads the live
 * root off it; `npm start` runs the gateway as a sibling process main cannot
 * see, so the renderer — which learns the root from `/api/workspace/projects`
 * — repeats it. Main validates it as an existing directory and, when it has a
 * gateway of its own, ignores it.
 */
export function syncWorkspaceMediaRoot(store: {
  getState(): { workspacePath: string };
  subscribe(listener: (state: { workspacePath: string }) => void): () => void;
}): () => void {
  const bridge = workspaceMediaBridge();
  if (!bridge) return () => {};
  let last: string | null = null;
  const announce = (state: { workspacePath: string }) => {
    if (!state.workspacePath || state.workspacePath === last) return;
    last = state.workspacePath;
    bridge.announceRoot(state.workspacePath);
  };
  announce(store.getState());
  return store.subscribe(announce);
}
