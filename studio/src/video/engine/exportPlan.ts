/* ═══════════════════════════════════════════════════════════════════
   Export planning — the arithmetic and the audio bookkeeping, with
   nothing that touches a canvas, a store, a bridge or the DOM.

   Split from `exportPipeline.ts` for the reason `exportFilters.cjs` is
   split from `videoExport.cjs`: these are the decisions that go wrong
   without throwing. A clip windowed half a frame early still exports,
   still plays, and is simply wrong — so the windowing, the solo gate
   and the envelope live here where `tests/video-export-driver.test.mjs`
   can run them under plain `node --test`.

   Every import is `import type`, which Node erases. Add a value import
   here and the tests stop being able to load this file.
   ═══════════════════════════════════════════════════════════════════ */

import type { Clip, ProjectSettings, Track } from '../types/edl';

/* ── Output geometry ────────────────────────────────────────────── */

export type ExportResolution = '720p' | '1080p' | '1440p' | '4k';
export type ExportCodec = 'h264' | 'hevc' | 'prores';

/** The short edge each preset names. The long edge follows the project. */
const SHORT_EDGE: Record<ExportResolution, number> = {
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '4k': 2160,
};

/* h264 and hevc reject odd dimensions outright, so every axis is rounded
   to an even number rather than trusted to divide cleanly. */
const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/**
 * The pixel size of the exported file.
 *
 * The preset names the SHORT edge, not the height: a 1080×1920 vertical
 * project exported at "1080p" is 1080 wide and 1920 tall, which is what
 * every phone-shaped export is supposed to be. Taking `height` from the
 * preset instead would letterbox a vertical sequence into a 1920×1080
 * frame and call it correct.
 */
export function outputDimensions(
  project: Pick<ProjectSettings, 'width' | 'height'>,
  resolution: ExportResolution
): { width: number; height: number } {
  const short = SHORT_EDGE[resolution] ?? SHORT_EDGE['1080p'];
  const shortEdge = Math.min(project.width, project.height);
  if (shortEdge <= 0) return { width: even(short), height: even(short) };

  const scale = short / shortEdge;
  return { width: even(project.width * scale), height: even(project.height * scale) };
}

/** `.mov` for ProRes, `.mp4` for everything else. */
export function extensionFor(codec: ExportCodec): string {
  return codec === 'prores' ? 'mov' : 'mp4';
}

/**
 * A file name a person would recognise, from a project name they typed.
 *
 * Path separators and the characters Windows refuses are replaced rather
 * than stripped, so "Ep 3: The Fix" stays two words apart instead of
 * becoming "Ep 3 The Fix".
 */
export function suggestedFileName(projectName: string, codec: ExportCodec): string {
  const base = (projectName || 'Untitled')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Untitled';
  return `${base}.${extensionFor(codec)}`;
}

/* ── The render window ──────────────────────────────────────────── */

export interface RenderWindow {
  startMs: number;
  renderMs: number;
  totalFrames: number;
  frameIntervalMs: number;
}

/**
 * How much of the sequence is being rendered, and in how many frames.
 *
 * `totalFrames` is at least 1: a zero-length range would open a session,
 * write nothing and hand ffmpeg an empty stream, which fails as "no
 * video" several seconds later instead of as an empty range now.
 */
export function renderWindow(
  project: Pick<ProjectSettings, 'durationMs' | 'fps'>,
  range?: { startMs?: number; durationMs?: number }
): RenderWindow {
  const startMs = Math.max(0, Math.round(range?.startMs ?? 0));
  const renderMs = Math.max(
    0,
    Math.round(range?.durationMs ?? Math.max(0, project.durationMs - startMs))
  );
  const fps = project.fps || 30;
  return {
    startMs,
    renderMs,
    totalFrames: Math.max(1, Math.round((renderMs / 1000) * fps)),
    frameIntervalMs: 1000 / fps,
  };
}

/* ── Media sources ──────────────────────────────────────────────── */

/**
 * What ffmpeg can do with a URL.
 *
 * `inline` is a `blob:` or `data:` URL — bytes that exist only in this
 * renderer's memory. A take assembled from a live recording is made of
 * them, so this is the common case rather than an edge one, and they
 * have to be written to a real file before the mix can name them.
 */
export type MediaSourceKind = 'path' | 'remote' | 'inline';

export function classifyMediaUrl(url: string): MediaSourceKind {
  if (/^(blob:|data:)/i.test(url)) return 'inline';
  if (/^https?:/i.test(url)) return 'remote';
  return 'path';
}

/**
 * A `file://` URL as a path ffmpeg will open.
 *
 * The scheme is stripped and the percent-encoding undone, because a
 * recording in "Kerf Recordings" arrives as `Kerf%20Recordings` and
 * ffmpeg looks for a directory with a literal `%20` in its name. On
 * Windows the leading slash before the drive letter goes too:
 * `file:///C:/a.mp4` is `C:/a.mp4`, and `/C:/a.mp4` is nothing.
 */
export function ffmpegSource(url: string): string {
  if (!/^file:/i.test(url)) return url;
  const withoutScheme = url.replace(/^file:\/\/(localhost)?/i, '').replace(/^file:/i, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutScheme);
  } catch {
    decoded = withoutScheme; // a stray % that is not an escape: keep it literal
  }
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

/* ── Audio ──────────────────────────────────────────────────────── */

export interface EnvelopePoint {
  tMs: number;
  v: number;
}

export interface ExportAudioClip {
  mediaUrl: string;
  startTimeMs: number;
  durationMs: number;
  sourceStartMs: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  speed: number;
  reversed: boolean;
  pitch: number;
  voiceEffect: string;
  noiseReduction: boolean;
  ducking: boolean;
  /** Two or more points REPLACE `volume`; see `exportFilters.cjs`. */
  volumeEnvelope?: EnvelopePoint[];
}

const STATIC_GRAPHIC = /\.(jpg|jpeg|png|webp|gif|svg|bmp|avif)$/i;

/**
 * A clip that draws but cannot sound.
 *
 * Handing ffmpeg a PNG as an audio input does not fail loudly — the
 * filtergraph references a stream that is not there and the whole mix
 * dies with a message about an invalid link, taking the narration with
 * it. Cheaper to not send it.
 */
function isStaticGraphic(clip: Pick<Clip, 'type' | 'mediaUrl'>): boolean {
  if (clip.type === 'sticker' || clip.type === 'adjustment') return true;
  return STATIC_GRAPHIC.test(clip.mediaUrl ?? '');
}

/** Linear read of an envelope at `tMs`, flat outside its ends. */
function sampleEnvelope(points: EnvelopePoint[], tMs: number): number {
  if (tMs <= points[0].tMs) return points[0].v;
  const last = points[points.length - 1];
  if (tMs >= last.tMs) return last.v;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (tMs >= a.tMs && tMs <= b.tMs) {
      const span = b.tMs - a.tMs;
      return span > 0 ? a.v + ((b.v - a.v) * (tMs - a.tMs)) / span : b.v;
    }
  }
  return last.v;
}

/**
 * `volume` keyframes as an ffmpeg envelope, in clip-local milliseconds.
 *
 * The track fader is multiplied through here because the envelope
 * REPLACES the static volume downstream — applying both would square the
 * fader and put a track at 0.5 out at 0.25.
 *
 * Note the asymmetry this exposes: `audioEngine.gainFor` does not read
 * volume keyframes at all, so an automated fade is audible in the export
 * and not in the preview. The export is the half that is right; the
 * preview is the half that owes the work.
 */
export function volumeEnvelopeFor(clip: Clip, trackVolume: number): EnvelopePoint[] | undefined {
  const keys = clip.keyframes.filter((k) => k.property === 'volume');
  if (keys.length < 2) return undefined;
  return [...keys]
    .sort((a, b) => a.timeOffsetMs - b.timeOffsetMs)
    .map((k) => ({ tMs: k.timeOffsetMs, v: Math.max(0, k.value) * trackVolume }));
}

/**
 * The same envelope after a range export has cut the clip's head or tail.
 *
 * The boundaries are INTERPOLATED rather than dropped: a fade that began
 * before the in-point has a real level at the in-point, and starting the
 * export from the next surviving keyframe would jump the level to it.
 */
export function windowEnvelope(
  points: EnvelopePoint[],
  headCutMs: number,
  durationMs: number
): EnvelopePoint[] | undefined {
  const endMs = headCutMs + durationMs;
  const inside = points
    .filter((p) => p.tMs > headCutMs && p.tMs < endMs)
    .map((p) => ({ tMs: p.tMs - headCutMs, v: p.v }));

  const windowed: EnvelopePoint[] = [
    { tMs: 0, v: sampleEnvelope(points, headCutMs) },
    ...inside,
    { tMs: durationMs, v: sampleEnvelope(points, endMs) },
  ];
  return windowed.length >= 2 ? windowed : undefined;
}

/**
 * Every clip that should make a sound in the finished file.
 *
 * The gates are `audioEngine.gainFor`'s, deliberately and not by
 * coincidence: solo is counted over AUDIO tracks only and then applied
 * to every track, so soloing a narration track silences the screen
 * recording's own audio as it does on playback. Counting solo over all
 * track types instead — which is what the picture does — would make an
 * export of a soloed timeline sound nothing like the preview of it.
 */
export function collectAudioClips(
  tracks: Track[],
  window: Pick<RenderWindow, 'startMs' | 'renderMs'>
): ExportAudioClip[] {
  const { startMs, renderMs } = window;
  const endMs = startMs + renderMs;
  const anySolo = tracks.some((t) => t.type === 'audio' && t.solo);
  const out: ExportAudioClip[] = [];

  for (const track of tracks) {
    if (track.muted) continue;
    if (anySolo && !track.solo) continue;

    for (const clip of track.clips) {
      if (clip.hidden || !clip.mediaUrl) continue;
      // Video clips carry their own audio; a graphic on a video track does not.
      if (track.type !== 'audio' && clip.type !== 'video') continue;
      if (isStaticGraphic(clip)) continue;

      /* Detaching audio moves the sound to its own clip and leaves the
         video half at volume 0. The volume test alone used to be enough
         to drop it — until the envelope arrived, because `detachAudio`
         clears the keyframes on the COPY and not on the original, so a
         video clip with a volume automation would come back from zero
         and put the narration in the mix twice. */
      if (clip.audio.detached && track.type !== 'audio') continue;

      const volume = clip.audio.volume * track.volume;
      const envelope = track.volume > 0 ? volumeEnvelopeFor(clip, track.volume) : undefined;
      if (volume <= 0 && !envelope) continue;

      const clipEnd = clip.startTimeMs + clip.durationMs;
      if (clipEnd <= startMs || clip.startTimeMs >= endMs) continue;

      const headCutMs = Math.max(0, startMs - clip.startTimeMs);
      const tailCutMs = Math.max(0, clipEnd - endMs);
      const durationMs = clip.durationMs - headCutMs - tailCutMs;
      if (durationMs <= 0) continue;

      const speed = clip.speed.multiplier || 1;
      /* Source time advances at PLAYBACK speed, so a clip at 2× consumes
         two seconds of file for every second cut from its head — and a
         reversed clip consumes it from the other end, which is why the
         tail cut is the one that shifts the source in. */
      const sourceShiftMs = (clip.speed.reversed ? tailCutMs : headCutMs) * speed;

      out.push({
        mediaUrl: clip.mediaUrl,
        startTimeMs: clip.startTimeMs + headCutMs - startMs,
        durationMs,
        sourceStartMs: Math.max(0, clip.sourceStartMs + sourceShiftMs),
        volume,
        /* A fade only survives if its own end of the clip did. Half a
           fade-in kept after the in-point cut through it would ramp from
           silence in the middle of a word. */
        fadeInMs: headCutMs > 0 ? 0 : clip.audio.fadeInMs,
        fadeOutMs: tailCutMs > 0 ? 0 : clip.audio.fadeOutMs,
        speed,
        reversed: clip.speed.reversed,
        pitch: clip.audio.pitch,
        voiceEffect: clip.audio.voiceEffect,
        noiseReduction: clip.audio.noiseReduction,
        ducking: clip.audio.ducking,
        ...(envelope
          ? { volumeEnvelope: windowEnvelope(envelope, headCutMs, durationMs) }
          : {}),
      });
    }
  }

  return out;
}

/* ── Progress ───────────────────────────────────────────────────── */

/**
 * The percentage schedule, as one function so the dialog and the driver
 * cannot disagree about what 90% means.
 *
 * 2 to open the encoder, 2→90 for the frames, 92 for the mix, 100 done.
 * The frame band is deliberately not 0→100: an export that sat at 100%
 * for the length of an audio mix is how "it finished but nothing
 * happened" gets reported.
 */
export function renderPercent(done: number, totalFrames: number): number {
  if (totalFrames <= 0) return 90;
  return 2 + Math.round((Math.min(done, totalFrames) / totalFrames) * 88);
}

/** Frames a second and the time left, from the elapsed clock. */
export function renderRate(
  done: number,
  totalFrames: number,
  elapsedMs: number
): { fps: number; etaMs: number | null } {
  if (done <= 0 || elapsedMs <= 0) return { fps: 0, etaMs: null };
  const fps = (done / elapsedMs) * 1000;
  const remaining = Math.max(0, totalFrames - done);
  return { fps, etaMs: fps > 0 ? (remaining / fps) * 1000 : null };
}

/** `1:04` / `12s`, for a countdown that is read at a glance. */
export function formatEta(etaMs: number | null): string {
  if (etaMs == null || !Number.isFinite(etaMs)) return '—';
  const seconds = Math.max(0, Math.round(etaMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
