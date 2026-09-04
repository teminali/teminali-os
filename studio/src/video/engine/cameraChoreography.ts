/* ═══════════════════════════════════════════════════════════════════
   Where the camera goes, and when it stops being an inset.

   `cinematicLook.ts` can already move the camera: `addCameraMotion`
   takes a resting pose and a list of stretches where the camera takes
   the whole frame, and writes both as one keyframe track. Nothing ever
   filled that list. The file header of `recordingProject.ts` says why —
   the Cut hands the camera the frame during a spoken PAUSE, a pause is
   read out of a transcript, and this app ships no speech model.

   This module fills it without one, and the argument is that a
   transcript was the wrong evidence for the question anyway.

   ── Presenting, and explaining ─────────────────────────────────────

   The question the takeover actually asks is not "is there speech
   here". It is "is the screen still the subject". Those come apart
   constantly: someone reading a paragraph aloud off the screen is
   speaking continuously and the screen is very much the subject.

   What separates the two is the HANDS. Presenting drives the interface
   — clicks, scrolls, keystrokes, a pointer going somewhere. Explaining
   lets go of it: the screen holds still, the pointer parks, and the
   talking carries the take. The input hook already records exactly
   that, at 30Hz, and it records it for the zoom detector — which reads
   the same track for the opposite signal.

   So the takeover is placed on input silence over a live microphone,
   and the microphone is the half that keeps it honest: quiet hands
   with no narration is not an explanation, it is someone who walked
   away, and `explainingStretches` returns nothing without narration
   rather than filling the frame with a face that is not talking.

   This is a weaker signal than a transcript and it is not pretending
   otherwise. It is bounded to match: no stretch longer than
   `maxMs`, never more than `maxShare` of the take, and never the
   closing seconds, which belong to someone reaching for the stop key.

   ── Dodging ────────────────────────────────────────────────────────

   The inset covers a corner of the screen, and sooner or later the
   thing being demonstrated is under it. Every screen recorder that
   ships a camera bubble has this problem and most answer it by making
   the operator pick the least-bad corner before recording, which is a
   guess made before the take about a collision that happens during it.

   `cameraDodges` answers it after the fact, from the pointer track: the
   inset walks to the other side of the frame when the pointer settles
   under it, and walks back when it leaves. Sideways only, and that is
   deliberate — the vertical position is where the operator put it, and
   an inset that moved on both axes would be a fourth thing moving in a
   frame that already has a zoom, a pointer and a takeover in it.

   ── Why all of this is keyframes ───────────────────────────────────

   Nothing here composites, crops or re-encodes. Every function returns
   plain numbers that become keyframes on the camera clip, so the whole
   choreography is visible in the timeline as keys an editor can drag,
   thin out or delete. A dodge the detector got wrong costs one undo,
   not a rebuild — which is the same claim `recordingProject.ts` makes
   about the assemble as a whole, held to on the way in.
   ═══════════════════════════════════════════════════════════════════ */

import type { CursorSample, InputEvent } from '../../types/recorder';

/* ── The shape of the window ────────────────────────────────────── */

/**
 * What the camera inset is cut to.
 *
 * `full` is the camera as it was recorded — the whole sensor frame at
 * its own aspect, portrait or landscape, just small. The other three
 * crop it, and cropping a webcam is close to free: a face sits in the
 * middle of a 16:9 frame with most of a room either side of it, so a
 * square or a circle throws away the room and keeps the subject.
 */
export type CameraShape = 'full' | 'rounded' | 'square' | 'circle';

export const CAMERA_SHAPES: { id: CameraShape; label: string; hint: string }[] = [
  { id: 'rounded', label: 'Rounded', hint: 'The whole camera frame, corners softened.' },
  { id: 'circle', label: 'Circle', hint: 'Cropped square, masked to a circle.' },
  { id: 'square', label: 'Square', hint: 'Cropped square, corners softened.' },
  { id: 'full', label: 'Full', hint: 'Exactly what the camera recorded, uncropped.' },
];

/**
 * The mask that cuts the inset to a shape.
 *
 * A mask rather than a crop for the reason everything else here is a
 * keyframe: `mask.*` is a clip property the inspector already edits, so
 * a circle can be turned back into a rectangle by the person looking at
 * it. A crop would have had to be baked into the geometry.
 *
 * The square cases are the interesting ones. `mask.sizeX` and
 * `mask.sizeY` are percentages of the LAYER, so a square hole in a
 * 16:9 layer is `sizeY = 100` and `sizeX = 100 * height / width` —
 * without that second number an "ellipse" over a 16:9 webcam is an
 * oval, which is what every naive circular-webcam implementation
 * renders and nobody wants.
 *
 * @param natural the camera's own pixel size, which sets the aspect the
 *   square has to be squeezed out of.
 * @param cornerRadiusPx the rounded-rectangle radius for the shapes
 *   that keep their corners. Ignored by `circle`, which has none.
 */
export function cameraShapeMask(
  shape: CameraShape,
  natural: { width: number; height: number },
  cornerRadiusPx: number
): Record<string, unknown> {
  const off = { 'mask.enabled': false };
  if (shape === 'full') return off;

  const wide = natural.width >= natural.height;
  const ratio = wide
    ? (natural.height > 0 ? natural.height / natural.width : 1)
    : (natural.width > 0 ? natural.width / natural.height : 1);
  /* A camera that reported a nonsense size is left alone rather than
     masked to a sliver. */
  const square = Number.isFinite(ratio) && ratio > 0 ? Math.min(1, ratio) : 1;

  const base = {
    'mask.enabled': true,
    'mask.offsetX': 0,
    'mask.offsetY': 0,
    'mask.rotation': 0,
    'mask.featherPx': 0,
    'mask.inverted': false,
  };

  if (shape === 'rounded') {
    return {
      ...base,
      'mask.type': 'rectangle',
      'mask.sizeX': 100,
      'mask.sizeY': 100,
      'mask.roundness': Math.max(0, cornerRadiusPx),
    };
  }

  const sizeX = wide ? 100 * square : 100;
  const sizeY = wide ? 100 : 100 * square;

  if (shape === 'square') {
    return {
      ...base,
      'mask.type': 'rectangle',
      'mask.sizeX': sizeX,
      'mask.sizeY': sizeY,
      'mask.roundness': Math.max(0, cornerRadiusPx),
    };
  }

  /* Circle. `traceMaskPath` clamps roundness to half the short edge, so
     an ellipse over a square region is already a circle; the roundness
     is zeroed anyway so nothing downstream reads a radius that does not
     apply. */
  return {
    ...base,
    'mask.type': 'ellipse',
    'mask.sizeX': sizeX,
    'mask.sizeY': sizeY,
    'mask.roundness': 0,
  };
}

/* ── Dodging the pointer ────────────────────────────────────────── */

export interface DodgeOptions {
  /**
   * How much wider than the inset the danger zone is, as a fraction of
   * the inset's own width. The pointer does not have to be ON the
   * bubble for the bubble to be in the way — what is under discussion
   * is usually just beside it.
   */
  guard: number;
  /**
   * How long the pointer has to stay in the zone before the inset
   * moves. A pointer crossing a corner on its way somewhere else is
   * gone inside a fifth of a second; one that has arrived stays.
   */
  dwellMs: number;
  /**
   * How long the zone has to stay clear before the inset comes home.
   * Much longer than `dwellMs` on purpose: leaving is cheap to get
   * wrong in one direction only. A bubble that returns too eagerly
   * crosses the frame twice for a pointer that was coming straight
   * back, and an inset that lingers on the wrong side costs nothing.
   */
  clearMs: number;
  /** The inset will not move twice inside this. */
  minHoldMs: number;
  /** How long a crossing takes. */
  travelMs: number;
}

export const DEFAULT_DODGE: DodgeOptions = {
  guard: 0.35,
  dwellMs: 260,
  clearMs: 900,
  minHoldMs: 1400,
  travelMs: 520,
};

/** A move of the inset, in clip time. `x` is a transform offset in project pixels. */
export interface DodgeMove {
  atMs: number;
  x: number;
  side: 'home' | 'away';
}

/**
 * Where the inset should be, over the take.
 *
 * @param cursor the pointer track, normalised 0..1 against the captured
 *   display — which is what makes this resolution-independent.
 * @param inset the resting pose in project pixels, and the frame it
 *   sits in. `x` is the transform offset `computePipGeometry` produced,
 *   so mirroring it is a negation and nothing has to be re-derived.
 *
 * Returns an empty list when the pointer never settles under the inset,
 * which is the common case and costs nothing: no moves, no keyframes,
 * no difference from the build that existed before this module.
 */
export function cameraDodges(
  cursor: CursorSample[],
  inset: { x: number; widthPx: number; heightPx: number; frameW: number; frameH: number },
  options: DodgeOptions = DEFAULT_DODGE
): DodgeMove[] {
  if (cursor.length === 0 || inset.frameW <= 0 || inset.frameH <= 0) return [];
  /* An inset centred horizontally has no other side to go to. */
  if (Math.abs(inset.x) < inset.widthPx * 0.1) return [];

  /*
    The zone, in the same normalised space as the samples.

    The inset's centre is the frame centre plus its transform offset, so
    the box is derived from the pose rather than from the corner name —
    a pose that came from somewhere else still gets the right zone.
  */
  const halfW = (inset.widthPx * (1 + options.guard)) / 2;
  const centreX = inset.frameW / 2 + inset.x;
  const left = (centreX - halfW) / inset.frameW;
  const right = (centreX + halfW) / inset.frameW;

  /* Vertically the guard is one-sided: the inset sits against an edge,
     and the half of the zone outside the frame cannot hold a pointer. */
  const halfH = (inset.heightPx * (1 + options.guard)) / 2;
  const centreY = inset.frameH / 2 + (inset.x === 0 ? 0 : 0);
  const top = (centreY - halfH) / inset.frameH;
  const bottom = (centreY + halfH) / inset.frameH;

  const inZone = (s: CursorSample) =>
    s.x >= left && s.x <= right && s.y >= top && s.y <= bottom;

  const moves: DodgeMove[] = [];
  let away = false;
  let since: number | null = null;
  let lastMoveMs = -Infinity;

  for (const sample of cursor) {
    const hit = inZone(sample);
    const wants = hit !== away ? hit : null;

    if (wants === null) {
      since = null;
      continue;
    }
    if (since === null) since = sample.tMs;

    const held = sample.tMs - since;
    const need = hit ? options.dwellMs : options.clearMs;
    if (held < need) continue;
    if (sample.tMs - lastMoveMs < options.minHoldMs) continue;

    away = hit;
    since = null;
    lastMoveMs = sample.tMs;
    moves.push({
      atMs: sample.tMs,
      x: away ? -inset.x : inset.x,
      side: away ? 'away' : 'home',
    });
  }

  return moves;
}

/* ── When the screen stops being the subject ────────────────────── */

export interface ExplainOptions {
  /** No click, scroll or keystroke for this long before a stretch can start. */
  quietMs: number;
  /**
   * How far the pointer may drift, as a fraction of the frame's
   * diagonal, and still count as parked. Not zero: a hand resting on a
   * trackpad moves the pointer a pixel or two a second.
   */
  driftPct: number;
  /** Shorter than this is not an explanation, it is a gap. */
  minMs: number;
  /** Longer than this stops being a beat in a tutorial and becomes a different video. */
  maxMs: number;
  /** Give the frame back this long before the hands come back to it. */
  leadOutMs: number;
  /** Never hand over more than this share of the take. */
  maxShare: number;
  /** The closing seconds belong to whoever is reaching for the stop key. */
  tailMs: number;
}

export const DEFAULT_EXPLAIN: ExplainOptions = {
  quietMs: 2600,
  driftPct: 0.02,
  minMs: 3200,
  maxMs: 12000,
  leadOutMs: 700,
  maxShare: 0.35,
  tailMs: 2000,
};

export interface ExplainInput {
  cursor: CursorSample[];
  events: InputEvent[];
  durationMs: number;
  /**
   * Whether the camera clip carries narration.
   *
   * The gate, not a hint. Quiet hands with a live microphone is someone
   * explaining; quiet hands with no microphone is someone who left the
   * room, and the difference is the whole basis for putting a face in
   * the frame.
   */
  hasNarration: boolean;
}

/**
 * Stretches where the camera should take the whole frame.
 *
 * Returned in CLIP time for the camera clip — the caller shifts by
 * `cameraOffsetMs` if it needs take time. Empty is the honest answer
 * for most takes and for every take without narration.
 */
export function explainingStretches(
  input: ExplainInput,
  options: ExplainOptions = DEFAULT_EXPLAIN
): { startMs: number; endMs: number }[] {
  if (!input.hasNarration) return [];
  if (input.durationMs <= options.minMs) return [];

  /*
    Every moment the hands were on the machine, in one sorted list.

    Pointer motion counts as input, and it has to: a demonstration that
    is all mouse and no clicking — dragging a slider, tracing a diagram
    — has no events in it at all, and without the pointer this would
    call the most active part of some takes an explanation.
  */
  const activity: number[] = input.events.map((e) => e.tMs);

  /*
    Displacement from an ANCHOR, not from the previous sample.

    Sample-to-sample was the first version and it misses the case it
    most needs to catch. A pointer dragged slowly across the whole frame
    over thirty seconds moves 0.0007 between samples at 30Hz — under any
    threshold loose enough to ignore a resting hand — so a continuous
    drag with no clicks in it read as thirty seconds of explanation.
    Against a fixed anchor the drag accumulates and trips; a resting
    hand oscillates around the anchor and never does, which is the
    distinction the threshold was always meant to draw.
  */
  const diagonal = Math.hypot(1, 1);
  const drift = options.driftPct * diagonal;
  let anchor = input.cursor[0] ?? null;
  for (const sample of input.cursor) {
    if (anchor === null) { anchor = sample; continue; }
    if (Math.hypot(sample.x - anchor.x, sample.y - anchor.y) > drift) {
      activity.push(sample.tMs);
      anchor = sample;
    }
  }
  activity.sort((p, q) => p - q);

  /* The window the take is allowed to give away at all. */
  const last = Math.max(0, input.durationMs - options.tailMs);

  const gaps: { startMs: number; endMs: number }[] = [];
  let previous = 0;
  for (const at of [...activity, last]) {
    if (at > last) break;
    const gap = at - previous;
    if (gap >= options.quietMs) {
      /*
        The stretch is the quiet, minus the moment the hands stopped and
        minus the run-up to them starting again. Both ends are trimmed
        because a takeover is a 620ms move at each end: start it on the
        instant of the last click and the camera is still growing while
        the screen is still the subject.
      */
      const startMs = previous + options.quietMs * 0.5;
      const endMs = Math.max(startMs, at - options.leadOutMs);
      if (endMs - startMs >= options.minMs) {
        gaps.push({ startMs, endMs: Math.min(endMs, startMs + options.maxMs) });
      }
    }
    previous = Math.max(previous, at);
  }

  if (gaps.length === 0) return [];

  /*
    The budget, spent on the longest stretches first.

    Longest first rather than first-come because the longest silence in
    a take is the likeliest to be a real explanation, and a budget spent
    chronologically would give it away to three short pauses near the
    top and refuse the two-minute walkthrough of the architecture.
  */
  const budget = input.durationMs * options.maxShare;
  const ranked = [...gaps].sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs));
  const kept: { startMs: number; endMs: number }[] = [];
  let spent = 0;
  for (const gap of ranked) {
    /*
      Trimmed to what is left, not refused for not fitting.

      Refusing was the first version and it was wrong in the case that
      matters most: a 30-second take has a 10.5s budget and `maxMs` is
      12s, so the one long explanation in it — the whole reason the
      feature exists — cost more than the budget and the take got no
      takeover at all. A budget should shorten the answer, not delete
      it. What it will not do is produce a stub: below `minMs` there is
      nothing left worth crossing the frame for, and the loop stops.
    */
    const room = budget - spent;
    if (room < options.minMs) break;
    const cost = Math.min(gap.endMs - gap.startMs, room);
    spent += cost;
    kept.push({ startMs: gap.startMs, endMs: gap.startMs + cost });
  }

  return kept.sort((a, b) => a.startMs - b.startMs);
}
