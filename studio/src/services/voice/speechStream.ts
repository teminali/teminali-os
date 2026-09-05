/**
 * Reader for the framed reply `/speak` returns when asked to stream — the
 * renderer's half of the contract in `docs/VOICE_SIDECAR.md`. One frame per
 * rendered clause: a length-prefixed JSON header, then a length-prefixed body
 * of 16-bit little-endian PCM.
 *
 *   u32be headerLength | header JSON | u32be bodyLength | body
 *
 * Everything here is pure so it can be tested with byte slices of every size;
 * `clausePlayer.ts` is the part that touches an AudioContext. The gateway and
 * the sidecar carry their own copy of the type and the framing: three separate
 * packages, one documented contract.
 */

export const SPEECH_STREAM_TYPE = "application/vnd.teminali.speech-stream";

/** The header of a frame that carries audio. */
export interface ClauseFrame {
  clause: string;
  /** Character offsets of the clause in the text as sent. */
  start: number;
  end: number;
  sampleRate: number;
  samples: number;
}

export interface SpeechFrameHeader extends Partial<ClauseFrame> {
  /** The reply finished. Its absence at end of stream means it was cut off. */
  done?: boolean;
  /** Synthesis failed after the headers had gone out. */
  error?: string;
}

export interface SpeechFrame {
  header: SpeechFrameHeader;
  body: Uint8Array;
}

/** Whether a `/speak` reply is clause frames rather than a whole file. */
export function isSpeechStream(contentType: string | null | undefined): boolean {
  return Boolean(contentType && contentType.startsWith(SPEECH_STREAM_TYPE));
}

/** True when a header carries a playable clause. */
export function isClauseFrame(header: SpeechFrameHeader): header is ClauseFrame {
  return (
    typeof header.samples === "number" && header.samples > 0 &&
    typeof header.sampleRate === "number" && header.sampleRate > 0 &&
    typeof header.start === "number" && typeof header.end === "number"
  );
}

const decoder = new TextDecoder();

/**
 * Accumulates bytes from any source and hands back each frame once it is whole.
 * A frame split across two reads waits for the second; nothing is parsed in half.
 */
export class FrameReader {
  private pending: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): SpeechFrame[] {
    if (this.pending.length === 0) {
      this.pending = chunk;
    } else {
      const joined = new Uint8Array(this.pending.length + chunk.length);
      joined.set(this.pending, 0);
      joined.set(chunk, this.pending.length);
      this.pending = joined;
    }

    const frames: SpeechFrame[] = [];
    const bytes = this.pending;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    while (bytes.length - offset >= 4) {
      const headerLength = view.getUint32(offset);
      const bodyLengthAt = offset + 4 + headerLength;
      if (bytes.length < bodyLengthAt + 4) break;
      const bodyLength = view.getUint32(bodyLengthAt);
      const bodyStart = bodyLengthAt + 4;
      if (bytes.length < bodyStart + bodyLength) break;
      const header = JSON.parse(decoder.decode(bytes.subarray(offset + 4, bodyLengthAt))) as SpeechFrameHeader;
      frames.push({ header, body: bytes.subarray(bodyStart, bodyStart + bodyLength) });
      offset = bodyStart + bodyLength;
    }
    this.pending = offset === 0 ? bytes : bytes.slice(offset);
    return frames;
  }
}

/** 16-bit little-endian PCM to the float samples an AudioBuffer takes. Works on an unaligned view. */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/**
 * When the next clause should start so playback stays gapless: the instant
 * the previous one ends, or a hair from now if the renderer fell behind and
 * the previous one has already finished.
 */
export function nextStartTime(now: number, previousEnd: number, lead = 0.03): number {
  return Math.max(now + lead, previousEnd);
}

/**
 * How much of a clause was heard when it was cut off `elapsed` seconds in —
 * the character offset a barge-in reports. Linear within the clause, which is
 * the same approximation the whole-file player makes across the whole reply,
 * applied to a much shorter span.
 */
export function heardChars(frame: ClauseFrame, elapsed: number): number {
  const duration = frame.samples / frame.sampleRate;
  if (!(duration > 0) || elapsed <= 0) return frame.start;
  if (elapsed >= duration) return frame.end;
  return frame.start + Math.round(((frame.end - frame.start) * elapsed) / duration);
}

/**
 * Is it time to start rendering the next block?
 *
 * A reply is spoken block by block, and a block's audio cannot start until the
 * synthesiser has rendered it. Started when the previous block ends, that
 * render is heard as a pause; started while the previous block is still being
 * heard, it is heard as nothing at all.
 *
 * Late enough that the current block's own synthesis is finished — two renders
 * at once on one local sidecar would slow the one being listened to — and
 * early enough to cover the round trip. The last fifth of a block is the
 * window: a 12-second paragraph leaves ~2.4s, and a block too short for that
 * to be worth anything is also too short to have a gap worth hearing.
 */
export function readyToWarmNext(spokenChars: number, totalChars: number, fraction = 0.8): boolean {
  if (!(totalChars > 0) || !(spokenChars >= 0)) return false;
  return spokenChars >= totalChars * fraction;
}
