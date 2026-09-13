import test from "node:test";
import assert from "node:assert/strict";
import {
  strength,
  retention,
  halfLifeDays,
  stageOf,
  rehearse,
  consolidate,
  selectForRecall,
  MEMORY_MAX_ATOMS,
  MEMORY_RESERVE,
  FADE_THRESHOLD,
  FORGET_THRESHOLD,
} from "../src/services/voice/temiMemory.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
function atom(over = {}) {
  seq += 1;
  return {
    id: `a${seq}`,
    kind: "fact",
    text: `memory ${seq} with detail`,
    gist: `memory ${seq}`,
    axes: { weight: 0.5, warmth: 0.5, surprise: 0.5, firstness: 0.5 },
    bornAt: NOW,
    lastTouchedAt: NOW,
    rehearsals: 0,
    ...over,
  };
}

const axes = (weight, warmth, surprise, firstness) => ({ weight, warmth, surprise, firstness });

test("one extreme axis beats being moderate on all four", () => {
  const funny = strength(axes(0, 0.9, 0, 0));
  const rounded = strength(axes(0.5, 0.5, 0.5, 0.5));
  assert.ok(funny > rounded, `expected ${funny} > ${rounded}`);
});

test("importance cannot win by merely being present", () => {
  // The brief's actual failure case: a useful fact against a wonderful one.
  const usefulFact = strength(axes(0.7, 0.1, 0.1, 0.1));
  const absurdMoment = strength(axes(0.05, 0.9, 0.8, 0.2));
  assert.ok(absurdMoment > usefulFact, `${absurdMoment} should beat ${usefulFact}`);
});

test("a high-importance memory still wins when importance really is the peak", () => {
  // The policy must not be anti-importance, only refuse to rank on it alone.
  const deadline = strength(axes(0.95, 0.1, 0.1, 0.1));
  const mildlyAmusing = strength(axes(0.1, 0.4, 0.2, 0.1));
  assert.ok(deadline > mildlyAmusing);
});

test("strength stays inside 0..1 at both extremes", () => {
  assert.equal(strength(axes(0, 0, 0, 0)), 0);
  assert.equal(strength(axes(1, 1, 1, 1)), 1);
});

test("a keepsake outlives a fact that was never brought back up", () => {
  const shared = axes(0.5, 0.5, 0.5, 0.5);
  const fact = atom({ kind: "fact", axes: shared });
  const keepsake = atom({ kind: "keepsake", axes: shared });
  const oneYear = NOW + 365 * DAY;
  assert.ok(retention(keepsake, oneYear) > retention(fact, oneYear));
});

test("rehearsal extends the half-life super-linearly", () => {
  const once = halfLifeDays(atom({ rehearsals: 0 }));
  const thrice = halfLifeDays(atom({ rehearsals: 3 }));
  assert.ok(thrice / once > 5, `expected >5x, got ${(thrice / once).toFixed(2)}x`);
});

test("an anchor does not decay", () => {
  const anchor = atom({ kind: "anchor" });
  const decades = NOW + 3650 * DAY;
  assert.equal(retention(anchor, decades), strength(anchor.axes));
  assert.equal(stageOf(anchor, decades), "fresh");
});

test("stages follow the thresholds", () => {
  const a = atom({ kind: "fact", axes: axes(0.8, 0, 0, 0) });
  assert.equal(stageOf(a, NOW), "fresh");
  const findStage = (want) => {
    for (let d = 0; d < 4000; d += 1) {
      if (stageOf(a, NOW + d * DAY) === want) return NOW + d * DAY;
    }
    return null;
  };
  const fadedAt = findStage("faded");
  const goneAt = findStage("gone");
  assert.ok(fadedAt && goneAt && fadedAt < goneAt, "must fade before it is forgotten");
  assert.ok(retention(a, fadedAt) < FADE_THRESHOLD);
  assert.ok(retention(a, goneAt) < FORGET_THRESHOLD);
});

test("fading rewrites the text to the gist and says so", () => {
  const a = atom({ kind: "fact", axes: axes(0.8, 0, 0, 0), gist: "the short version" });
  let when = NOW;
  for (let d = 0; d < 4000; d += 1) {
    if (stageOf(a, NOW + d * DAY) === "faded") { when = NOW + d * DAY; break; }
  }
  const { kept } = consolidate([a], when);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, "the short version");
  assert.equal(kept[0].faded, true);
});

test("an atom with no gist keeps its detail rather than being truncated", () => {
  const a = atom({ kind: "fact", axes: axes(0.8, 0, 0, 0), gist: undefined });
  let when = NOW;
  for (let d = 0; d < 4000; d += 1) {
    if (stageOf(a, NOW + d * DAY) === "faded") { when = NOW + d * DAY; break; }
  }
  const { kept, faded } = consolidate([a], when);
  assert.equal(faded.length, 0);
  assert.equal(kept[0].text, a.text);
});

test("rehearsing takes the higher reading on every axis and restores the detail", () => {
  const a = atom({ axes: axes(0.2, 0.9, 0.1, 0.1), faded: true, text: "short" });
  const back = rehearse(a, { text: "the whole thing again", axes: axes(0.6, 0.3, 0.5, 0.0) }, NOW + DAY);
  assert.equal(back.rehearsals, 1);
  assert.equal(back.faded, false);
  assert.equal(back.text, "the whole thing again");
  assert.deepEqual(back.axes, axes(0.6, 0.9, 0.5, 0.1));
  assert.equal(back.lastTouchedAt, NOW + DAY);
});

test("consolidate is idempotent for a fixed clock", () => {
  const store = [atom(), atom({ kind: "keepsake" }), atom({ kind: "anchor" })];
  const once = consolidate(store, NOW).kept;
  const twice = consolidate(once, NOW).kept;
  assert.deepEqual(twice, once);
});

test("the store never exceeds its cap", () => {
  const many = Array.from({ length: MEMORY_MAX_ATOMS * 3 }, () => atom({ axes: axes(0.9, 0, 0, 0) }));
  const { kept } = consolidate(many, NOW);
  assert.ok(kept.length <= MEMORY_MAX_ATOMS, `kept ${kept.length}`);
});

test("a flood of urgent facts cannot evict a single keepsake", () => {
  const flood = Array.from({ length: MEMORY_MAX_ATOMS * 2 }, () => atom({ kind: "fact", axes: axes(0.95, 0, 0, 0) }));
  const keepsakes = Array.from({ length: 12 }, () => atom({ kind: "keepsake", axes: axes(0, 0.85, 0.4, 0) }));
  const { kept } = consolidate([...flood, ...keepsakes], NOW);
  const survivors = kept.filter((a) => a.kind === "keepsake");
  assert.equal(survivors.length, 12, "every keepsake must survive the flood");
});

test("the reserve is load-bearing, not decoration", () => {
  /* The claim D2 actually makes is that the reserve saves memories that pure
     retention ranking would have evicted. Proving it needs a keepsake that
     genuinely LOSES on score: old and weak, against a wall of fresh urgent
     facts. If it survives anyway, the reserve did it, because nothing else
     could have. */
  const flood = Array.from({ length: MEMORY_MAX_ATOMS * 2 }, () => atom({ kind: "fact", axes: axes(0.95, 0, 0, 0) }));
  const weakOldKeepsake = atom({
    kind: "keepsake",
    axes: axes(0, 0.6, 0.2, 0),
    lastTouchedAt: NOW - 200 * DAY,
  });
  // Alive, but only just: it has to clear the forget floor on its own, because
  // the reserve guards against COMPETITION and not against decay. A keepsake
  // that has genuinely faded past the floor is gone like anything else, and an
  // earlier version of this test picked one at 0.115 and proved that instead.
  assert.ok(retention(weakOldKeepsake, NOW) > FORGET_THRESHOLD);
  const all = [...flood, weakOldKeepsake];
  const { kept } = consolidate(all, NOW);

  assert.ok(kept.some((a) => a.id === weakOldKeepsake.id), "the reserve must have saved it");

  const evictedFacts = flood.filter((f) => !kept.some((k) => k.id === f.id));
  assert.ok(evictedFacts.length > 0, "facts must actually have been evicted");
  assert.ok(
    retention(evictedFacts[0], NOW) > retention(weakOldKeepsake, NOW),
    "and it must have been outscored by something that was evicted anyway",
  );
});

test("anchors are held against capacity too, but capped", () => {
  const anchors = Array.from({ length: MEMORY_RESERVE.anchor * 3 }, () => atom({ kind: "anchor", axes: axes(0.6, 0.6, 0, 0) }));
  const { kept } = consolidate(anchors, NOW);
  assert.ok(kept.length <= MEMORY_MAX_ATOMS);
  assert.ok(kept.every((a) => a.kind === "anchor"));
});

test("recall always carries every anchor", () => {
  const store = [
    atom({ kind: "anchor", text: "he lives in Arusha" }),
    atom({ kind: "anchor", text: "he builds Teminali OS" }),
    ...Array.from({ length: 60 }, () => atom({ kind: "fact" })),
  ];
  const picked = selectForRecall(store, NOW, { random: () => 0.5 });
  assert.equal(picked.filter((a) => a.kind === "anchor").length, 2);
});

test("recall is a mix, not a pile of whichever kind scores highest", () => {
  const store = [
    ...Array.from({ length: 40 }, () => atom({ kind: "fact", axes: axes(0.6, 0, 0, 0) })),
    ...Array.from({ length: 40 }, () => atom({ kind: "keepsake", axes: axes(0, 0.95, 0.8, 0) })),
  ];
  const picked = selectForRecall(store, NOW, { random: () => 0.5 });
  const facts = picked.filter((a) => a.kind === "fact").length;
  const keepsakes = picked.filter((a) => a.kind === "keepsake").length;
  assert.ok(facts > 0, "she must still know the useful things");
  assert.ok(keepsakes > 0, "and still hold the fond ones");
  assert.ok(keepsakes <= facts + 4, `recall skewed to keepsakes: ${keepsakes} vs ${facts}`);
});

test("recall respects the character budget", () => {
  const store = Array.from({ length: 200 }, () => atom({ kind: "fact" }));
  const picked = selectForRecall(store, NOW, { budgetChars: 120, random: () => 0.5 });
  const spent = picked.reduce((s, a) => s + a.text.length + 1, 0);
  assert.ok(spent <= 120, `spent ${spent}`);
});

test("the wander slot is deterministic under an injected clock and rng", () => {
  const store = [
    atom({ kind: "anchor" }),
    ...Array.from({ length: 30 }, () => atom({ kind: "keepsake", axes: axes(0, 0.8, 0.3, 0) })),
  ];
  const a = selectForRecall(store, NOW, { random: () => 0.77 });
  const b = selectForRecall(store, NOW, { random: () => 0.77 });
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
});

test("an empty store recalls nothing and does not throw", () => {
  assert.deepEqual(selectForRecall([], NOW, { random: () => 0.5 }), []);
  assert.deepEqual(consolidate([], NOW), { kept: [], faded: [], forgotten: [] });
});

/* The latency contract. These are not benchmarks, they are regression guards:
   the bounds are ~25x the measured cost so a loaded machine cannot flake them,
   while an accidental O(n^2) or a retention() call moved inside a hot loop
   still trips them. Measured on Node v26.4.0 at a full store: selection
   0.18 ms, consolidation 0.016 ms at cap and 1.44 ms through the capacity
   branch. */
test("recall is cheap enough to sit on the session-start path", () => {
  const store = Array.from({ length: MEMORY_MAX_ATOMS }, (_, i) =>
    atom({ kind: ["anchor", "fact", "keepsake", "thread"][i % 4], lastTouchedAt: NOW - (i % 300) * DAY }));
  for (let i = 0; i < 50; i += 1) selectForRecall(store, NOW, { random: () => 0.5 });
  const t0 = performance.now();
  for (let i = 0; i < 200; i += 1) selectForRecall(store, NOW, { random: () => 0.5 });
  const per = (performance.now() - t0) / 200;
  assert.ok(per < 5, `selectForRecall took ${per.toFixed(3)} ms, budget 5 ms`);
});

test("consolidation stays cheap even far over cap", () => {
  const store = Array.from({ length: MEMORY_MAX_ATOMS * 3 }, (_, i) =>
    atom({ kind: ["anchor", "fact", "keepsake", "thread"][i % 4], lastTouchedAt: NOW - (i % 300) * DAY }));
  for (let i = 0; i < 20; i += 1) consolidate(store, NOW);
  const t0 = performance.now();
  for (let i = 0; i < 100; i += 1) consolidate(store, NOW);
  const per = (performance.now() - t0) / 100;
  assert.ok(per < 40, `consolidate took ${per.toFixed(3)} ms, budget 40 ms`);
});

test("the recall block stays inside its token budget", () => {
  /* The only cost the model ever sees. The persona is ~4,600 tokens; this must
     stay a rounding error on it, and it is processed once at session setup
     rather than per turn. */
  const store = Array.from({ length: MEMORY_MAX_ATOMS }, (_, i) =>
    atom({ kind: ["anchor", "fact", "keepsake", "thread"][i % 4] }));
  const block = selectForRecall(store, NOW, { random: () => 0.5 }).map((a) => a.text).join("\n");
  assert.ok(block.length <= 1400, `${block.length} chars`);
  assert.ok(Math.ceil(block.length / 4) < 400, "under 400 tokens");
});
