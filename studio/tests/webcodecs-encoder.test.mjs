/**
 * Choosing what the renderer will pipe to ffmpeg.
 *
 * Tier 2 encodes H.264/HEVC in the renderer and lets ffmpeg stream-copy it
 * (DESIGN.md §3). The decision to do that has to fail safe: anything this
 * build cannot encode must fall back to the JPEG path rather than start an
 * export that dies partway, and ProRes must never take it at all.
 *
 * These run under plain Node, where `VideoEncoder` does not exist — which is
 * exactly the browser-build case the fallback is for, so the absence is the
 * fixture rather than a limitation of the test.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  avcCodecString,
  hevcCodecString,
  pickFrameFormat,
} from "../src/video/engine/webcodecsEncoder.ts";

test("the AVC level carries the frame size, rather than being guessed", () => {
  // Naming a level below the frame size is a rejected config, not lower quality.
  /* Thresholds are MaxFS from H.264 Table A-1, in macroblocks. Reaching for
     them from memory put 4K behind level 5.0's limit of 22080. */
  assert.equal(avcCodecString(1920, 1080), "avc1.640028", "8160 MB fits 4.0's 8192");
  assert.equal(avcCodecString(1280, 720), "avc1.640028");
  assert.equal(avcCodecString(2560, 1440), "avc1.640032", "14400 MB needs 5.0");
  assert.equal(avcCodecString(3840, 2160), "avc1.640034", "32400 MB exceeds 5.0's 22080");
  assert.equal(avcCodecString(7680, 4320), "avc1.64003E", "129600 MB needs 6.2");
});

test("a portrait frame is levelled by area, not by height", () => {
  // 1080x1920 is the same macroblock count as 1920x1080 and must level the same.
  assert.equal(avcCodecString(1080, 1920), avcCodecString(1920, 1080));
});

test("the HEVC string names a profile and level both encoders accept", () => {
  assert.match(hevcCodecString(), /^hev1\.1\.6\.L\d+\.90$/);
});

test("ProRes never takes the renderer path", async () => {
  /* WebCodecs has no ProRes encoder, and ProRes exists in this product for
     people who explicitly do not want an inter-frame format. */
  const picked = await pickFrameFormat("prores", 1920, 1080, 12_000_000);
  assert.equal(picked.format, "jpeg");
  assert.equal(picked.config, null);
});

test("no VideoEncoder means the JPEG path, not a crash", async () => {
  assert.equal(typeof VideoEncoder, "undefined", "this test's premise");
  for (const codec of ["h264", "hevc"]) {
    const picked = await pickFrameFormat(codec, 1920, 1080, 12_000_000);
    assert.equal(picked.format, "jpeg", `${codec} must fall back where it cannot encode`);
    assert.equal(picked.config, null);
  }
});
