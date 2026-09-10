/* ═══════════════════════════════════════════════════════════════════
   The recorder bridge, as the renderer sees it.

   Every shape here is the *answer* to one `recorder:*` handler in
   `electron/screenRecorder.cjs`. That file is CommonJS with JSDoc
   typedefs and this one is TypeScript, so the two cannot share a
   definition — which makes this file a contract kept honest by hand.
   When a handler's return shape changes, change it here in the same
   edit, or the renderer type-checks against a promise the main process
   stopped making.

   The bridge is optional on `window.teminali`: a browser build has no
   preload at all. Every consumer must degrade rather than assume, which
   is why `screenCapture.ts` carries a `getDisplayMedia` path beside the
   Electron one.
   ═══════════════════════════════════════════════════════════════════ */

/** One display or window offered by `desktopCapturer`. */
export interface RecorderSource {
  /** The id to hand back in `CaptureSettings.sourceId`. */
  id: string;
  name: string;
  kind: "screen" | "window";
  /** Only a display has one. A window's cursor cannot be placed in a frame. */
  displayId: number | null;
  /** Real pixels. Null for a window, whose size is unknown until its stream starts. */
  width: number | null;
  height: number | null;
  scaleFactor: number;
  primary: boolean;
  /** A data URL, or null when the thumbnail came back empty. */
  thumbnail: string | null;
  icon: string | null;
  /**
   * This source IS Teminali OS's own window.
   *
   * Only main can tell: `getMediaSourceId()` is a BrowserWindow method,
   * and matching on the title would break the first time it carried a
   * file name. It matters because `hideWindow` would otherwise hide the
   * subject of the capture, and a hidden window delivers no frames.
   */
  isSelf?: boolean;
}

export interface RecorderSourcesResult {
  ok: boolean;
  error?: string;
  /**
   * True when macOS reported zero displays, which it only does when
   * screen recording is denied. `getMediaAccessStatus` answers
   * "granted" from a stale TCC row and cannot be trusted for this.
   */
  deniedDespiteSettings?: boolean;
  sources: RecorderSource[];
}

export type PermissionState =
  | "not-determined" | "granted" | "denied" | "restricted" | "unknown";

/** Whether zooms will be placed on real input or inferred from the cursor. */
export interface InputCaptureStatus {
  ok: boolean;
  source: "events" | "cursor-only";
  reason: "ready" | "not-installed" | "needs-accessibility" | "failed";
  /** One sentence, written for the person reading the panel. */
  message: string;
}

export interface RecorderPermissions {
  platform: string;
  screen: PermissionState;
  camera: PermissionState;
  microphone: PermissionState;
  /** False where the floating bar will appear in the take. */
  barHiddenFromCapture: boolean;
  input: InputCaptureStatus;
}

export type PermissionKind = "screen" | "camera" | "microphone" | "accessibility";

/** A cursor position, sampled at 30Hz by the main process. */
export interface CursorSample {
  /** Milliseconds into the recording, paused time removed. */
  tMs: number;
  /** Normalised against the captured display's bounds. */
  x: number;
  y: number;
}

export type InputKind = "click" | "rightclick" | "scroll" | "key";

/** A real click, scroll or keystroke. Empty when the input hook could not run. */
export interface InputEvent {
  tMs: number;
  kind: InputKind;
  x: number;
  y: number;
}

/** A line of speech with the moment it was said. */
export interface SpeechCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface BeginResult {
  ok: boolean;
  error?: string;
  sessionId: string;
  dir: string;
  /** False for a window capture: there is no frame to place the pointer in. */
  cursorTracked: boolean;
  /** The global shortcuts actually taken, as accelerator strings. */
  shortcuts: string[];
  barHiddenFromCapture: boolean;
  input: InputCaptureStatus;
}

export interface RecordedFile {
  path: string;
  /** A `file://` URL, or "" when nothing was written. */
  url: string;
  bytes: number;
  /** Still a raw .webm, because ffmpeg was missing or refused it. */
  raw: boolean;
  error?: string;
}

/**
 * How far through converting a finished take, while `finish` is awaiting.
 *
 * `percent` is null when the take's duration was never known, and the
 * panel draws an indeterminate bar rather than inventing a number.
 *
 * `finalising` is not a rounding of "nearly done": `-movflags +faststart`
 * rewrites the whole output after the last frame is converted, and that
 * pass reports nothing at all. It is a real stage with a real cost, so
 * it is named rather than shown as a full bar that has stopped moving.
 */
export interface RecorderConvertProgress {
  percent: number | null;
  phase: "converting" | "finalising";
  /** A stream copy is near disk speed; a re-encode is not, and says so. */
  pass: "copy" | "encode";
  /** ffmpeg's own "12.4x", or null before the first frame. */
  speed: string | null;
}

export interface RecordingResult {
  ok: true;
  dir: string;
  /** From the clock, not the file: a MediaRecorder container carries no duration. */
  durationMs: number;
  files: Partial<Record<"screen" | "camera", RecordedFile>>;
  cursor: CursorSample[];
  events: InputEvent[];
  marks: number[];
  cursorTracked: boolean;
  scaleFactor: number;
}

/** What the sealed sidecar holds, once opened. */
export interface TakeManifest {
  durationMs: number;
  scaleFactor: number;
  marks: number[];
  events: InputEvent[];
  samples: CursorSample[];
}

export type LiveStreamService = "youtube" | "twitch" | "facebook" | "custom";

export interface LiveStreamConfig {
  enabled: boolean;
  service: LiveStreamService;
  rtmpUrl: string;
  streamKey: string;
  bitrateKbps: number;
  saveLocal: boolean;
}

export type LiveStreamState = "idle" | "connecting" | "live" | "reconnecting" | "error" | "ended";

export interface LiveStreamStatus {
  active: boolean;
  status: LiveStreamState;
  error?: string;
  bytesSent?: number;
  durationMs?: number;
  fps?: number;
}

/** Stop, pause or mark, arriving from the floating bar or a global shortcut. */
export interface RecorderCommand {
  action?: "stop" | "pause" | "mark";
  source?: "bar" | "shortcut";
  paused?: boolean;
}

/**
 * What the floating bar draws. Pushed by the window that records.
 *
 * `recorder:publishState` forwards this object verbatim, so the contract
 * is between the two renderers — `video/store/recorderStore.ts` writes it
 * and `components/recorder/RecorderBar.tsx` reads it — and main never
 * looks inside.
 */
export interface RecorderBarState {
  /** A `RecorderPhase`, as a bare string: the bar does not import the store. */
  phase: string;
  elapsedMs: number;
  markCount: number;
  /** The watchdog's message while a take is recording nothing. */
  fault: string | null;
  /** True when broadcasting to a live streaming destination like YouTube. */
  isLive?: boolean;
  /** Real-time status of the live stream connection. */
  liveStatus?: LiveStreamState | null;
}

export interface RecorderBridge {
  sources: (thumbWidth?: number) => Promise<RecorderSourcesResult>;
  permissions: () => Promise<RecorderPermissions>;
  requestPermission: (kind: PermissionKind) => Promise<{ granted: boolean; opened: boolean }>;
  resetScreenPermission: () => Promise<{ ok: boolean; message: string }>;
  relaunch: () => Promise<boolean>;

  begin: (options: {
    streams: ("screen" | "camera")[];
    displayId: number | null;
    hideWindow: boolean;
    /**
     * What is being captured, so main can tell whether it is being asked
     * to hide the subject. See `hideWindow` in `electron/screenRecorder.cjs`.
     */
    sourceId: string;
    live?: LiveStreamConfig;
  }) => Promise<BeginResult>;
  chunk: (
    sessionId: string,
    stream: "screen" | "camera",
    bytes: Uint8Array,
  ) => Promise<{ ok: boolean; error?: string; bytes?: number }>;
  liveChunk: (
    sessionId: string,
    bytes: Uint8Array,
  ) => Promise<{ ok: boolean; error?: string; bytes?: number }>;
  pause: (sessionId: string, paused: boolean) => Promise<{ ok: boolean }>;
  finish: (
    sessionId: string,
    copyable: boolean,
  ) => Promise<RecordingResult | { ok: false; error: string }>;
  cancel: (
    sessionId: string,
    discard: boolean,
  ) => Promise<{ ok: boolean; dir?: string; discarded?: boolean }>;

  writeTakeAsset: (
    dir: string,
    name: string,
    bytes: Uint8Array,
  ) => Promise<{ ok: boolean; path?: string; url?: string; bytes?: number; error?: string }>;
  readManifest: (
    dir: string,
  ) => Promise<{ ok: boolean; manifest?: TakeManifest; error?: string; reason?: string }>;
  reveal: (path: string) => Promise<boolean>;

  publishState: (state: RecorderBarState) => Promise<boolean>;
  barCommand: (action: "stop" | "pause" | "mark") => Promise<boolean>;
  testLiveConnection: (options: {
    rtmpUrl: string;
    streamKey: string;
  }) => Promise<{ ok: boolean; message?: string; error?: string }>;

  /** Returns an unsubscribe function. */
  onCommand: (listener: (command: RecorderCommand) => void) => () => void;
  /** Bar window only. Returns an unsubscribe function. */
  onState: (listener: (state: RecorderBarState) => void) => () => void;
  /** How far through the remux. Returns an unsubscribe function. */
  onConvert: (listener: (progress: RecorderConvertProgress) => void) => () => void;
  /** Live stream status updates. Returns an unsubscribe function. */
  onLiveStatus: (listener: (status: LiveStreamStatus) => void) => () => void;
}
