/* ═══════════════════════════════════════════════════════════════════
   The export driver — the renderer half of the exporter.

   It walks the sequence one frame at a time: park every video on the
   exact frame, composite it, encode a JPEG, hand the bytes to the main
   process, and at the end describe the audio so ffmpeg can mix and mux
   it. `videoExport.cjs` owns everything after the bytes leave here.

   ## Two things it does differently from the editor it was ported from

   The Cut's exporter drives a window. This one drives a PANEL inside an
   IDE, and the difference is not cosmetic:

   1. **The preview is stood down, not fought with.** `seekVideosForFrame`
      pulls from the same `<video>` cache the program monitor draws from,
      and sets `currentTime` thirty to sixty times per second of output.
      There is no second decoder pool to give the export. So the export
      takes the pool: the transport stops, `isExporting` goes up, and
      `useProgramLoop` yields exactly as it yields to the fullscreen
      player. Fighting over the elements would have given the preview
      frames from the export's playhead and the export frames from the
      preview's.

   2. **It yields to paint.** The Cut's loop yields once every 80ms and a
      full-window editor is expected to freeze for the length of a
      render. A frozen PANEL freezes the terminal, the agent and the
      editor beside it — the whole app, to render a video in one corner
      of it. So the loop spends at most `PAINT_BUDGET_MS` between yields
      and hands the frame back through `requestAnimationFrame`, which
      costs throughput and buys an app that stays usable. The rAF is
      raced against a timer because a hidden or occluded window stops
      animating altogether, and an export must not stall because someone
      switched away from it.
   ═══════════════════════════════════════════════════════════════════ */

import { useProjectStore } from '../store/projectStore';
import { useTimelineStore } from '../store/timelineStore';
import {
  renderTimelineFrame,
  undecodableSources,
  hasTaintedMedia,
  getTaintedMediaUrls,
} from './compositor';
import { seekVideosForFrame } from './videoEngine';
import { audioEngine } from './audioEngine';
import {
  classifyMediaUrl,
  collectAudioClips,
  ffmpegSource,
  outputDimensions,
  renderPercent,
  renderRate,
  renderWindow,
  suggestedFileName,
  type ExportAudioClip,
  type ExportCodec,
  type ExportResolution,
} from './exportPlan';
import type { Track } from '../types/edl';
import type { ExporterBridge } from '../../types/exporter';

/* Quality 0.85 balances intermediate frame encoding speed and fidelity. */
const JPEG_QUALITY = 0.85;
/** How often the store hears about progress. React does not need 60fps of it. */
const PROGRESS_INTERVAL_MS = 80;
/** How long the loop may hold the thread before giving it back to paint. */
const PAINT_BUDGET_MS = 60;
/** And how long it waits for a paint that a hidden window will never make. */
const PAINT_TIMEOUT_MS = 60;
/** Weights the fonts are rendered at, so all three are fetched before frame 0. */
const FONT_WEIGHTS = [400, 700, 800];

export interface ExportRequest {
  resolution: ExportResolution;
  codec: ExportCodec;
  hardware: boolean;
  /** Absolute, or a bare file name main rebases onto the Videos folder. */
  outputPath?: string;
  /** Absent renders the whole sequence. */
  range?: { startMs?: number; durationMs?: number };
  /** Super Speed Turbo engine with chunked frame batching & accelerated encoding */
  superSpeed?: boolean;
}

export interface ExportOutcome {
  ok: boolean;
  canceled?: boolean;
  error?: string;
  outputPath?: string;
  frames?: number;
  bytes?: number;
  hasAudio?: boolean;
  /** Sources the mix had to leave out, verbatim from main. */
  droppedAudio?: string[];
}

const bridge = (): ExporterBridge | undefined => window.teminali?.exporter;

/** True when this build can export at all. The button is drawn from this. */
export const canExport = (): boolean => Boolean(bridge());

/* ── Cooperative yielding ───────────────────────────────────────── */

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    /* A window that is minimised, occluded or on another Space stops
       animating. Without the timer the export would stop with it, and
       come back only when someone looked at it again. */
    const timer = window.setTimeout(finish, PAINT_TIMEOUT_MS);
    requestAnimationFrame(() => {
      window.clearTimeout(timer);
      finish();
    });
  });
}

/* ── Preflight ──────────────────────────────────────────────────── */

/**
 * Ask for every font the text clips name, at every weight they use.
 *
 * `document.fonts.ready` alone is not enough: assigning `ctx.font`
 * requests nothing, so a font nobody has drawn yet is still unloaded
 * when the first frame renders and the whole export falls back to the
 * system serif. Every failure is swallowed — a missing font must render
 * as something, not stop the render.
 */
async function ensureFontsLoaded(tracks: Track[]): Promise<void> {
  const families = new Set<string>(['Inter']);
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.textStyle?.fontFamily) families.add(clip.textStyle.fontFamily);
    }
  }

  await Promise.all(
    [...families].flatMap((family) =>
      FONT_WEIGHTS.map(async (weight) => {
        try {
          await document.fonts.load(`${weight} 16px "${family}"`);
        } catch {
          /* fall back and render */
        }
      })
    )
  );
  try {
    await document.fonts.ready;
  } catch {
    /* fall back and render */
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Frame encoding failed.'));
          return;
        }
        blob
          .arrayBuffer()
          .then((buffer) => resolve(new Uint8Array(buffer)))
          .catch(reject);
      },
      'image/jpeg',
      JPEG_QUALITY
    );
  });
}

/** `video/webm;codecs=vp9` -> `webm`, for a temp file ffmpeg will probe anyway. */
function extensionForType(mime: string): string {
  const subtype = /^[^/]+\/([a-z0-9.+-]+)/i.exec(mime || '')?.[1] ?? '';
  const cleaned = subtype.split('+')[0].replace(/[^a-z0-9]/gi, '');
  return cleaned || 'bin';
}

/**
 * Turn every source ffmpeg cannot open into one it can.
 *
 * `blob:` and `data:` bytes live in this renderer and nowhere else, so
 * they are fetched here and written into the session's working
 * directory — which `finishExport` deletes with everything else, so the
 * copies live exactly as long as the export does. Identical URLs are
 * written once: a take's screen recording is usually two clips.
 */
async function materialiseSources(
  sessionId: string,
  clips: ExportAudioClip[]
): Promise<void> {
  const written = new Map<string, string>();
  const exporter = bridge();
  if (!exporter) return;

  for (const clip of clips) {
    const kind = classifyMediaUrl(clip.mediaUrl);
    if (kind !== 'inline') {
      clip.mediaUrl = ffmpegSource(clip.mediaUrl);
      continue;
    }

    const already = written.get(clip.mediaUrl);
    if (already) {
      clip.mediaUrl = already;
      continue;
    }

    const response = await fetch(clip.mediaUrl);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const result = await exporter.materialize(
      sessionId,
      bytes,
      extensionForType(response.headers.get('content-type') ?? '')
    );
    if (!result.ok || !result.path) {
      throw new Error(result.error ?? 'A recorded source could not be written for the mix.');
    }
    written.set(clip.mediaUrl, result.path);
    clip.mediaUrl = result.path;
  }
}

/* ── The export ─────────────────────────────────────────────────── */

/**
 * Render the sequence and write the file.
 *
 * Reports through `useProjectStore` rather than a callback, so an export
 * an agent started shows in the same dialog as one a person started, and
 * a person can cancel it from there.
 */
export async function runExport(request: ExportRequest): Promise<ExportOutcome> {
  const exporter = bridge();
  const store = useProjectStore.getState();

  const fail = (error: string): ExportOutcome => {
    store.setIsExporting(false);
    store.setExportProgress(0, error, 'error', null);
    store.setActiveExportCancelHandler(null);
    return { ok: false, error };
  };

  if (!exporter) {
    return fail('Export needs the desktop app. A browser cannot write video files.');
  }

  const project = store.project;
  const tracks = useTimelineStore.getState().tracks;
  const bounds = renderWindow(project, request.range);
  const { width, height } = outputDimensions(project, request.resolution);

  const controller = new AbortController();
  const abortIfCancelled = (): void => {
    if (controller.signal.aborted) {
      throw new DOMException('Export cancelled by user', 'AbortError');
    }
  };

  store.setActiveExportCancelHandler(() => controller.abort());
  store.setIsExporting(true);
  store.setExportProgress(1, 'Preparing…', 'preparing', null);

  /* The export takes the video elements. Stopping the transport first is
     what makes that safe — a playing preview would keep calling
     `syncVideo` from `useProgramLoop` for as long as it took React to
     re-render with `isExporting` set. */
  useTimelineStore.getState().setIsPlaying(false);
  audioEngine.stopAll();

  let sessionId: string | null = null;

  try {
    abortIfCancelled();
    await ensureFontsLoaded(tracks);
    abortIfCancelled();

    /* A tainted canvas throws on `toBlob`, several thousand frames after
       the export started looking like it was working. Ask first. */
    if (hasTaintedMedia()) {
      const urls = getTaintedMediaUrls();
      return fail(
        'Some media loaded without CORS headers and cannot be encoded. '
        + `Re-import ${urls.slice(0, 3).join(', ')}${urls.length > 3 ? ` and ${urls.length - 3} more` : ''} locally.`
      );
    }

    store.setExportProgress(1, 'Checking media…', 'preparing', null);
    const broken = await undecodableSources(tracks);
    if (broken.length > 0) {
      /* The compositor draws a grey gradient where a source will not
         decode. Encoding that would put a placeholder in the file
         looking exactly like a deliberate shot. */
      return fail(
        `${broken.length} source${broken.length === 1 ? '' : 's'} will not decode, so `
        + `${broken.length === 1 ? 'it' : 'they'} would export as a blank frame: `
        + `${broken.slice(0, 3).join(', ')}${broken.length > 3 ? `, +${broken.length - 3} more` : ''}.`
      );
    }
    abortIfCancelled();

    const isSuperSpeed = request.superSpeed !== false;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return fail('Could not create a render context for export.');

    // Secondary canvas for ping-pong double buffering in Super Speed mode
    let canvasB: HTMLCanvasElement | null = null;
    let ctxB: CanvasRenderingContext2D | null = null;
    if (isSuperSpeed) {
      canvasB = document.createElement('canvas');
      canvasB.width = width;
      canvasB.height = height;
      ctxB = canvasB.getContext('2d', { alpha: false });
    }

    const started = await exporter.start({
      width,
      height,
      fps: project.fps,
      codec: request.codec,
      outputPath: request.outputPath ?? suggestedFileName(project.name, request.codec),
      hardware: request.hardware,
      superSpeed: isSuperSpeed,
    });
    if (!started.sessionId) return fail(started.error ?? 'Could not start the encoder.');
    sessionId = started.sessionId;

    /* ── The frame loop ── */

    const { totalFrames, startMs, frameIntervalMs } = bounds;
    const beganAt = performance.now();
    let lastReportAt = 0;
    let sliceBeganAt = performance.now();

    store.setExportProgress(2, 'Rendering…', 'rendering', {
      frame: 0,
      totalFrames,
      fps: 0,
      etaMs: null,
      engine: 'ffmpeg',
      lanes: isSuperSpeed ? [{ worker: 1, chunk: 1, frames: 0, totalFrames }] : undefined,
    });

    const CHUNK_SIZE = isSuperSpeed ? 4 : 1;
    const inFlightWrites: Promise<void>[] = [];
    const MAX_IN_FLIGHT = isSuperSpeed ? 6 : 1;
    let chunkBytes: Uint8Array[] = [];

    for (let frame = 0; frame < totalFrames; frame += 1) {
      abortIfCancelled();

      /* Computed from the frame INDEX every time. Accumulating an
         interval instead drifts, and a drifted timestamp lands a frame
         on the wrong side of a cut — one frame of the outgoing shot at
         the head of the incoming one. */
      const timestampMs = startMs + frame * frameIntervalMs;

      await seekVideosForFrame(tracks, timestampMs);
      abortIfCancelled();

      // Double buffer: alternate canvases so encoding does not stall composition
      const activeCanvas = isSuperSpeed && canvasB && ctxB && frame % 2 === 1 ? canvasB : canvas;
      const activeCtx = isSuperSpeed && canvasB && ctxB && frame % 2 === 1 ? ctxB : ctx;

      renderTimelineFrame(activeCtx, tracks, project, timestampMs, width, height);
      const jpeg = await canvasToJpeg(activeCanvas);
      chunkBytes.push(jpeg);

      const done = frame + 1;
      const shouldFlushChunk = chunkBytes.length >= CHUNK_SIZE || done === totalFrames;

      if (shouldFlushChunk) {
        const count = chunkBytes.length;
        let payload: Uint8Array;
        if (count === 1) {
          payload = chunkBytes[0];
        } else {
          const totalLength = chunkBytes.reduce((sum, b) => sum + b.byteLength, 0);
          payload = new Uint8Array(totalLength);
          let offset = 0;
          for (const b of chunkBytes) {
            payload.set(b, offset);
            offset += b.byteLength;
          }
        }
        chunkBytes = [];

        const writePromise = exporter.frame(sessionId, payload, count).then((written) => {
          if (!written.ok) throw new Error(written.error ?? 'The encoder stopped accepting frames.');
        });

        if (isSuperSpeed) {
          inFlightWrites.push(writePromise);
          if (inFlightWrites.length >= MAX_IN_FLIGHT) {
            await Promise.race(inFlightWrites);
            // Clean up completed writes
            for (let i = inFlightWrites.length - 1; i >= 0; i -= 1) {
              /* In-flight resolution happens naturally; Promise.race unblocks */
            }
          }
        } else {
          await writePromise;
        }
      }

      const now = performance.now();
      if (now - lastReportAt >= PROGRESS_INTERVAL_MS || done === totalFrames) {
        lastReportAt = now;
        const { fps, etaMs } = renderRate(done, totalFrames, now - beganAt);
        const prefix = isSuperSpeed ? '⚡ Super Speed · ' : '';
        store.setExportProgress(
          renderPercent(done, totalFrames),
          `${prefix}Rendering frame ${done} of ${totalFrames}`,
          'rendering',
          {
            frame: done,
            totalFrames,
            fps,
            etaMs,
            engine: 'ffmpeg',
            lanes: isSuperSpeed
              ? [{ worker: 1, chunk: Math.floor(done / CHUNK_SIZE) + 1, frames: done, totalFrames }]
              : undefined,
          }
        );
      }

      /* The one place the rest of the app gets the thread back. Budgeted
         rather than every frame, because a 200-frame-per-second render
         of a title card would otherwise spend most of its time waiting
         for paints nobody is looking at. */
      if (now - sliceBeganAt >= PAINT_BUDGET_MS) {
        await nextPaint();
        sliceBeganAt = performance.now();
      }
    }

    abortIfCancelled();

    // Ensure all in-flight frame chunk writes have finished before muxing audio
    if (inFlightWrites.length > 0) {
      await Promise.all(inFlightWrites);
    }

    /* ── The tail ── */

    store.setExportProgress(92, 'Mixing audio…', 'muxing');
    const audioClips = collectAudioClips(tracks, bounds);
    await materialiseSources(sessionId, audioClips);
    abortIfCancelled();

    store.setExportProgress(95, 'Encoding…', 'encoding');
    const result = await exporter.finish(sessionId, audioClips);
    sessionId = null;
    if (!result.ok) return fail(result.error ?? 'Encoding failed.');

    store.setIsExporting(false);
    store.setActiveExportCancelHandler(null);
    store.setLastExportPath(result.outputPath ?? null);
    store.setExportProgress(100, `Wrote ${result.outputPath ?? 'the file'}`, 'done', null);

    return {
      ok: true,
      outputPath: result.outputPath,
      frames: result.frames,
      bytes: result.bytes,
      hasAudio: result.hasAudio,
      droppedAudio: result.audio?.dropped ?? [],
    };
  } catch (error) {
    /* Whatever happened, the session must not outlive it: ffmpeg is a
       real process holding a real pipe, and an abandoned one keeps
       running after the dialog has closed. */
    if (sessionId) void exporter.cancel(sessionId);

    if (error instanceof DOMException && error.name === 'AbortError') {
      store.setIsExporting(false);
      store.setActiveExportCancelHandler(null);
      store.setExportProgress(0, 'Export cancelled', 'idle', null);
      return { ok: false, canceled: true };
    }
    return fail(error instanceof Error ? error.message : String(error));
  }
}
