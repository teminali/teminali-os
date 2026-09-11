/* ═══════════════════════════════════════════════════════════════════
   Which sources an export can decode sequentially, and which it cannot.

   `DESIGN.md` §3, "Export throughput: the seek is the render", measured
   the exporter spending 80% of its wall clock inside one line:
   `entry.el.currentTime = seconds` in `videoEngine.ts`. A delta frame is
   only decodable from the preceding keyframe, so seeking to frame N
   decodes from N's keyframe forward and throws the rest away — at GOP
   250 that is up to 250 frames of work per delivered frame. Measured
   here it is ~90x.

   The export loop already walks frames in strict presentation order, so
   it is paying random-access cost for a sequential access pattern. This
   module decides, per source, whether that is true for THIS export —
   because three things break it:

     1. **A reversed clip** reads its source back to front, so its
        demands descend.
     2. **Two clips sharing one file, visible at the same instant.** The
        frame override in `videoEngine` holds one frame per URL, so it
        cannot serve two different source times at once. This is not a
        new limitation — the seek path has always had it, since both
        clips seek the same pooled element and the last write wins — but
        a decoder must not silently pick one.
     3. **Any non-monotonic demand**, which a speed ramp or an
        out-of-order split can produce without either of the above.

   A source that fails any of these falls back to the seek path on its
   own. The fallback is PER SOURCE, not per export: one reversed clip
   must not cost the other eleven their sequential decode.

   ## Why it asks for demands rather than reading the timeline

   Taking a `demandsAt` function instead of `Track[]` keeps this a leaf:
   no DOM, no `videoEngine`, no media. The whole of it therefore runs
   under plain `node --test` — the same division `hardwareEncoder.cjs`
   draws between deciding and spawning, and the reason its decision table
   is testable without an ffmpeg or a Windows machine. The caller owns
   what is visible when; this owns what that implies for a decoder.
   ═══════════════════════════════════════════════════════════════════ */

/** What one source is asked for at one instant of the timeline. */
export interface FrameSourceDemand {
  url: string;
  /** Where in the source this frame comes from, in seconds. */
  seconds: number;
  /** A reversed clip descends through its source and can never stream. */
  reversed?: boolean;
}

/** One output frame's demand on one source. */
export interface FrameDemand {
  /** Index into the export, 0-based. */
  frame: number;
  seconds: number;
}

export type SourcePlan =
  | { url: string; mode: 'sequential'; demands: FrameDemand[] }
  | { url: string; mode: 'seek'; reason: string };

/**
 * Demands are monotonic if they never ask for an earlier source time than
 * one already served. Equal is fine and common — a clip slowed to half
 * speed asks for the same source frame twice, and the decoder answers the
 * second from the frame it is already holding rather than decoding again.
 */
function firstRegression(demands: FrameDemand[]): number | null {
  for (let i = 1; i < demands.length; i += 1) {
    if (demands[i].seconds < demands[i - 1].seconds) return i;
  }
  return null;
}

/**
 * Decide, for every video source the export will touch, whether it can be
 * pulled in order.
 *
 * `frameIntervalMs` rather than an fps so the caller's rounding is the one
 * that decides which frame lands on which side of a cut — the export loop
 * computes its timestamps from the frame index for exactly that reason,
 * and a second rounding here would put this plan on different frames than
 * the render it is planning for.
 */
export function planSequentialDecode(
  demandsAt: (timestampMs: number) => FrameSourceDemand[],
  startMs: number,
  totalFrames: number,
  frameIntervalMs: number,
): SourcePlan[] {
  const demandsByUrl = new Map<string, FrameDemand[]>();
  const collisions = new Set<string>();
  const reversed = new Set<string>();

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const seenThisFrame = new Set<string>();

    for (const demand of demandsAt(startMs + frame * frameIntervalMs)) {
      const { url } = demand;
      if (!url) continue;

      if (demand.reversed) reversed.add(url);

      /*
        Two clips of one file on screen together. Recorded rather than
        thrown: the source falls back, the export continues.
      */
      if (seenThisFrame.has(url)) {
        collisions.add(url);
        continue;
      }
      seenThisFrame.add(url);

      if (!Number.isFinite(demand.seconds)) continue;

      let list = demandsByUrl.get(url);
      if (!list) {
        list = [];
        demandsByUrl.set(url, list);
      }
      list.push({ frame, seconds: demand.seconds });
    }
  }

  const plans: SourcePlan[] = [];
  for (const [url, demands] of demandsByUrl) {
    if (reversed.has(url)) {
      plans.push({ url, mode: 'seek', reason: 'a clip of this source is reversed' });
      continue;
    }
    if (collisions.has(url)) {
      plans.push({ url, mode: 'seek', reason: 'two clips of this source are visible at once' });
      continue;
    }
    const regression = firstRegression(demands);
    if (regression !== null) {
      plans.push({
        url,
        mode: 'seek',
        reason: `source time goes backwards at output frame ${demands[regression].frame}`,
      });
      continue;
    }
    plans.push({ url, mode: 'sequential', demands });
  }

  return plans;
}

/** The URLs that will be decoded in order, for the loop to consult cheaply. */
export function sequentialUrls(plans: SourcePlan[]): Set<string> {
  return new Set(plans.filter((p) => p.mode === 'sequential').map((p) => p.url));
}

/**
 * A one-line summary for the export's telemetry. Operators need to know
 * WHY an export was slow, and "3 of 4 sources decoded in order" is the
 * difference between a machine that is busy and a timeline that opted
 * itself out of the fast path.
 */
export function describePlans(plans: SourcePlan[]): string {
  const fast = plans.filter((p) => p.mode === 'sequential').length;
  if (plans.length === 0) return 'no video sources';
  if (fast === plans.length) return `${fast}/${plans.length} sources decoded in order`;
  const why = plans.find((p) => p.mode === 'seek') as { reason: string } | undefined;
  return `${fast}/${plans.length} sources decoded in order — ${why?.reason ?? 'unknown'}`;
}
