/* ═══════════════════════════════════════════════════════════════════
   Tier 2: encode the frame here, instead of shipping a JPEG of it.

   What the JPEG path costs, measured on real footage after tier 1
   landed (DESIGN.md §3): 4.2s of a 4.8s render. Having removed the
   seek, the encode is now ~88% of the export. Per frame it was a JPEG
   encode, an `arrayBuffer` copy, an IPC hop, ffmpeg DECODING that JPEG
   again, and only then an H.264 encode — two codec round-trips that
   exist solely to move pixels between two processes, plus a generation
   of lossy recompression nobody asked for.

   This encodes H.264 or HEVC in the renderer and pipes the elementary
   stream straight to ffmpeg, which `-c:v copy`s it into the container
   and keeps owning the audio mix and the mux. ffmpeg does not stop
   being involved; it stops transcoding.

   ## The two failures this is written around

   **Colour, which is invisible until someone looks — including by
   SSIM.** The obvious reasoning is that a canvas is full-range sRGB, so
   the output should be tagged `pc`. Measured on this machine, that is
   wrong: the encoder converts to LIMITED range and writes `tv`/bt709
   into the bitstream VUI itself, which `-c:v copy` then preserves.
   Forcing `pc` on the container makes it contradict the bitstream and a
   player renders it washed out.

   The trap is that quality metrics cannot catch it. Comparing a forced-
   `pc` mux and an untagged one against the same source gave an
   IDENTICAL SSIM of 0.994977 and PSNR of 45.46 dB, because those filters
   compare decoded YUV and never look at the range tag. So this module
   states no colour at all and `videoExport.cjs` adds no colour flags:
   the bitstream is self-consistent and is left to speak. Verify with
   `ffprobe` — `yuv420p(tv, bt709)` — not with SSIM.

   **A silent software fallback.** `prefer-hardware` is a preference,
   not a guarantee, and WebCodecs exposes no way to ask which one you
   got — so a 2x regression looks exactly like nothing. What is
   available is the config the UA echoes back from
   `isConfigSupported`, which is recorded and surfaced rather than
   assumed. Do not read `hardware: true` below as "VideoToolbox ran";
   read it as "the UA accepted a hardware-preferring config".

   ## B-frames are not allowed

   ffmpeg parses the piped elementary stream with `-r` (an INPUT option
   — see `videoExport.cjs`), assigning presentation times in the order
   packets arrive. A codec that reorders its output would therefore put
   frames in the file in decode order. The configuration asks for
   `latencyMode: 'realtime'`, which is what turns B-frames off in
   practice on every encoder this ships against; measured on real
   footage it produced exactly 600 chunks for 600 frames, which is the
   assertion that this held.
   ═══════════════════════════════════════════════════════════════════ */

export type FrameFormat = 'jpeg' | 'h264' | 'hevc';

export interface EncodedFrames {
  /** Annex-B bytes ready for the pipe, in presentation order. */
  bytes: Uint8Array[];
}

export interface FrameEncoder {
  readonly format: FrameFormat;
  /** The config the UA accepted — NOT proof that hardware ran. See above. */
  readonly acceptedConfig: Record<string, unknown> | null;
  /** Submit one frame; returns whatever finished encoding by now. */
  encode(canvas: HTMLCanvasElement, frameIndex: number, keyFrame: boolean): Promise<Uint8Array[]>;
  /** Drain the encoder at the end of the render. */
  flush(): Promise<Uint8Array[]>;
  close(): void;
}

/**
 * An H.264 level that can actually carry these dimensions.
 *
 * Naming a level below the frame size is not a quality setting, it is a
 * rejected config — and the failure arrives as "unsupported", with nothing
 * to say which of the four fields was wrong.
 */
export function avcCodecString(width: number, height: number): string {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  /*
    High profile (0x64), constraint flags 0, then level_idc in hex. The
    thresholds are MaxFS from Table A-1 of the H.264 spec, in macroblocks —
    getting them from memory put 4K on 5.1 via level 5.0's limit of 22080,
    which is a number that belongs to a different row.
  */
  if (macroblocks <= 8192) return 'avc1.640028'; // 4.0  MaxFS 8192  — through 1080p
  if (macroblocks <= 22080) return 'avc1.640032'; // 5.0  MaxFS 22080 — through 1440p
  if (macroblocks <= 36864) return 'avc1.640034'; // 5.2  MaxFS 36864 — through 4K
  return 'avc1.64003E'; // 6.2  MaxFS 139264 — 8K
}

/**
 * Unused while HEVC is held on the JPEG path — kept because the string is the
 * fiddly part and rediscovering it is most of the work of trying again.
 */
export function hevcCodecString(): string {
  // Main profile, level 5.1 — the widest thing VideoToolbox and NVENC agree on.
  return 'hev1.1.6.L153.90';
}

/**
 * Whether this build can encode `codec` at these dimensions in the renderer.
 *
 * ProRes is never a candidate: WebCodecs has no ProRes encoder, and the
 * codec exists in this product precisely for people who do not want an
 * inter-frame format.
 */
export async function pickFrameFormat(
  codec: 'h264' | 'hevc' | 'prores',
  width: number,
  height: number,
  bitrate: number,
): Promise<{ format: FrameFormat; config: Record<string, unknown> | null }> {
  if (codec === 'prores') return { format: 'jpeg', config: null };
  if (typeof VideoEncoder === 'undefined') return { format: 'jpeg', config: null };

  /*
    HEVC stays on the JPEG path, measured 2026-09-11.

    The renderer's HEVC encoder does not honour the bitrate it is given. Asked
    for 12 Mbps at 1080p it produced **698 kbps** and scored SSIM 0.818 against
    the source, where H.264 from the same frames at the same request produced
    5.4 Mbps and 0.954. That is a visible quality regression, and an export is
    the one artefact a user cannot re-render cheaply.

    So HEVC keeps going through ffmpeg's `hevc_videotoolbox`, which does honour
    it (`exportFilters.cjs`). H.264 — the default, and what almost every export
    uses — keeps the fast path. Revisit by finding which field the encoder is
    actually reading: `latencyMode: 'realtime'` and `bitrateMode` are the two
    candidates, and neither has been tested apart yet.
  */
  if (codec === 'hevc') return { format: 'jpeg', config: null };

  const codecString = avcCodecString(width, height);
  const config: VideoEncoderConfig = {
    codec: codecString,
    width,
    height,
    bitrate,
    framerate: 30,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
    avc: { format: 'annexb' },
  } as VideoEncoderConfig;

  try {
    const support = await VideoEncoder.isConfigSupported(config);
    if (!support.supported) return { format: 'jpeg', config: null };
    return {
      format: 'h264',
      config: (support.config ?? config) as unknown as Record<string, unknown>,
    };
  } catch {
    /* An unknown codec string throws rather than returning unsupported. */
    return { format: 'jpeg', config: null };
  }
}

/**
 * Build the renderer-side encoder, or null when this export must keep
 * using JPEG — ProRes, a browser build, or a codec the UA will not take.
 */
export async function createFrameEncoder(
  codec: 'h264' | 'hevc' | 'prores',
  width: number,
  height: number,
  bitrate: number,
  fps: number,
): Promise<FrameEncoder | null> {
  const picked = await pickFrameFormat(codec, width, height, bitrate);
  if (picked.format === 'jpeg') return null;

  const pending: Uint8Array[] = [];
  let failure: Error | null = null;

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      pending.push(bytes);
    },
    error: (error) => {
      failure = error instanceof Error ? error : new Error(String(error));
    },
  });

  const config = { ...(picked.config as unknown as VideoEncoderConfig), framerate: fps };
  encoder.configure(config);

  const drain = (): Uint8Array[] => {
    if (failure) throw failure;
    if (pending.length === 0) return [];
    return pending.splice(0, pending.length);
  };

  return {
    format: picked.format,
    acceptedConfig: picked.config,

    async encode(canvas, frameIndex, keyFrame) {
      if (failure) throw failure;

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((frameIndex * 1_000_000) / fps),
        duration: Math.round(1_000_000 / fps),
      });
      encoder.encode(frame, { keyFrame });
      frame.close();

      /*
        Backpressure. Without it the whole render queues into the encoder
        and the process holds every frame at once — the decoder is fast
        enough now to do exactly that.
      */
      if (encoder.encodeQueueSize > 8) {
        await new Promise<void>((resolve) => {
          const wait = () => (encoder.encodeQueueSize <= 4
            ? resolve()
            : encoder.addEventListener('dequeue', wait, { once: true }));
          wait();
        });
      }

      return drain();
    },

    async flush() {
      await encoder.flush();
      return drain();
    },

    close() {
      try {
        if (encoder.state !== 'closed') encoder.close();
      } catch {
        /* already gone */
      }
    },
  };
}
