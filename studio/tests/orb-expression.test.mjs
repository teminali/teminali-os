import assert from "node:assert/strict";
import test from "node:test";
import { auraFor, breathFor, eyeScaleFor, mouthFor, MOUTH_ATTENTIVE, MOUTH_REST } from "../src/utils/orbExpression.ts";

/**
 * The operator, watching the assistant while they talked to it: "how can his
 * mouth move and I'm the one talking?" The orb has one level prop for both
 * voices and the state says whose it is. What is pinned here is that only
 * Temy's own voice can reach the mouth, and that the operator's voice shows
 * somewhere that is not the face.
 */

test("the microphone never reaches the mouth", () => {
  for (const state of ["hearing", "listening", "idle", "deciding", "thinking", "sending", "repairing", "review"]) {
    assert.deepEqual(mouthFor(state, 1), mouthFor(state, 0), `${state}: the mouth moved with the level`);
  }
  assert.deepEqual(mouthFor("hearing", 0.9), MOUTH_ATTENTIVE);
  assert.deepEqual(mouthFor("idle", 0.9), MOUTH_REST);
});

test("only Temy's own voice opens the mouth, and silence closes it", () => {
  const quiet = mouthFor("speaking", 0.01, 3);
  const loud = mouthFor("speaking", 0.9, 3);
  assert.ok(loud.height > quiet.height, "a loud vowel opens wider than silence");
  assert.ok(quiet.height < MOUTH_REST.height, "between clauses the mouth is closed, not flapping");
  // The shape is centred on the face whatever it does.
  assert.ok(Math.abs(loud.x + loud.width / 2 - 64) < 0.01);
});

test("the operator's voice shows in the aura, not the face", () => {
  const soft = auraFor("hearing", { heard: 0 });
  const loud = auraFor("hearing", { heard: 1 });
  assert.ok(loud.opacity > soft.opacity && loud.scale > soft.scale);
  // And Temy's own level is ignored while hearing, as the operator's is while speaking.
  assert.deepEqual(auraFor("hearing", { heard: 0.5, own: 1 }), auraFor("hearing", { heard: 0.5, own: 0 }));
  assert.deepEqual(auraFor("speaking", { own: 0.5, heard: 1 }), auraFor("speaking", { own: 0.5, heard: 0 }));
});

test("attention is wide eyes and a shallow breath, not a twitch", () => {
  assert.equal(eyeScaleFor("hearing", 0), eyeScaleFor("hearing", 1));
  assert.ok(eyeScaleFor("hearing", 0) > eyeScaleFor("idle", 0));
  assert.equal(breathFor("hearing"), "attend");
  assert.equal(breathFor("idle"), "breathe");
  assert.equal(breathFor("speaking"), "none");
  assert.equal(breathFor("thinking"), "none");
});
