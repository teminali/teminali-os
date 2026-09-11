/**
 * Which sources an export may decode in order.
 *
 * The export loop walks frames forward, so almost every source can be pulled
 * sequentially instead of seeked — worth ~90x on the decode, measured in
 * DESIGN.md §3, "Export throughput: the seek is the render". The interesting
 * cases are the ones that must NOT take that path, because each produces a
 * silently wrong picture rather than an error: a reversed clip reads its
 * source backwards, and two clips of one file on screen together need two
 * different frames from a decoder that publishes one per URL.
 *
 * The fallback is per SOURCE. One reversed clip must not cost the rest of the
 * timeline its fast path, which is the assertion most likely to regress.
 *
 * The planner takes a `demandsAt` function rather than a timeline, so these
 * run with no DOM, no decoder and no media — the demands are written out
 * directly, which is also the only way to state a non-monotonic case without
 * building a timeline that produces one by accident.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  planSequentialDecode,
  describePlans,
  sequentialUrls,
} from "../src/video/engine/sequentialPlan.ts";

/** A source that advances one frame-interval per output frame, from zero. */
const forward = (url) => (ms) => [{ url, seconds: ms / 1000 }];

/** 10 frames at 100ms, starting at 0 — the shape every case below uses. */
const plan = (demandsAt) => planSequentialDecode(demandsAt, 0, 10, 100);

test("a plain forward source is decoded in order", () => {
  const plans = plan(forward("a.mp4"));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].mode, "sequential");
  assert.equal(plans[0].url, "a.mp4");
  assert.equal(plans[0].demands.length, 10);
  assert.deepEqual(plans[0].demands[0], { frame: 0, seconds: 0 });
  assert.ok(plans[0].demands.every((d, i, all) => i === 0 || d.seconds >= all[i - 1].seconds));
});

test("a reversed source falls back to the seek path", () => {
  const plans = plan((ms) => [{ url: "a.mp4", seconds: (1000 - ms) / 1000, reversed: true }]);
  assert.equal(plans[0].mode, "seek");
  assert.match(plans[0].reason, /reversed/);
});

test("a source demanded twice in one frame falls back", () => {
  /* Two clips of one file on screen together. The decoder publishes one
     frame per URL, so it cannot serve both — and the seek path's answer
     (last write wins) must not be reproduced silently. */
  const plans = plan((ms) => [
    { url: "a.mp4", seconds: ms / 1000 },
    { url: "a.mp4", seconds: 5 + ms / 1000 },
  ]);
  assert.equal(plans[0].mode, "seek");
  assert.match(plans[0].reason, /visible at once/);
});

test("repeating one source time is monotonic, not a regression", () => {
  // A slowed clip asks twice; the decoder answers from the frame it holds.
  const plans = plan(() => [{ url: "a.mp4", seconds: 0 }]);
  assert.equal(plans[0].mode, "sequential");
  assert.equal(plans[0].demands.length, 10);
});

test("a source that steps backwards once falls back, and says where", () => {
  /* Nothing reversed and nothing doubled — only the monotonic check catches
     this. A split reassembled out of order looks exactly like it. */
  const plans = plan((ms) => [{ url: "a.mp4", seconds: ms >= 500 ? (ms - 500) / 1000 : ms / 1000 }]);
  assert.equal(plans[0].mode, "seek");
  assert.match(plans[0].reason, /backwards at output frame 5/);
});

test("one bad source does not cost the others their fast path", () => {
  const plans = plan((ms) => [
    { url: "good.mp4", seconds: ms / 1000 },
    { url: "bad.mp4", seconds: (1000 - ms) / 1000, reversed: true },
  ]);
  assert.equal(plans.find((p) => p.url === "good.mp4").mode, "sequential");
  assert.equal(plans.find((p) => p.url === "bad.mp4").mode, "seek");
  assert.deepEqual([...sequentialUrls(plans)], ["good.mp4"]);
});

test("a gap in a source's demands is not a regression", () => {
  // A clip that leaves the screen and returns later still only moves forward.
  const plans = plan((ms) => (ms < 300 || ms >= 700 ? [{ url: "a.mp4", seconds: ms / 1000 }] : []));
  assert.equal(plans[0].mode, "sequential");
  assert.deepEqual(plans[0].demands.map((d) => d.frame), [0, 1, 2, 7, 8, 9]);
});

test("a non-finite demand is skipped rather than planned", () => {
  const plans = plan((ms) => [{ url: "a.mp4", seconds: ms === 300 ? NaN : ms / 1000 }]);
  assert.equal(plans[0].mode, "sequential");
  assert.equal(plans[0].demands.length, 9);
});

test("an empty timeline plans nothing", () => {
  assert.deepEqual(plan(() => []), []);
});

test("describePlans says how much of the timeline took the fast path", () => {
  assert.equal(describePlans([]), "no video sources");
  assert.match(describePlans(plan(forward("a.mp4"))), /^1\/1 sources decoded in order$/);
  const mixed = describePlans(plan((ms) => [
    { url: "good.mp4", seconds: ms / 1000 },
    { url: "bad.mp4", seconds: 0, reversed: true },
  ]));
  assert.match(mixed, /^1\/2 sources decoded in order — a clip of this source is reversed$/);
});
