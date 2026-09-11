/* ═══════════════════════════════════════════════════════════════════
   The export's decoders, pulled in order.

   `sequentialPlan.ts` decides WHICH sources can be read this way; this
   opens them and walks them. One `VideoSampleSink` per source, driven by
   `samplesAtTimestamps`, which decodes each packet at most once for a
   monotonic timestamp list — the whole point, since the seek path
   re-decodes from the preceding keyframe every single frame.

   ## Two decisions worth knowing

   **The frame is copied into a canvas, not handed over live.** A
   `VideoSample` owns GPU-backed memory and must be closed, and
   `toCanvasImageSource()` would hand the compositor a `VideoFrame` whose
   lifetime then straddles `renderTimelineFrame`. Closing it too early
   paints nothing; closing it late leaks a decoder buffer and stalls the
   decode after a handful of frames. Copying costs one `drawImage` per
   frame against a decode budget of ~2000fps and removes the entire class
   of bug, so it is copied — the same trade `updateLastFrame` already
   makes for the preview.

   **Opening is allowed to fail, per source.** A codec WebCodecs will not
   take, a URL that will not range-request, a container mediabunny cannot
   parse: each drops that ONE source back to the seek path and the export
   continues. `canDecode()` is asked rather than assumed, because the
   alternative is an export that dies at frame 400 of 900.
   ═══════════════════════════════════════════════════════════════════ */

import type { Input, VideoSample } from 'mediabunny';
import type { SourcePlan, FrameDemand } from './sequentialPlan';
import { setDecodedFrame, clearDecodedFrame } from './videoEngine';

interface OpenSource {
  url: string;
  demands: FrameDemand[];
  cursor: number;
  samples: AsyncGenerator<VideoSample | null, void, unknown>;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  input: Input;
}

export interface SequentialDecoders {
  /** The sources actually being decoded in order — the rest still seek. */
  readonly urls: Set<string>;
  /** Why each source that wanted the fast path did not get it. */
  readonly fallbacks: Map<string, string>;
  /** Publish every frame due at this output frame index. */
  advance(frame: number): Promise<void>;
  /** Release decoders and inputs. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * mediabunny needs bytes. A `blob:` URL is already in this process, so it
 * is fetched whole; anything addressable is opened as a `UrlSource`, which
 * range-requests rather than pulling a four-gigabyte file into memory to
 * read a thousand frames out of it.
 */
async function sourceFor(mb: MediaBunny, url: string) {
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    const response = await fetch(url);
    return new mb.BlobSource(await response.blob());
  }
  return new mb.UrlSource(url);
}

/*
  Loaded by the export that needs it, never at startup. Statically imported
  it is ~670 KB of demuxers in the main bundle for a feature most sessions
  never reach, and this editor opens inside an IDE panel — the cost lands on
  every launch, not on the render.
*/
type MediaBunny = typeof import('mediabunny');
let mediabunny: Promise<MediaBunny> | null = null;
const loadMediabunny = (): Promise<MediaBunny> => (mediabunny ??= import('mediabunny'));

async function openOne(
  mb: MediaBunny,
  plan: Extract<SourcePlan, { mode: 'sequential' }>,
): Promise<OpenSource> {
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: await sourceFor(mb, plan.url) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video track');
  if (!(await track.canDecode())) throw new Error('this build cannot decode that codec');

  const canvas = document.createElement('canvas');
  canvas.width = await track.getCodedWidth();
  canvas.height = await track.getCodedHeight();
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('no 2d context');

  const sink = new mb.VideoSampleSink(track);
  const samples = sink.samplesAtTimestamps(plan.demands.map((d) => d.seconds));

  return { url: plan.url, demands: plan.demands, cursor: 0, samples, canvas, ctx, input };
}

/**
 * Open every source the plan marked sequential.
 *
 * Sources are opened concurrently — each one costs a container parse and,
 * for a remote URL, a round trip, and doing twelve of those in series in
 * front of the first frame is a visible stall before the progress bar
 * moves.
 */
export async function openSequentialDecoders(plans: SourcePlan[]): Promise<SequentialDecoders> {
  const wanted = plans.filter(
    (p): p is Extract<SourcePlan, { mode: 'sequential' }> => p.mode === 'sequential',
  );

  const fallbacks = new Map<string, string>();
  for (const plan of plans) {
    if (plan.mode === 'seek') fallbacks.set(plan.url, plan.reason);
  }

  const mb = await loadMediabunny();
  const settled = await Promise.allSettled(wanted.map((plan) => openOne(mb, plan)));
  const open = new Map<string, OpenSource>();
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      open.set(wanted[i].url, result.value);
    } else {
      const why = result.reason instanceof Error ? result.reason.message : String(result.reason);
      fallbacks.set(wanted[i].url, `could not be opened for sequential decode (${why})`);
    }
  });

  let closed = false;

  return {
    urls: new Set(open.keys()),
    fallbacks,

    async advance(frame: number): Promise<void> {
      const due: Promise<void>[] = [];

      for (const source of open.values()) {
        const demand = source.demands[source.cursor];
        if (!demand || demand.frame !== frame) continue;
        source.cursor += 1;

        due.push(
          source.samples.next().then(({ value, done }) => {
            /*
              A null sample is a timestamp before the track's first frame —
              legitimate, and the compositor should paint what it painted
              last rather than a black hole, so the override is left alone.
            */
            if (done || !value) return;
            source.ctx.drawImage(value.toCanvasImageSource() as CanvasImageSource, 0, 0);
            value.close();
            setDecodedFrame(source.url, source.canvas, source.canvas.width, source.canvas.height);
          }).catch((error) => {
            /*
              A decode that fails mid-export drops this source for the rest
              of it. The override is cleared so the compositor falls back
              to the pooled element, which still holds a frame.
            */
            open.delete(source.url);
            clearDecodedFrame(source.url);
            fallbacks.set(source.url, `decode failed at frame ${frame} (${String(error)})`);
          }),
        );
      }

      await Promise.all(due);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled(
        [...open.values()].map(async (source) => {
          clearDecodedFrame(source.url);
          await source.samples.return(undefined);
          await source.input.dispose();
          source.canvas.width = 0;
          source.canvas.height = 0;
        }),
      );
      open.clear();
    },
  };
}
