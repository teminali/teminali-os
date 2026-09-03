/* ═══════════════════════════════════════════════════════════════════
   The two recorder decisions that are worth testing without an app.

   `remuxPlan` decides whether a finished take can be stream-copied into
   MP4. Getting it wrong is not slow, it is broken output — a container
   holding a stream its muxer has no tag for.

   The sealed envelope's whole point is its FAILURE mode: an edited
   sidecar must not decrypt to something plausible. That property is only
   checkable here, because it is pure — the file half supplies the key
   and the disk, and neither is needed to prove the format.
   ═══════════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { canStreamCopy, videoCodecFromFfmpeg } = require("../electron/remuxPlan.cjs");
const { seal, open, subKey, ENVELOPE_MAGIC } = require("../electron/recorderVault.cjs");

const KEY = new Uint8Array(32).fill(7);

/* ── remuxPlan ──────────────────────────────────────────────────── */

test("a take requested as H.264 and written as H.264 is copied", () => {
  assert.equal(canStreamCopy(true, "h264"), true);
  assert.equal(canStreamCopy(true, "AVC1"), true, "codec names are matched case-insensitively");
});

test("a take requested as H.264 but written as VP8 is re-encoded", () => {
  // The bug this exists to stop: isTypeSupported() answering true is a
  // statement of intent, and a machine with no H.264 encoder available
  // to the sandbox writes VP8 while still reporting the mime it was given.
  assert.equal(canStreamCopy(true, "vp8"), false);
  assert.equal(canStreamCopy(true, "vp9"), false);
});

test("an unreadable file is re-encoded rather than guessed at", () => {
  assert.equal(canStreamCopy(true, null), false);
});

test("a take that never asked to be copied is never copied", () => {
  assert.equal(canStreamCopy(false, "h264"), false);
});

test("the codec is read off an ffmpeg stream table, not an exit code", () => {
  const stderr = [
    "Input #0, matroska,webm, from 'screen.webm':",
    "  Duration: N/A, start: 0.000000, bitrate: N/A",
    "  Stream #0:0(eng): Video: h264 (High), yuv420p(progressive), 2880x1800",
    "  Stream #0:1(eng): Audio: opus, 48000 Hz, stereo, fltp",
  ].join("\n");
  assert.equal(videoCodecFromFfmpeg(stderr), "h264");
});

test("the FIRST video stream wins, and audio is never mistaken for it", () => {
  const stderr = [
    "  Stream #0:0: Audio: aac, 48000 Hz",
    "  Stream #0:1: Video: hevc (Main), yuv420p",
    "  Stream #0:2: Video: mjpeg (Baseline)",
  ].join("\n");
  assert.equal(videoCodecFromFfmpeg(stderr), "hevc");
});

test("output with no stream table reads as unknown, not as a codec", () => {
  assert.equal(videoCodecFromFfmpeg("ffmpeg version 7.1\nNo such file or directory"), null);
  assert.equal(videoCodecFromFfmpeg(""), null);
});

/* ── The sealed sidecar ─────────────────────────────────────────── */

test("a sealed sidecar round-trips", () => {
  const plaintext = JSON.stringify({ samples: [{ tMs: 33, x: 0.5, y: 0.5 }] });
  const opened = open(KEY, "take-sidecar", seal(KEY, "take-sidecar", plaintext));
  assert.equal(opened.ok, true);
  assert.equal(opened.plaintext, plaintext);
});

test("an edited sidecar FAILS rather than decrypting to something plausible", () => {
  // The property the whole design rests on. AES-GCM is authenticated, so
  // one flipped byte is a decrypt error and not a believable lie.
  const sealed = seal(KEY, "take-sidecar", '{"samples":[]}');
  const parts = sealed.split(".");
  const body = Buffer.from(parts[4], "base64url");
  body[0] ^= 0x01;
  parts[4] = body.toString("base64url");

  const opened = open(KEY, "take-sidecar", parts.join("."));
  assert.equal(opened.ok, false);
  assert.equal(opened.reason, "tampered");
});

test("a sidecar cannot be opened as another kind of sealed file", () => {
  // Per-purpose sub-keys are what make moving a ciphertext between two
  // sealed files a failure instead of a confusing success.
  const sealed = seal(KEY, "take-sidecar", "secret");
  const opened = open(KEY, "trial-ledger", sealed);
  assert.equal(opened.ok, false);
  assert.equal(opened.reason, "wrong-purpose");
  assert.notDeepEqual(subKey(KEY, "take-sidecar"), subKey(KEY, "trial-ledger"));
});

test("a plain JSON sidecar is reported as not-sealed, not as tampered", () => {
  // `readMaybeSealed` leans on this distinction to keep hand-made and
  // older takes working; conflating the two would refuse them.
  const opened = open(KEY, "take-sidecar", '{"samples":[]}');
  assert.equal(opened.ok, false);
  assert.equal(opened.reason, "not-sealed");
});

test("another machine's key does not open this machine's sidecar", () => {
  const sealed = seal(KEY, "take-sidecar", "secret");
  const opened = open(new Uint8Array(32).fill(9), "take-sidecar", sealed);
  assert.equal(opened.ok, false);
  assert.equal(opened.reason, "tampered");
});

test("a sealed file announces what it is", () => {
  // Text rather than binary, so somebody who finds one can tell it from
  // a corrupt video.
  assert.match(seal(KEY, "take-sidecar", "x"), new RegExp(`^${ENVELOPE_MAGIC}\\.take-sidecar\\.`));
});
