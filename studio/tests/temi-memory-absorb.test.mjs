import test from "node:test";
import assert from "node:assert/strict";
import {
  absorb,
  sameMemory,
  retention,
  MEMORY_MATCH_MIN_SHARED,
} from "../src/services/voice/temiMemory.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
const ids = () => `id-${(seq += 1)}`;
const resetIds = () => {
  seq = 0;
};

const axes = (over = {}) => ({ weight: 0.2, warmth: 0.2, surprise: 0.2, firstness: 0.2, ...over });

const atom = (over = {}) => ({
  id: over.id ?? ids(),
  kind: "fact",
  text: "placeholder",
  axes: axes(),
  bornAt: NOW - DAY,
  lastTouchedAt: NOW - DAY,
  rehearsals: 0,
  ...over,
});

test("the same memory told again with more of it is still the same memory", () => {
  assert.equal(
    sameMemory(
      "He is dreading the Thursday demo",
      "He is dreading the Thursday demo because the gateway keeps dying",
    ),
    true,
  );
});

test("two facts about his sister that cannot both be true do not merge", () => {
  // The pair that matters: one content word apart, opposite meanings. If this
  // ever matches, rehearsal silently overwrites the true memory with the false
  // one and extends its half-life for doing so.
  assert.equal(sameMemory("His sister is a nurse", "His sister is a doctor"), false);
});

test("one shared content word is never enough, whatever the ratio", () => {
  assert.equal(MEMORY_MATCH_MIN_SHARED, 2);
  assert.equal(sameMemory("He was tired", "He was tired of the build failing on Tuesday"), false);
  assert.equal(sameMemory("Mangoes", "Mangoes"), false);
});

test("a sentence of nothing but stop words matches nothing, including itself", () => {
  assert.equal(sameMemory("he is the one", "he is the one"), false);
});

test("a new candidate is born now, with no history it did not earn", () => {
  resetIds();
  const result = absorb([], [{ kind: "keepsake", text: "He named the build machine after his aunt", axes: axes({ warmth: 0.9 }) }], NOW, ids);
  assert.equal(result.laid.length, 1);
  assert.equal(result.rehearsed.length, 0);
  const born = result.atoms[0];
  assert.equal(born.bornAt, NOW);
  assert.equal(born.lastTouchedAt, NOW);
  assert.equal(born.rehearsals, 0);
  assert.equal(born.id, "id-1");
});

test("saying it again rehearses rather than duplicating, and takes the higher score", () => {
  const existing = [atom({ kind: "keepsake", text: "He named the build machine after his aunt", axes: axes({ warmth: 0.4 }), faded: true })];
  const result = absorb(
    existing,
    [{ kind: "keepsake", text: "He named the build machine after his aunt Rose", axes: axes({ warmth: 0.9 }) }],
    NOW,
    ids,
  );
  assert.equal(result.atoms.length, 1);
  assert.equal(result.laid.length, 0);
  assert.equal(result.rehearsed.length, 1);
  const brought = result.atoms[0];
  assert.equal(brought.rehearsals, 1);
  assert.equal(brought.axes.warmth, 0.9);
  assert.equal(brought.lastTouchedAt, NOW);
  // A blurred memory recalled with more detail comes back whole.
  assert.equal(brought.faded, false);
});

test("a memory of a different kind is a different memory, whatever the words", () => {
  const existing = [atom({ kind: "fact", text: "He works from the balcony every morning" })];
  const result = absorb(
    existing,
    [{ kind: "keepsake", text: "He works from the balcony every morning", axes: axes() }],
    NOW,
    ids,
  );
  assert.equal(result.atoms.length, 2);
  assert.equal(result.laid.length, 1);
});

test("a newer answer to the same question displaces the anchor, and is born rather than inherited", () => {
  const existing = [atom({ kind: "anchor", text: "He lives in Arusha", subject: "home", rehearsals: 4 })];
  const result = absorb(
    existing,
    [{ kind: "anchor", text: "He moved to Dodoma", subject: "home", axes: axes({ weight: 0.8 }) }],
    NOW,
    ids,
  );
  assert.equal(result.atoms.length, 1);
  assert.equal(result.superseded.length, 1);
  assert.equal(result.superseded[0].text, "He lives in Arusha");
  assert.equal(result.atoms[0].text, "He moved to Dodoma");
  // Not the fifth telling of the old anchor. The thing that made it false.
  assert.equal(result.atoms[0].rehearsals, 0);
});

test("two anchors about two different people do not displace each other", () => {
  const existing = [atom({ kind: "anchor", text: "His mother is called Rose", subject: "person:mama" })];
  const result = absorb(
    existing,
    [{ kind: "anchor", text: "His brother is called Yohana", subject: "person:brother", axes: axes() }],
    NOW,
    ids,
  );
  assert.equal(result.atoms.length, 2);
  assert.equal(result.superseded.length, 0);
});

test("repeating an anchor rehearses it instead of superseding it with a copy of itself", () => {
  // Supersession tested before rehearsal would reset the rehearsal count of
  // exactly the memories decision 3 is meant to make permanent.
  const existing = [atom({ kind: "anchor", text: "He lives in Arusha", subject: "home", rehearsals: 4 })];
  const result = absorb(
    existing,
    [{ kind: "anchor", text: "He still lives in Arusha", subject: "home", axes: axes() }],
    NOW,
    ids,
  );
  assert.equal(result.atoms.length, 1);
  assert.equal(result.superseded.length, 0);
  assert.equal(result.rehearsed.length, 1);
  assert.equal(result.atoms[0].rehearsals, 5);
});

test("only anchors carry a subject, because only anchors supersede", () => {
  const result = absorb(
    [],
    [{ kind: "fact", text: "His deadline is the Friday after next", axes: axes(), subject: "home" }],
    NOW,
    ids,
  );
  assert.equal(result.atoms[0].subject, undefined);
});

test("a candidate can rehearse one the same pass just laid down", () => {
  const result = absorb(
    [],
    [
      { kind: "thread", text: "He is rewriting the gateway router this week", axes: axes() },
      { kind: "thread", text: "He is rewriting the gateway router again", axes: axes({ warmth: 0.7 }) },
    ],
    NOW,
    ids,
  );
  assert.equal(result.atoms.length, 1);
  assert.equal(result.laid.length, 1);
  assert.equal(result.rehearsed.length, 1);
  assert.equal(result.atoms[0].rehearsals, 1);
});

test("a candidate with no words is not a memory", () => {
  const result = absorb([], [{ kind: "fact", text: "   ", axes: axes() }], NOW, ids);
  assert.equal(result.atoms.length, 0);
});

test("absorbing does not mutate the store it was given", () => {
  const existing = [atom({ kind: "fact", text: "He drinks his coffee black and bitter" })];
  const before = JSON.stringify(existing);
  absorb(existing, [{ kind: "fact", text: "He drinks his coffee black", axes: axes({ weight: 0.9 }) }], NOW, ids);
  assert.equal(JSON.stringify(existing), before);
});

test("rehearsal actually buys the memory time, which is the point of counting it", () => {
  const once = atom({ kind: "thread", text: "He is worried about the demo", axes: axes({ warmth: 0.8 }), lastTouchedAt: NOW });
  const { atoms } = absorb([once], [{ kind: "thread", text: "He is worried about the demo again", axes: axes({ warmth: 0.8 }) }], NOW, ids);
  const later = NOW + 60 * DAY;
  assert.ok(retention(atoms[0], later) > retention(once, later));
});
