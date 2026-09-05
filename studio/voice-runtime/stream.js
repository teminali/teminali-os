/**
 * The framed reply `/speak` returns when asked to stream.
 *
 * One frame per rendered clause, written the moment that clause is rendered,
 * so the studio starts playing after the first clause instead of after the
 * whole reply. The framing is deliberately dumb: a length-prefixed JSON header
 * and a length-prefixed body of 16-bit little-endian PCM. A reader needs two
 * integers to find the next frame, which lets the studio parse whatever slice
 * sizes the network hands it.
 *
 *   u32be headerLength | header JSON (UTF-8) | u32be bodyLength | body
 *
 * Audio frame header: `{ clause, start, end, sampleRate, samples }`. `start`
 * and `end` are character offsets into the text as sent, so a barge-in can
 * report exactly how much of the reply was heard rather than a proportion of
 * the playback clock.
 * Last frame: `{ done: true }` — so a cut connection is distinguishable from
 * a finished reply. A failure after the headers went out: `{ error }`, then end.
 *
 * The gateway (`server/voice.js`) and the studio (`src/services/voice/
 * speechStream.ts`) each carry their own copy of the content type and parser:
 * they are separate packages, and the contract is the document, not a shared
 * import.
 */

export const SPEECH_STREAM_TYPE = "application/vnd.teminali.speech-stream";

/** One frame: a JSON header and an optional binary body. */
export function encodeFrame(header, body = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(json.length, 0);
  const bodyLength = Buffer.alloc(4);
  bodyLength.writeUInt32BE(body.length, 0);
  return Buffer.concat([headerLength, json, bodyLength, body]);
}

/**
 * Every complete frame at the front of `buffer`, and the bytes left over. A
 * frame split across two reads is left whole for the next call rather than
 * parsed in half.
 */
export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const headerLength = buffer.readUInt32BE(offset);
    const bodyLengthAt = offset + 4 + headerLength;
    if (buffer.length < bodyLengthAt + 4) break;
    const bodyLength = buffer.readUInt32BE(bodyLengthAt);
    const bodyStart = bodyLengthAt + 4;
    if (buffer.length < bodyStart + bodyLength) break;
    const header = JSON.parse(buffer.subarray(offset + 4, bodyLengthAt).toString("utf8"));
    frames.push({ header, body: buffer.subarray(bodyStart, bodyStart + bodyLength) });
    offset = bodyStart + bodyLength;
  }
  return { frames, rest: buffer.subarray(offset) };
}
