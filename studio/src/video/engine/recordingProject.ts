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

   `TUTORIAL_ASSEMBLE` interprets. It reads the pointer track and the
   input hook, pushes the picture in on what was actually clicked,
   draws the pointer the capture did not record, sets the frame on a
   backdrop and puts a tick under every click.

   What is still absent is everything the WORDS drive. The Cut opens on
   the face when the take opens with an introduction, hands the camera
   the whole frame during a spoken pause, and lays down two caption
   tracks. Every one of those decisions is read out of a TRANSCRIPT,
   and this app ships no speech model — `Take.transcript` exists and
   nothing fills it. Those are not options that would merely behave
   conservatively without one: the Cut's `alignToSpeech` returns null on
   an empty transcript, so `cameraOnPauses` would find zero stretches
   every time. An option nothing can read is a lie told in a type, so
   they are absent rather than present and pinned to `false`.

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
import { computePipGeometry, buildPipPatch, PIP_FIT_MODE } from './pictureInPicture';
import { getClipBaseSize } from './geometry';
import {
  DEFAULT_SHAPE, SMOOTH_SHAPE, ZoomShape, ZoomMoment, ZoomKeyframe,
  detectMoments, zoomKeyframes,
} from './cursorZoom';
import {
  DEFAULT_LOOK, LookOptions, SHAPE_BASE,
  addBackdrop, applyScreenLook, addFades, addCameraMotion,
} from './cinematicLook';
import { CURSOR_SIZE_PCT, cursorPlaneStyle, cursorLayerKeyframes } from './cursorLayer';
import {
  DEFAULT_SOUND, SoundOptions, prepareSoundKit, placeSoundDesign,
} from './recordingSound';
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
  /* ── Arrangement ── */

  /** Split the microphone off the camera clip, onto its own audio track. */
  detachNarration: boolean;
  /** Inset width as a percentage of the frame width. */
  cameraSizePct: number;
  cameraCorner: CameraCorner;
  /** Flip the webcam horizontally, so moving right moves right like a mirror. */
  mirrorCamera: boolean;

  /* ── Motion ── */

  /** Push the picture in on what was clicked, scrolled, typed or marked. */
  autoZoom: boolean;
  /** How a zoom moves between framings. `SMOOTH_SHAPE` glides; `CUT_SHAPE` cuts. */
  zoomShape: ZoomShape;
  /** Smear the zoom moves. Costs `samples` renders a frame, so only with zooms. */
  motionBlur: boolean;
  /** Drop a timeline marker on every moment the detector found. */
  markMoments: boolean;
  /**
   * Draw a pointer.
   *
   * A macOS screen capture does not contain the cursor, so without this
   * a tutorial pushes in on things the viewer never sees being clicked.
   * The icon is the paper-plane dart; see `cursorLayer.ts`, which also
   * explains why it grows with the zoom rather than holding one size.
   */
  drawCursor: boolean;

  /* ── Look ── */

  /** Sit the picture on a backdrop, inset and rounded, and fade it up. */
  cinematic: boolean;
  look: LookOptions;

  /* ── Sound ── */

  /** Render click ticks and zoom whooshes and place them on their own track. */
  sound: boolean;
  soundOptions: SoundOptions;
}

/** Lay the take down and stop. Nothing interpreted, nothing to undo. */
export const RAW_ASSEMBLE: AssembleOptions = {
  detachNarration: true,
  cameraSizePct: 24,
  cameraCorner: 'bottom-right',
  mirrorCamera: true,
  autoZoom: false,
  zoomShape: DEFAULT_SHAPE,
  motionBlur: false,
  markMoments: false,
  drawCursor: false,
  cinematic: false,
  look: DEFAULT_LOOK,
  sound: false,
  soundOptions: DEFAULT_SOUND,
};

/**
 * Everything the pointer track and the picture can do, on.
 *
 * `zoomShape` is the one field here that is not a switch, and it is
 * `SMOOTH_SHAPE` rather than the Cut's original `CUT_SHAPE` for the
 * reason the Cut records: on a SCREEN recording a hard cut from wide to
 * a 2.8x close relocates every word in the frame in one frame, and the
 * eye has to find its place again. Twenty of those in a two-minute take
 * is twenty re-reads. `SMOOTH_SHAPE` keeps every measured number of the
 * reference and moves between the framings instead of cutting.
 *
 * What is NOT on is what nothing here can honour: the camera never
 * takes the whole frame and no captions are laid down, because both are
 * read out of a transcript this app cannot produce. See the file header.
 */
export const TUTORIAL_ASSEMBLE: AssembleOptions = {
  ...RAW_ASSEMBLE,
  autoZoom: true,
  zoomShape: SMOOTH_SHAPE,
  motionBlur: true,
  markMoments: true,
  drawCursor: true,
  cinematic: true,
  sound: true,
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
  /** Moments the detector found. 0 when `autoZoom` was off or nothing stood out. */
  zoomMoments: number;
  /** Which detector they came from — real input, or the cursor track alone. */
  momentsFrom: 'events' | 'cursor' | 'none';
  /** Keyframes written onto the screen clip. */
  keyframes: number;
  /** Keyframes on the cursor layer. 0 when it was not drawn. */
  cursorKeyframes: number;
  /** Ticks and whooshes placed. 0 when `sound` was off or nothing happened. */
  soundClips: number;
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
 * Asynchronous, and only because of the sound. `prepareSoundKit`
 * renders the ticks and the whooshes offline and writes them into the
 * take directory, which is file I/O and has no business happening
 * inside the store transaction the rest of the build runs in. Every
 * other option here is pure arithmetic; with `sound` off, nothing in
 * this function awaits anything.
 */
export async function assembleRecording(
  take: Take,
  options: Partial<AssembleOptions> = {}
): Promise<AssembleReport> {
  const o = { ...RAW_ASSEMBLE, ...options };
  const notes = [...take.warnings];

  const screen = take.screen;
  if (!screen) {
    throw new Error('The take has no screen file, so there is nothing to build a project from.');
  }

  /* ── 1. Decide everything before touching the store ──────────────
     Detection is pure, and doing it first means the only tracks that
     get created are the ones that will hold something. */

  const canvas = canvasFor(screen.width, screen.height);

  const detected = o.autoZoom && take.cursorTracked
    ? detectMoments({ cursor: take.cursor, events: take.events, marks: take.marks })
    : { moments: [] as ZoomMoment[], from: 'cursor' as const };
  const moments = detected.moments;

  /*
    The only slow, file-writing part, and it happens before the
    transaction opens rather than inside it.
  */
  const soundKit = o.sound && take.events.length + moments.length > 0
    ? await prepareSoundKit(take.dir, {
      clicks: o.soundOptions.clicks
        && take.events.some((e) => e.kind === 'click' || e.kind === 'rightclick'),
      whooshes: o.soundOptions.whooshes && moments.length > 0,
    })
    : null;

  /* ── 2. The project ─────────────────────────────────────────────── */

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

  /* ── 3. Tracks, bottom of the stack first ───────────────────────── */

  const soundTrack = soundKit && (soundKit.click || soundKit.whoosh)
    ? store().addTrack('audio', 'A2 · Sound design')
    : null;
  const backdropTrack = o.cinematic && o.look.backdrop !== 'none'
    ? store().addTrack('video', 'V1 · Backdrop')
    : null;
  const screenTrack = store().addTrack('video', 'V2 · Screen');
  /*
    Above the screen and below the camera, and there is only one place
    it can go. Under the screen it is invisible; over the camera it
    floats a pointer on top of the face.
  */
  const cursorTrack = o.drawCursor && take.cursor.length > 0
    ? store().addTrack('video', 'V3 · Cursor')
    : null;
  const cameraTrack = take.camera && take.camera.url
    ? store().addTrack('video', 'V4 · Camera')
    : null;
  const gradeTrack = o.cinematic && (o.look.fadeInMs > 0 || o.look.fadeOutMs > 0)
    ? store().addTrack('video', 'V5 · Grade')
    : null;

  /* ── 4. The backdrop ────────────────────────────────────────────── */

  if (backdropTrack) addBackdrop(backdropTrack, settings, take.durationMs, o.look.backdrop);

  /* ── 5. The screen ──────────────────────────────────────────────── */

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

  /*
    The scale the picture RESTS at.

    `fitScale` is what makes the whole frame visible with nothing
    cropped: the canvas is cut to the take's aspect ratio so this is
    normally 1, but it is computed rather than assumed — the even-number
    rounding in `canvasFor` can shift the ratio by a fraction of a
    percent, and a zoom built on the assumption would leave a hairline of
    backdrop down one edge.

    The cinematic inset is then a fraction of that, and it is the same
    number the zoom is built on top of, which is why it is decided here
    and nowhere else.
  */
  let restScale = 1;
  let keyframeCount = 0;
  /*
    Hoisted out of the block below because the cursor layer is placed
    from exactly these two things: the picture's base size, and the
    transform the zoom puts on it. Recomputing either would be two
    sources of truth for where the frame is.
  */
  let zoomKfs: ZoomKeyframe[] = [];
  let screenBase: { width: number; height: number } | null = null;
  {
    const clip = clipById(screenClipId);
    if (clip) {
      const base = getClipBaseSize(clip, settings, { width: screen.width, height: screen.height });
      screenBase = base;
      const fitScale = Math.min(settings.width / base.width, settings.height / base.height);
      restScale = o.cinematic ? fitScale * (o.look.insetPct / 100) : fitScale;

      if (o.cinematic) applyScreenLook(screenClipId, settings, o.look);
      if (restScale !== 1) {
        store().patchClip(screenClipId, {
          'transform.scaleX': restScale,
          'transform.scaleY': restScale,
        });
      }

      if (moments.length > 0) {
        const keyframes = zoomKeyframes(
          moments,
          take.durationMs,
          {
            baseWidth: base.width,
            baseHeight: base.height,
            restScale,
            canvasWidth: settings.width,
            canvasHeight: settings.height,
            /* Keep the zoomed frame strictly inside the canvas bounds, so
               content near an edge — a sidebar, a tab strip, a typed
               number — stays fully visible at every resolution. */
            edgeOverhang: 0,
          },
          o.zoomShape,
          /*
            The frame has to be back at rest before the dip to black
            STARTS, not by the last frame of the film. The closing move
            of the cutting grammar is 2100ms, more than three times the
            fade, so without this the film dips to black in the middle of
            a camera move — which reads as "the render broke" rather than
            as a choice.
          */
          Math.max(1, take.durationMs - (o.cinematic ? o.look.fadeOutMs : 0))
        );
        for (const keyframe of keyframes) {
          store().addKeyframe(screenClipId, {
            property: keyframe.property,
            timeOffsetMs: keyframe.timeOffsetMs,
            value: keyframe.value,
            easing: keyframe.easing,
            ...(keyframe.bezierPoints ? { bezierPoints: keyframe.bezierPoints } : {}),
          });
        }
        keyframeCount = keyframes.length;
        zoomKfs = keyframes;

        /*
          Motion blur, and only when there is motion to blur.

          It renders the clip once per sample, so it is `samples` times
          the fill rate for every frame of the take — including the
          ninety percent where nothing moves and every sample draws the
          same picture. Four is enough to smear a zoom and cheap enough
          to scrub through; it is off entirely when there are no zooms,
          where it would cost that much for no visible difference at all.
        */
        if (o.motionBlur) {
          store().patchClip(screenClipId, {
            'motionBlur.enabled': true,
            'motionBlur.shutterAngle': 180,
            'motionBlur.samples': 4,
          });
        }
      } else if (o.autoZoom) {
        notes.push(
          take.events.length > 0
            ? 'Nothing was clicked, scrolled or typed in this take, so no zooms were added.'
            : 'No moments stood out in the cursor track, so no zooms were added. '
              + 'The take is on the timeline exactly as it was recorded.'
        );
      }
    }
  }

  /* ── 6. The cursor ──────────────────────────────────────────────── */

  /*
    One shape clip, one path, and the whole thing hangs off the zoom
    plan above rather than off the cursor track alone.

    The reason is that the pointer's place on the CANVAS is not what the
    recorder sampled. The recorder sampled where it was on the display,
    normalised; where that lands on screen depends entirely on how the
    frame is currently framed, and this film re-frames itself many times
    over. So the samples are mapped through the screen clip's own
    transform, sampled with the same `interpolateKeyframes` that will
    draw it, and the zoom's keyframe times are forced into the output so
    a pointer resting through a push travels on the push's curve instead
    of chording across it. `cursorLayer.ts` has the arithmetic.

    It is also decimated hard. A 30Hz track times four properties is
    7,200 keyframes a minute.
  */
  let cursorKeyframeCount = 0;
  if (cursorTrack && screenBase) {
    const restPx = (CURSOR_SIZE_PCT / 100) * screenBase.height * restScale;
    const cursorClipId = store().addShapeLayer(
      cursorTrack,
      'path',
      0,
      Math.max(1, Math.round(take.durationMs))
    );
    store().updateShapeStyle(cursorClipId, cursorPlaneStyle(restPx));
    /*
      The resting size is written to the base transform as well as
      keyframed. A take whose every sample was out of range emits no
      keyframes, and a shape layer with no scale on it draws at
      `SHAPE_BASE`, which is a 480px dart across the middle of the film.
    */
    store().patchClip(cursorClipId, {
      name: 'Cursor',
      'transform.scaleX': restPx / SHAPE_BASE,
      'transform.scaleY': restPx / SHAPE_BASE,
    });

    const cursorKeyframes = cursorLayerKeyframes(
      take.cursor,
      zoomKfs,
      take.durationMs,
      {
        baseWidth: screenBase.width,
        baseHeight: screenBase.height,
        restScale,
        canvasWidth: settings.width,
        canvasHeight: settings.height,
      },
      /* No hidden spans: the camera never takes the whole frame here,
         because deciding when it should is read out of a transcript. */
      { hiddenSpans: [] }
    );

    for (const keyframe of cursorKeyframes) {
      store().addKeyframe(cursorClipId, {
        property: keyframe.property,
        timeOffsetMs: keyframe.timeOffsetMs,
        value: keyframe.value,
        easing: keyframe.easing,
        ...(keyframe.bezierPoints ? { bezierPoints: keyframe.bezierPoints } : {}),
      });
    }
    cursorKeyframeCount = cursorKeyframes.length;
  }

  /* ── 7. The camera ──────────────────────────────────────────────── */

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

      /* Square in the raw assemble: a radius is a style decision, and
         `cinematic` is where the style decisions live. */
      const cornerRadius = Math.round(settings.height * (o.cinematic ? 0.022 : 0));
      const patch = buildPipPatch(
        geometry,
        { cornerRadiusPx: cornerRadius },
        { name: 'Camera', startTimeMs: take.cameraOffsetMs, muteAudio: false }
      );
      notes.push(...patch.warnings);
      store().patchClip(cameraClipId, {
        ...patch.properties,
        'transform.flipH': o.mirrorCamera !== false,
      });

      /*
        Everything the camera does, as ONE keyframe track.

        `interpolateKeyframes` falls back to the static transform only
        when a property has no keyframes at all, so a clip with a
        keyframed scale and a static position would snap its position to
        whatever the first position key happened to be. `addCameraMotion`
        pins every property that ever moves at time zero for exactly that
        reason — which is why the entrance cannot simply be written here.

        `fullFrame` is empty: it holds the stretches where the camera
        takes the whole picture, and finding those needs a transcript.
        With none, this writes the fade and the settle into the inset,
        and nothing else.
      */
      if (o.cinematic) {
        const base = getClipBaseSize(
          { ...inserted, fitMode: PIP_FIT_MODE },
          settings,
          { width: camera.width, height: camera.height }
        );
        addCameraMotion(cameraClipId, {
          pip: {
            scale: geometry.scaleX,
            x: geometry.transformX,
            y: geometry.transformY,
            roundness: cornerRadius,
          },
          coverScale: Math.max(settings.width / base.width, settings.height / base.height),
          fullFrame: [],
          durationMs: cameraAsset.durationMs,
        });
      }
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

  /* ── 8. Sound design ────────────────────────────────────────────── */

  let soundClips = 0;
  if (soundTrack && soundKit) {
    const report = placeSoundDesign(
      soundTrack, soundKit, take.events, moments, o.zoomShape, o.soundOptions
    );
    soundClips = report.placed;
    notes.push(...report.notes);
  } else if (soundKit) {
    notes.push(...soundKit.notes);
  }

  /* ── 9. Opening and closing ─────────────────────────────────────── */

  if (gradeTrack) addFades(gradeTrack, settings, take.durationMs, o.look);

  /* ── 10. Markers ────────────────────────────────────────────────── */

  if (o.markMoments) {
    for (let i = 0; i < moments.length; i++) {
      const moment = moments[i];
      store().addMarker(
        Math.round(moment.atMs),
        moment.source === 'mark' ? `Marked ${i + 1}` : `${moment.source} ${i + 1}`,
        'generic',
        moment.source === 'mark' ? '#e8e8e8' : '#86aee4'
      );
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
    zoomMoments: moments.length,
    momentsFrom: moments.length === 0 ? 'none' : detected.from,
    keyframes: keyframeCount,
    cursorKeyframes: cursorKeyframeCount,
    soundClips,
    narrationDetached: Boolean(
      o.detachNarration
      && (cameraClipId ? take.camera?.hasAudio : screen.hasAudio)
    ),
    notes,
  };
}
