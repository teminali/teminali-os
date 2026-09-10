/*
  What the video editor is allowed to spend while somebody is working in it.

  Companion to `recorder-preview-cost.test.mjs`, which covers the frame
  budget. This one covers the two costs that are paid per INTERACTION
  rather than per frame: a drag, and the audio graph behind the playhead.

  The drag numbers were taken in the production build over CDP, by
  dispatching forty `pointermove` events inside a single tick onto a real
  clip and reading the clip's own geometry back:

      during that tick   left unchanged   (0 store writes)
      one frame later    left = 120px     (1 store write, latest position)
      after release      left = 120px     (committed)

  Before the change each of those forty events was a `moveClips` call —
  forty zustand writes through immer, forty new `tracks` arrays, forty
  `Timeline` re-renders, and on a long timeline forty x N `ClipBlock`
  reconciliations plus forty forced canvas repaints, to draw one frame.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts) => readFileSync(join(here, "..", "src", ...parts), "utf8");

/* ── Dragging ───────────────────────────────────────────────────── */

test("every timeline drag writes to the store once per frame, not once per event", () => {
  const block = src("video", "components", "timeline", "ClipBlock.tsx");

  /* Three drags — move, trim, fade — and all three used to call a store
     action straight out of the pointermove listener. */
  const coalescers = block.match(/if \(frame === 0\) frame = requestAnimationFrame\(flush\);/g) ?? [];
  assert.equal(coalescers.length, 3, "all three drags must coalesce: move, trim, fade");

  /* Coalescing, not throttling: the frame that lands uses the newest
     position, so the clip never trails the cursor. */
  assert.match(block, /const flush = \(\) => \{\s*frame = 0;\s*const ev = pending;\s*pending = null;\s*if \(ev\) apply\(ev\);/);

  /* And the last position must land before the transaction closes, or a
     release between two frames commits a stale position. */
  const flushOnFinish = block.match(/if \(pending[^)]*\) \{ apply\(pending\); pending = null; \}/g) ?? [];
  assert.equal(flushOnFinish.length, 3, "each drag must flush its pending move before committing");
});

test("a clip that did not change does not re-render", () => {
  const block = src("video", "components", "timeline", "ClipBlock.tsx");
  assert.match(block, /export const ClipBlock = React\.memo\(ClipBlockImpl/);
  /* Immer's structural sharing is what makes this work: an untouched
     clip keeps its identity across the write that moved its neighbour. */
  assert.match(block, /a\.clip === b\.clip/);
  /* `track` by field, not by identity — a track object is rebuilt
     whenever ANY clip on it changes, so comparing by reference would
     re-render every sibling of the clip being dragged. */
  assert.doesNotMatch(block, /a\.track === b\.track/);
  for (const field of ["id", "index", "type", "locked", "muted", "solo", "heightPx"]) {
    assert.match(block, new RegExp(`a\\.track\\.${field} === b\\.track\\.${field}`),
      `the memo comparator must cover track.${field}, which the component reads`);
  }
});

test("selection is a bit, not the whole selection array", () => {
  const block = src("video", "components", "timeline", "ClipBlock.tsx");
  /* `selectedClipIds` is a new array on every selection change, so
     subscribing to it re-rendered every clip on the timeline whenever
     any one of them was clicked. */
  assert.match(block, /useTimelineStore\(\(s\) => s\.selectedClipIds\.includes\(clip\.id\)\)/);
  assert.doesNotMatch(block, /useTimelineStore\(\(s\) => s\.selectedClipIds\)/);
});

/* ── The audio graph ────────────────────────────────────────────── */

/*
  Reimplemented rather than imported, for the same reason as
  `shouldScrubSeek`: `audioEngine.ts` builds a Web Audio graph at load.
  The constant and both guards are pinned against the source below.
*/
const PARK_TOLERANCE_S = 1 / 60;
function shouldParkSeek({ currentTime, requestedTime, target, seeking }) {
  if (seeking) return false;
  if (!Number.isFinite(target)) return false;
  if (Math.abs(currentTime - target) <= PARK_TOLERANCE_S) return false;
  if (requestedTime !== null && Math.abs(requestedTime - target) < PARK_TOLERANCE_S) return false;
  return true;
}

test("a parked audio element is asked once per position, not once per frame", () => {
  /*
    The audio twin of the video seek storm. A compressed stream seeks to
    a packet boundary, so an element told to go to 4.100 may answer 4.180
    and stay "wrong" for ever — re-seeked sixty times a second,
    permanently `seeking`, audible as a clip that will not scrub.
  */
  assert.equal(shouldParkSeek({ currentTime: 0, requestedTime: null, target: 4.1, seeking: false }), true);
  assert.equal(shouldParkSeek({ currentTime: 4.18, requestedTime: 4.1, target: 4.1, seeking: false }), false);
  assert.equal(shouldParkSeek({ currentTime: 4.18, requestedTime: 4.1, target: 9.2, seeking: false }), true);
  assert.equal(shouldParkSeek({ currentTime: 0, requestedTime: null, target: 4.1, seeking: true }), false);

  const engine = src("video", "engine", "audioEngine.ts");
  assert.match(engine, /const PARK_TOLERANCE_S = 1 \/ 60;/);
  assert.match(engine, /export function shouldParkSeek/);
  /* 50ms was the old tolerance, and a tolerance alone cannot fix this. */
  assert.doesNotMatch(engine, /voice\.el\.currentTime - sourceSeconds\) > 0\.05/);
});

test("the audio graph does not schedule automation to hold still", () => {
  const engine = src("video", "engine", "audioEngine.ts");
  /* `setTargetAtTime` schedules an event every call and `sync` runs every
     frame, so a voice at a constant level was scheduling sixty events a
     second to change nothing — and every voice NOT under the playhead was
     scheduling sixty more to stay at zero. */
  assert.match(engine, /if \(Math\.abs\(gain - voice\.lastGain\) > GAIN_EPSILON\)/);
  assert.match(engine, /if \(voice\.lastGain > GAIN_EPSILON\)/);
});

test("audio voices are released, not merely paused", () => {
  const engine = src("video", "engine", "audioEngine.ts");
  /*
    A voice is an <audio> element, a MediaElementAudioSourceNode and a
    whole per-clip filter chain. `sync` paused the ones that fell out from
    under the playhead and left every one resident for the life of the
    page, so scrubbing a hundred-clip timeline left a hundred decoders
    alive. The video engine had exactly this bug.
  */
  assert.match(engine, /const VOICE_SOFT_LIMIT = 8;/);
  assert.match(engine, /this\.voices\.size > VOICE_SOFT_LIMIT && now - voice\.lastUsedAt > VOICE_IDLE_EVICT_MS/);
  assert.match(engine, /this\.release\(clipId\);/);
});
