/* ═══════════════════════════════════════════════════════════════════
   A finished take, turned into a project.

   The claim this file has to make good on: **a recording arrives as an
   EDIT, not as a render.** Everything below is built out of the same
   store actions the timeline UI uses — tracks, clips, a transform, a
   mask — so there is nothing here a user cannot then take apart.

   That rules out the shortcut every screen recorder takes, which is to
   composite the camera into the picture while recording and hand over
   one flattened file. It is much less code and it is a dead end: you
   cannot move the bubble, resize it, mute the narration, or cut the
   camera away.

   ── What is here, and what is not ──────────────────────────────────

   `RAW_ASSEMBLE` lays the take down and stops: screen, camera,
   narration. Nothing interpreted, nothing to undo.

   The Cut also has a `TUTORIAL_ASSEMBLE` — zooms placed on real clicks,
   a cinematic frame, the camera taking over during pauses, click ticks,
   captions. None of that is ported: each piece needs an engine module
   this app does not have yet, and the captions need a speech model it
   does not ship. `AssembleOptions` therefore has FOUR fields rather
   than the Cut's twenty. An option nothing reads is a lie told in a
   type, so the interpretation flags are absent rather than present and
   pinned to `false`.

   ── The stack, bottom to top ───────────────────────────────────────

     A · Narration   the microphone, split off the camera clip
     V · Screen      the display, full frame
     V · Camera      the webcam, an inset in a corner

   Tracks are added bottom-first because `addTrack` unshifts and the
   compositor paints highest index first. Get that backwards and the
   screen covers the camera.

   ── Why the camera clip starts late ────────────────────────────────

   Two MediaRecorders started in the same tick do not begin at the same
   instant. `screenCapture.ts` measures the gap from both `onstart`
   events and it lands here as `cameraOffsetMs`; the camera clip is
   pushed that far along the timeline. Skip it and the take is
   permanently out of sync by a few frames, in the direction nobody
   thinks to check.
   ═══════════════════════════════════════════════════════════════════ */

import { useTimelineStore } from '../store/timelineStore';
import { useProjectStore } from '../store/projectStore';
import { AspectRatio, ASPECT_DIMENSIONS, Clip, MediaAsset, ProjectSettings } from '../types/edl';
import { computePipGeometry, buildPipPatch } from './pictureInPicture';
import { Take } from './screenCapture';
import { formatFileSize } from '../utils/time';

/* ── Options ────────────────────────────────────────────────────── */

/**
 * The four corners the camera inset can sit in.
 *
 * Here rather than in `recorderStore` because this is the module that
 * acts on it; the store imports it back for the sticky setting.
 */
export type CameraCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface AssembleOptions {
  /** Split the microphone off the camera clip, onto its own audio track. */
  detachNarration: boolean;
  /** Inset width as a percentage of the frame width. */
  cameraSizePct: number;
  cameraCorner: CameraCorner;
  /** Flip the webcam horizontally, so moving right moves right like a mirror. */
  mirrorCamera: boolean;
}

/** Lay the take down and stop. */
export const RAW_ASSEMBLE: AssembleOptions = {
  detachNarration: true,
  cameraSizePct: 24,
  cameraCorner: 'bottom-right',
  mirrorCamera: true,
};

export interface AssembleReport {
  projectName: string;
  /**
   * The screen clip this build produced.
   *
   * The anchor anything downstream checks before writing. A project id
   * is NOT enough: a build replaces every track in place without
   * minting a new project, so an id comparison says "same project"
   * about a timeline that has been entirely swapped. A clip id is
   * minted per build and cannot survive that.
   */
  screenClipId: string;
  durationMs: number;
  width: number;
  height: number;
  fps: 30 | 60;
  clips: number;
  tracks: number;
  narrationDetached: boolean;
  notes: string[];
}

/* ── Canvas ─────────────────────────────────────────────────────── */

/** H.264 refuses odd dimensions, and every export path here ends in it. */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

const LONG_EDGE_CAP = 2560;

/**
 * The canvas for a recording of this size.
 *
 * The source keeps its full resolution on disk — this only decides what
 * the SEQUENCE is, and a 5K display in a 5K sequence means every preview
 * frame composites 14.7 million pixels for a video that will be watched
 * at 1080p. Capping the long edge keeps the editor responsive; the
 * footage is still there to zoom into, which is the one thing the extra
 * resolution is actually good for.
 */
export function canvasFor(width: number, height: number): {
  width: number; height: number; aspectRatio: AspectRatio;
} {
  const longEdge = Math.max(width, height);
  const scale = longEdge > LONG_EDGE_CAP ? LONG_EDGE_CAP / longEdge : 1;
  const w = even(width * scale);
  const h = even(height * scale);

  /*
    A LABEL, and only a label. The canvas dimensions are set explicitly
    above and nothing derives them from this; `ASPECT_DIMENSIONS` is read
    only when a user picks a ratio from the header menu, at which point
    they have asked for that shape.

    Nearest is measured on the LOG of the ratio rather than on the ratio
    itself, because a plain difference is not symmetric — it is biased
    toward the smaller ratios, so 2:1 looks "further" from 16:9 than 4:3
    is by the same factor.

    It will still sometimes read oddly, and that is worth saying rather
    than tuning away: the six ratios on offer have nothing between 1.333
    and 1.778, and a great many real displays live in that gap. A
    3024x1964 laptop is 1.539, almost exactly halfway, and comes out
    labelled 4:3 by a margin of 0.0005. Putting a thumb on the scale to
    make one machine read better would be a fudge dressed as arithmetic.
  */
  const ratio = w / h;
  let aspectRatio: AspectRatio = '16:9';
  let best = Infinity;
  for (const key of Object.keys(ASPECT_DIMENSIONS) as AspectRatio[]) {
    const dims = ASPECT_DIMENSIONS[key];
    const gap = Math.abs(Math.log(dims.width / dims.height) - Math.log(ratio));
    if (gap < best) { best = gap; aspectRatio = key; }
  }

  return { width: w, height: h, aspectRatio };
}

/* ── Build ──────────────────────────────────────────────────────── */

/**
 * Bumped per build, so two takes in one session cannot mint the same
 * media id — `addMediaAsset` keys on it, and a collision would show the
 * first take's file under the second take's name.
 */
let takeSeq = 0;

function clipById(clipId: string): Clip | null {
  for (const track of useTimelineStore.getState().tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return null;
}

function stampName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Screen recording · ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** The camera inset's gap from the frame edge, as a percent of the short edge. */
const CAMERA_MARGIN_PCT = 3.5;
/** Ceiling on the inset's height, so a tall webcam cannot dominate the frame. */
const CAMERA_MAX_HEIGHT_PCT = 44;

/**
 * Lay a finished take down as a project on the timeline.
 *
 * Synchronous, and deliberately so. The Cut's signature is `async`
 * because its richer assembles render sound files before the
 * transaction opens; the raw path only writes to the store, so a
 * promise here would be a shape that promises work it does not do.
 */
export function assembleRecording(
  take: Take,
  options: Partial<AssembleOptions> = {}
): AssembleReport {
  const o = { ...RAW_ASSEMBLE, ...options };
  const notes = [...take.warnings];

  const screen = take.screen;
  if (!screen) {
    throw new Error('The take has no screen file, so there is nothing to build a project from.');
  }

  const canvas = canvasFor(screen.width, screen.height);

  /* ── 1. The project ─────────────────────────────────────────────── */

  const now = Date.now();
  const projectName = stampName();
  const settings: ProjectSettings = {
    id: `proj_rec_${now.toString(36)}`,
    name: projectName,
    aspectRatio: canvas.aspectRatio,
    width: canvas.width,
    height: canvas.height,
    /* The recorded rate, not a default. A 60fps take shown at 30 throws
       away half the frames it paid for. */
    fps: take.fps,
    durationMs: Math.max(1000, take.durationMs),
    backgroundColor: '#000000',
    createdAt: now,
    updatedAt: now,
  };

  // Start from nothing, so recording twice does not stack two takes.
  useTimelineStore.getState().loadProject([], []);
  useProjectStore.getState().loadProjectSettings(settings);

  /*
    And empty the media pool, which `loadProject` does not touch.

    Without this the Media panel of a brand new recording opens on
    whatever the last project imported, with the take somewhere among
    it. That panel is where a user goes to find the camera file to drag
    onto another track, and burying it under unrelated media is the
    difference between "here is your take" and "your take is in here
    somewhere".
  */
  for (const asset of [...useTimelineStore.getState().mediaPool]) {
    useTimelineStore.getState().removeMediaAsset(asset.id);
  }

  const store = () => useTimelineStore.getState();

  /*
    One history entry for the whole build.

    Every store action commits on its own, and undoing a recording one
    clip at a time is nobody's intent.
  */
  store().beginTransaction();

  const seq = ++takeSeq;

  /* ── 2. Tracks, bottom of the stack first ───────────────────────── */

  const screenTrack = store().addTrack('video', 'V1 · Screen');
  const cameraTrack = take.camera && take.camera.url
    ? store().addTrack('video', 'V2 · Camera')
    : null;

  /* ── 3. The screen ──────────────────────────────────────────────── */

  const screenAsset: MediaAsset = {
    id: `media_rec_screen_${seq}_${now.toString(36)}`,
    name: 'Screen.mp4',
    type: 'video',
    url: screen.url,
    thumbnailUrl: '',
    durationMs: take.durationMs,
    width: screen.width,
    height: screen.height,
    fileSizeFormatted: formatFileSize(screen.bytes),
    codec: screen.raw ? 'WebM' : 'H.264',
  };
  store().addMediaAsset(screenAsset);
  const screenClipId = store().insertClip(screenTrack, screenAsset, 0);
  store().patchClip(screenClipId, { name: 'Screen', fitMode: 'cover' });

  /* ── 4. The camera ──────────────────────────────────────────────── */

  let cameraClipId: string | null = null;
  if (cameraTrack && take.camera) {
    const camera = take.camera;
    const cameraAsset: MediaAsset = {
      id: `media_rec_camera_${seq}_${now.toString(36)}`,
      name: 'Camera.mp4',
      type: 'video',
      url: camera.url,
      thumbnailUrl: '',
      durationMs: Math.max(200, take.durationMs - take.cameraOffsetMs),
      width: camera.width,
      height: camera.height,
      fileSizeFormatted: formatFileSize(camera.bytes),
      codec: camera.raw ? 'WebM' : 'H.264',
    };
    store().addMediaAsset(cameraAsset);
    cameraClipId = store().insertClip(cameraTrack, cameraAsset, take.cameraOffsetMs);

    const inserted = clipById(cameraClipId);
    if (inserted) {
      /*
        `computePipGeometry` rather than an eyeballed scale. It sizes the
        inset from the SOURCE's aspect ratio and scales both axes by the
        same factor, which is the whole reason it exists: a 4:3 webcam
        given `scaleX = w/canvasW, scaleY = h/canvasH` comes out visibly
        stretched, and nothing in the project reports it.
      */
      const geometry = computePipGeometry({
        project: settings,
        clip: inserted,
        natural: { width: camera.width, height: camera.height },
        sizePct: o.cameraSizePct,
        marginPct: CAMERA_MARGIN_PCT,
        corner: o.cameraCorner,
        maxHeightPct: CAMERA_MAX_HEIGHT_PCT,
      });
      notes.push(...geometry.warnings);

      const patch = buildPipPatch(
        geometry,
        /* Square corners: the rounded inset belongs to the cinematic
           look, which is not ported. A radius here would be a style
           decision the raw assemble has no business making. */
        {},
        { name: 'Camera', startTimeMs: take.cameraOffsetMs, muteAudio: false }
      );
      notes.push(...patch.warnings);
      store().patchClip(cameraClipId, {
        ...patch.properties,
        'transform.flipH': o.mirrorCamera !== false,
      });
    }

    /* ── The narration, on its own track ── */
    if (o.detachNarration && camera.hasAudio) {
      const detached = store().detachAudio(cameraClipId);
      if (detached.ok && detached.audioTrackId) {
        store().renameTrack(detached.audioTrackId, 'A1 · Narration');
      } else if (detached.error) {
        notes.push(detached.error);
      }
    }
  } else if (o.detachNarration && screen.hasAudio) {
    const detached = store().detachAudio(screenClipId);
    if (detached.ok && detached.audioTrackId) {
      store().renameTrack(detached.audioTrackId, 'A1 · Narration');
    } else if (detached.error) {
      notes.push(detached.error);
    }
  }

  store().setPlayheadMs(0);
  store().commitTransaction('Screen recording');

  const finalState = useTimelineStore.getState();
  const clipCount = finalState.tracks.reduce((n, track) => n + track.clips.length, 0);

  return {
    projectName,
    screenClipId,
    durationMs: take.durationMs,
    width: canvas.width,
    height: canvas.height,
    fps: take.fps,
    clips: clipCount,
    tracks: finalState.tracks.length,
    narrationDetached: Boolean(
      o.detachNarration
      && (cameraClipId ? take.camera?.hasAudio : screen.hasAudio)
    ),
    notes,
  };
}
