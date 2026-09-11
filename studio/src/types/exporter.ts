/*
  The typed shape of `window.teminali.exporter`.

  Optional on the bridge for the same reason `videoProjects` is: a browser
  build has no main process, so there is no ffmpeg to pipe frames into and no
  path to write them to. The editor says so rather than offering an Export
  button that opens a dialog and fails at the end of it.

  Every verb here answers one `export:*` handler in `electron/videoExport.cjs`.
  `tests/video-export.test.mjs` reads this file, the preload and the main
  module together and asserts the three agree.
*/

export interface ExportStartOptions {
  width: number;
  height: number;
  fps: number;
  codec: 'h264' | 'hevc' | 'prores';
  /** Absolute, or a bare file name main rebases onto the Videos folder. */
  outputPath: string;
  /** Opt in to VideoToolbox / NVENC / QSV / AMF. */
  hardware?: boolean;
  /** Absent means CRF 18 in software, or the hardware default. */
  bitrateMbps?: number;
  /** Super Speed Turbo engine with chunked frame batching & accelerated encoding */
  superSpeed?: boolean;
  /** Keep rendering at full speed in the background without timer throttling */
  background?: boolean;
  /**
   * What the renderer will pipe.
   *
   * `jpeg` is the original contract: one complete JPEG per frame, which
   * ffmpeg decodes and re-encodes. `h264`/`hevc` mean the renderer already
   * encoded through WebCodecs and is sending an Annex-B elementary stream,
   * so ffmpeg stream-copies it and never touches a pixel. Absent means
   * `jpeg`, which is what a ProRes export and a browser build still use.
   */
  frameFormat?: 'jpeg' | 'h264' | 'hevc';
}

export interface ExportStartResult {
  sessionId?: string;
  error?: string;
}

export interface ExportFrameResult {
  ok: boolean;
  error?: string;
}

/** Where a `blob:` or `data:` source was written so ffmpeg could open it. */
export interface ExportMaterialResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** What the mix could and could not include, so a silent export can say why. */
export interface ExportAudioReport {
  requested: number;
  included: number;
  dropped: string[];
  note?: string;
}

export interface ExportFinishResult {
  ok: boolean;
  error?: string;
  outputPath?: string;
  frames?: number;
  hasAudio?: boolean;
  bytes?: number;
  audio?: ExportAudioReport;
}

/** A dismissed save dialog is `canceled`, not an error. */
export interface ExportChooseResult {
  ok?: boolean;
  canceled?: boolean;
  path?: string;
}

export interface ExporterBridge {
  /** The OS save dialog, which also owns the overwrite confirmation. */
  choose: (suggestedName: string, codec: string) => Promise<ExportChooseResult>;
  start: (options: ExportStartOptions) => Promise<ExportStartResult>;
  /** One complete JPEG per call. `frames` repeats it, for a still hold. */
  frame: (sessionId: string, jpeg: Uint8Array, frames?: number) => Promise<ExportFrameResult>;
  /**
   * Write bytes that exist only in this renderer into the session's own
   * working directory, and return the path.
   *
   * A take assembled from a live recording is made of `blob:` URLs, so this
   * is the ordinary case and not a fallback: ffmpeg cannot open a blob, and
   * the alternative is an export that silently loses its narration.
   */
  materialize: (
    sessionId: string,
    bytes: Uint8Array,
    extension?: string
  ) => Promise<ExportMaterialResult>;
  finish: (sessionId: string, audioClips: unknown[]) => Promise<ExportFinishResult>;
  /** Fire and forget: called from an abort the operator already committed to. */
  cancel: (sessionId: string) => Promise<void>;
}
