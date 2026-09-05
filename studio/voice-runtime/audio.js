/**
 * Audio plumbing for the voice sidecar.
 *
 * The studio records with MediaRecorder, which in Chromium means webm/opus.
 * Whisper wants 16 kHz mono float32. Nothing in Node decodes opus out of the
 * box, so ffmpeg does it: it is already a dependency of this repo's video work
 * and it handles every container the recorder might pick.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export const SAMPLE_RATE = 16_000;

const FFMPEG_CANDIDATES = [
  process.env.TEMINALI_FFMPEG,
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
];

let resolved;

/** The ffmpeg binary to use, or null when there is none. */
export function ffmpegPath() {
  if (resolved !== undefined) return resolved;
  resolved = FFMPEG_CANDIDATES.find((candidate) => candidate && existsSync(candidate)) ?? null;
  if (!resolved) {
    // Last resort: trust PATH. Spawning will fail loudly if it is not there.
    resolved = "ffmpeg";
  }
  return resolved;
}

/**
 * Decode any container ffmpeg understands into mono float32 at 16 kHz.
 * Rejects rather than returning silence, so a decode failure is never mistaken
 * for "the operator said nothing".
 */
export function decodeToPcm(input, { sampleRate = SAMPLE_RATE } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "f32le", "-acodec", "pcm_f32le",
      "-ac", "1", "-ar", String(sampleRate),
      "pipe:1",
    ]);

    const chunks = [];
    let stderr = "";
    ff.stdout.on("data", (chunk) => chunks.push(chunk));
    ff.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    ff.on("error", (error) => reject(new Error(`ffmpeg could not start (${error.message}).`)));
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed (${code}): ${stderr.trim().slice(0, 200)}`));
      const buffer = Buffer.concat(chunks);
      // Buffer.buffer may be a slice of a larger pool, so copy the range.
      const samples = new Float32Array(buffer.byteLength / 4);
      for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readFloatLE(i * 4);
      resolve(samples);
    });

    ff.stdin.on("error", () => { /* closed early; the close handler reports it */ });
    ff.stdin.end(input);
  });
}

/** Root-mean-square amplitude, the cheap "was there any sound at all" test. */
export function rms(samples) {
  if (!samples?.length) return 0;
  let total = 0;
  for (let i = 0; i < samples.length; i += 1) total += samples[i] * samples[i];
  return Math.sqrt(total / samples.length);
}

/**
 * The fraction of 20 ms frames whose energy stands clear of the clip's own
 * noise floor. Whisper invents words when handed silence or steady hiss, so
 * this is the gate that decides whether it is asked at all. Measuring against
 * the clip's own floor rather than a fixed threshold keeps it honest in a
 * noisy room as well as a quiet one.
 */
export function voicedFraction(samples, sampleRate = SAMPLE_RATE) {
  if (!samples?.length) return 0;
  const frame = Math.max(1, Math.floor(sampleRate * 0.02));
  const energies = [];
  for (let start = 0; start + frame <= samples.length; start += frame) {
    energies.push(rms(samples.subarray(start, start + frame)));
  }
  if (energies.length < 3) return 0;
  const sorted = [...energies].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  const threshold = Math.max(floor * 3, 0.005);
  return energies.filter((energy) => energy > threshold).length / energies.length;
}

/** 16-bit PCM WAV, the format the studio's audio element will play. */
export function encodeWav(samples, sampleRate = 24_000) {
  const header = Buffer.alloc(44);
  const bytes = samples.length * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);

  const body = Buffer.alloc(bytes);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    body.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return Buffer.concat([header, body]);
}
