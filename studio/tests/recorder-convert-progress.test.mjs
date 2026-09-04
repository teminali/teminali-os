/* ═══════════════════════════════════════════════════════════════════
   The convert step's progress, proven without an ffmpeg.

   This exists because the failure modes here are all silent ones. A
   misread `out_time_ms` does not throw, it draws a bar that is a
   thousand times too fast; a line split across two pipe reads does not
   throw, it drops a digit and the bar jumps backwards. Neither shows up
   in a screenshot of a working convert.
   ═══════════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  readProgress, convertPercent, aggregatePercent,
} = require("../electron/convertProgress.cjs");

const BLOCK = [
  "bitrate=2100.0kbits/s",
  "total_size=1048576",
  "out_time_us=4000000",
  "out_time_ms=4000000",
  "out_time=00:00:04.000000",
  "speed=12.4x",
  "progress=continue",
  "",
].join("\n");

/* ── reading the pipe ───────────────────────────────────────────── */

test("a whole block reads as one sample", () => {
  const { rest, samples } = readProgress("", BLOCK);
  assert.equal(rest, "");
  assert.equal(samples.length, 1);
  assert.deepEqual(samples[0], {
    outTimeMs: 4000, bytes: 1048576, speed: "12.4x", done: false,
  });
});

test("out_time_ms is microseconds, not milliseconds", () => {
  /* The whole point: ffmpeg's key is misnamed. Four seconds in, a
     reader that trusts the name reports 4,000,000ms — 66 minutes. */
  const [sample] = readProgress("", BLOCK).samples;
  assert.equal(sample.outTimeMs, 4000, "four seconds, not four thousand");
});

test("a line split across two reads is rejoined, not lost", () => {
  const cut = 30;
  const first = readProgress("", BLOCK.slice(0, cut));
  assert.equal(first.samples.length, 0, "no whole block has arrived yet");
  const second = readProgress(first.rest, BLOCK.slice(cut));
  assert.equal(second.samples.length, 1);
  assert.equal(second.samples[0].outTimeMs, 4000, "the number survived the cut");
  assert.equal(second.samples[0].bytes, 1048576);
});

test("every byte boundary in a block gives the same answer", () => {
  for (let cut = 0; cut <= BLOCK.length; cut += 1) {
    const first = readProgress("", BLOCK.slice(0, cut));
    const second = readProgress(first.rest, BLOCK.slice(cut));
    const samples = [...first.samples, ...second.samples];
    assert.equal(samples.length, 1, `cut at ${cut} produced ${samples.length} samples`);
    assert.equal(samples[0].outTimeMs, 4000, `cut at ${cut} lost the time`);
  }
});

test("several blocks in one read come back in order", () => {
  const { samples } = readProgress("", BLOCK + BLOCK.replace("4000000", "8000000"));
  assert.deepEqual(samples.map((s) => s.outTimeMs), [4000, 8000]);
});

test("progress=end marks the last sample done", () => {
  const { samples } = readProgress("", BLOCK.replace("progress=continue", "progress=end"));
  assert.equal(samples[0].done, true);
});

test("N/A values before the first frame are null, not NaN", () => {
  const early = [
    "bitrate=N/A", "total_size=N/A", "out_time_us=N/A", "speed=N/A", "progress=continue", "",
  ].join("\n");
  const [sample] = readProgress("", early).samples;
  assert.equal(sample.outTimeMs, null);
  assert.equal(sample.bytes, null);
  assert.equal(sample.speed, null);
});

test("stray output that is not a key=value line is ignored", () => {
  const { samples } = readProgress("", `a warning about something\n${BLOCK}`);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].outTimeMs, 4000);
});

/* ── turning it into a bar ──────────────────────────────────────── */

test("percent is the converted time over the take's duration", () => {
  assert.equal(convertPercent(30_000, 60_000), 50);
});

test("percent is capped at 99 until the process exits", () => {
  /* `+faststart` rewrites the whole file after the last frame and
     reports nothing while it does. 100% for four seconds reads as hung. */
  assert.equal(convertPercent(60_000, 60_000), 99);
  assert.equal(convertPercent(90_000, 60_000), 99, "a longer file than expected still caps");
});

test("an unknown duration gives no percentage rather than a guess", () => {
  assert.equal(convertPercent(30_000, 0), null);
  assert.equal(convertPercent(30_000, null), null);
  assert.equal(convertPercent(null, 60_000), null);
});

test("two streams share one bar, weighted by time not by count", () => {
  /* Screen is done, camera has not started: half the work, not 50%
     because one of two files finished. */
  assert.equal(aggregatePercent({ screen: 60_000, camera: 0 }, 60_000, 2), 50);
  assert.equal(aggregatePercent({ screen: 30_000, camera: 30_000 }, 60_000, 2), 50);
});

test("the bar never retreats when a copy falls back to a re-encode", () => {
  const reached = aggregatePercent({ screen: 48_000 }, 60_000, 1);
  assert.equal(reached, 80);
  /* The copy failed; the encode restarts its clock at zero. */
  assert.equal(aggregatePercent({ screen: 0 }, 60_000, 1, reached), 80);
  assert.equal(aggregatePercent({ screen: 54_000 }, 60_000, 1, reached), 90);
});
