/**
 * The third tier: what she knows about him becomes part of who she is on the call.
 *
 * `temiMemory.ts` decides what survives, `temiMemoryStore.ts` holds it resident,
 * and this is the hop that reaches the model. It is one string function, which is
 * the whole of the latency contract in DESIGN.md 6.48: Gemini Live fixes the
 * system instruction at setup, so the block is composed once while the socket is
 * being opened and there is no code left to run on a turn.
 *
 * What is pinned here is mostly what must NOT happen. A woman with no memories
 * must get the prompt that was measured at 87%, byte for byte, rather than an
 * empty heading telling her to remember things. A store that grows must not grow
 * the system instruction without bound. And an anchor must not arrive looking
 * like a keepsake, because the one is the ground she stands on and the other is
 * only worth keeping because it was funny.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  TEMI_PERSONA,
  buildTemiPersona,
  buildRecallBlock,
  RECALL_BLOCK_HEADING,
  RECALL_INSERT_BEFORE,
  RECALL_BLOCK_BUDGET_CHARS,
} from "../src/services/voice/temiPersona.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** Deterministic: `selectForRecall`'s wander is the only randomness in the tier. */
const FIXED = { random: () => 0.4 };

let seq = 0;
function atom(over = {}) {
  seq += 1;
  return {
    id: `a${String(seq).padStart(3, "0")}`,
    kind: "fact",
    text: `memory ${seq} with enough detail to read like a sentence`,
    gist: `memory ${seq}`,
    axes: { weight: 0.5, warmth: 0.5, surprise: 0.5, firstness: 0.5 },
    bornAt: NOW - 30 * DAY,
    lastTouchedAt: NOW - 30 * DAY,
    rehearsals: 0,
    ...over,
  };
}

const lines = (block) => block.split("\n").filter((l) => l.startsWith("- "));

/** A believable store: a few anchors, a spread of the rest, one of them blurred. */
function realStore() {
  return [
    atom({ kind: "anchor", text: "He builds Teminali OS, and he builds it in Arusha." }),
    atom({ kind: "anchor", text: "His mother is Mama Neema and he calls her on Sundays." }),
    atom({ kind: "fact", text: "He ships at night and will not take a call before ten.", lastTouchedAt: NOW - 20 * DAY }),
    atom({ kind: "fact", text: "He cannot stand a meeting that could have been a message.", lastTouchedAt: NOW - 95 * DAY }),
    atom({ kind: "keepsake", text: "He argued with a banker about the public good for an hour.", lastTouchedAt: NOW - 240 * DAY, faded: true }),
    atom({ kind: "keepsake", text: "He sang a whole chorus he had sworn he did not know.", lastTouchedAt: NOW - 5 * DAY }),
    atom({ kind: "thread", text: "The pricing page has been nearly done for three weeks.", lastTouchedAt: NOW - 3 * DAY }),
  ];
}

/* ── A woman with no memories gets the prompt that was measured ───────────── */

test("an empty store yields the persona byte for byte, and the same object", () => {
  const composed = buildTemiPersona([], NOW);
  assert.equal(composed, TEMI_PERSONA);
  assert.equal(composed.length, TEMI_PERSONA.length);
  // Identity, not merely equality: nothing is rebuilt on the way through.
  assert.ok(composed === TEMI_PERSONA);
});

test("an unprimed store is an empty one, and neither gets a heading", () => {
  // `residentMemory()` answers `[]` before priming, deliberately, so that a
  // caller who forgot to prime gets a woman with no memory rather than a crash.
  // Both paths must land on the same prompt.
  assert.equal(buildTemiPersona([], NOW).includes(RECALL_BLOCK_HEADING), false);
  assert.equal(buildRecallBlock([], NOW), "");
});

test("a store that cannot afford one line is an empty store", () => {
  assert.equal(buildTemiPersona(realStore(), NOW, { blockBudgetChars: 4 }), TEMI_PERSONA);
});

/* ── What she is actually handed ──────────────────────────────────────────── */

test("the memories reach the prompt", () => {
  const store = realStore();
  const composed = buildTemiPersona(store, NOW, FIXED);
  assert.ok(composed.includes(RECALL_BLOCK_HEADING));
  for (const a of store) assert.ok(composed.includes(a.text), `missing: ${a.text}`);
});

test("the persona itself is carried through unchanged, only split", () => {
  const composed = buildTemiPersona(realStore(), NOW, FIXED);
  const at = TEMI_PERSONA.indexOf(RECALL_INSERT_BEFORE);
  assert.ok(composed.startsWith(TEMI_PERSONA.slice(0, at)));
  assert.ok(composed.endsWith(TEMI_PERSONA.slice(at)));
  assert.equal(composed.length - TEMI_PERSONA.length, buildRecallBlock(realStore(), NOW, FIXED).length + 2);
});

test("the block lands before the examples, not after them", () => {
  /* Decision 1. The last thing in a prompt is the strongest influence on the
     shape of what comes out, and the last thing in this one must be her voice.
     A run of terse dashed lines sitting after TEMI'S VOICE IN PRACTICE is an
     invitation to answer in terse dashed lines, which is the reciting failure
     the framing spends a paragraph forbidding. */
  const composed = buildTemiPersona(realStore(), NOW, FIXED);
  assert.ok(composed.indexOf(RECALL_BLOCK_HEADING) < composed.indexOf(RECALL_INSERT_BEFORE));
});

test("the splice point is a real section of the persona", () => {
  // Without this the insert silently degrades to an append and decision 1 is
  // lost with no test failing anywhere.
  assert.ok(TEMI_PERSONA.includes(RECALL_INSERT_BEFORE));
  assert.equal(TEMI_PERSONA.split(RECALL_INSERT_BEFORE).length - 1, 1);
});

/* ── An anchor is not a keepsake ──────────────────────────────────────────── */

test("anchors and keepsakes arrive under different headings", () => {
  const block = buildRecallBlock(realStore(), NOW, FIXED);
  assert.match(block, /^WHO HE IS:$/m);
  assert.match(block, /^WHAT HAS STAYED WITH YOU \(kept because it was funny/m);
  assert.match(block, /^WHAT HE HAS TOLD YOU \(the useful tier/m);
  assert.match(block, /^WHAT WAS STILL GOING ON \(open the last time you heard/m);
});

test("anchors carry no time and keepsakes do", () => {
  /* Policy decision 5 made visible in the prompt: the kind that does not decay
     is the kind with no date on it. A dated anchor would invite her to treat
     where he lives as something that might have expired. */
  const block = buildRecallBlock(realStore(), NOW, FIXED);
  const anchorLines = block.split("WHO HE IS:")[1].split("\n\n")[0].split("\n").filter((l) => l.startsWith("- "));
  assert.equal(anchorLines.length, 2);
  for (const line of anchorLines) assert.doesNotMatch(line, /\(.*ago\)$/);

  const keepsakeLines = block.split("WHAT HAS STAYED WITH YOU")[1].split("\n\n")[0].split("\n").filter((l) => l.startsWith("- "));
  assert.equal(keepsakeLines.length, 2);
  for (const line of keepsakeLines) assert.match(line, /\(.*ago(, blurred)?\)$/);
});

test("anchors get a paragraph telling her not to present them back as news", () => {
  const block = buildRecallBlock(realStore(), NOW, FIXED);
  assert.match(block, /These do not go stale and they carry no time/);
  assert.match(block, /you do not hand one back to him as a discovery/);
});

/* ── The framing is the point ─────────────────────────────────────────────── */

test("she is told these are hers, and told not to recite them", () => {
  const block = buildRecallBlock(realStore(), NOW, FIXED);
  assert.match(block, /These are your own memories of him/);
  assert.match(block, /Nobody briefed you and nothing was looked up/);
  assert.match(block, /Never as a list, never announced/);
});

test("she is told they may be stale, and who wins a contradiction", () => {
  const block = buildRecallBlock(realStore(), NOW, FIXED);
  assert.match(block, /some of them are wrong by now/);
  assert.match(block, /If he contradicts one, he is right/);
});

test("the staleness paragraph is absent when nothing carries a time", () => {
  // Anchors only. Telling her that lines end with a time when none do is the
  // same failure the persona spends a section forbidding: describing what is
  // not there.
  const anchorsOnly = [atom({ kind: "anchor", text: "He builds Teminali OS." })];
  const block = buildRecallBlock(anchorsOnly, NOW, FIXED);
  assert.doesNotMatch(block, /ends with roughly how long ago it was/);
  assert.match(block, /^WHO HE IS:$/m);
});

test("the blurred instruction appears only when a blurred memory made the cut", () => {
  const clear = realStore().filter((a) => a.faded !== true);
  assert.doesNotMatch(buildRecallBlock(clear, NOW, FIXED), /marked blurred/);
  assert.match(buildRecallBlock(realStore(), NOW, FIXED), /marked blurred/);
  assert.match(buildRecallBlock(realStore(), NOW, FIXED), /, blurred\)$/m);
});

test("ages are coarse, because a precise one she cannot verify is the fabrication", () => {
  const cases = [
    [0, "today"],
    [1.5, "yesterday"],
    [4, "a few days ago"],
    [10, "last week"],
    [21, "a few weeks ago"],
    [50, "last month"],
    [120, "a few months ago"],
    [300, "about a year ago"],
    [900, "years ago"],
  ];
  for (const [days, phrase] of cases) {
    const block = buildRecallBlock([atom({ kind: "fact", text: "He said a thing.", lastTouchedAt: NOW - days * DAY })], NOW, FIXED);
    assert.equal(lines(block)[0], `- He said a thing. (${phrase})`, `${days} days`);
  }
});

/* ── Bounded ──────────────────────────────────────────────────────────────── */

test("the rendered lines respect the block budget", () => {
  const many = Array.from({ length: 60 }, (_, i) => atom({ kind: "anchor", text: `anchor ${i} about him`.padEnd(40, ".") }));
  for (const budget of [120, 400, 1000, RECALL_BLOCK_BUDGET_CHARS]) {
    const block = buildRecallBlock(many, NOW, { ...FIXED, blockBudgetChars: budget });
    const spent = lines(block).reduce((n, l) => n + l.length + 1, 0);
    assert.ok(spent <= budget, `spent ${spent} of ${budget}`);
  }
});

test("the block stays bounded when the selector's budget is raised", () => {
  /* The difference between the two budgets, and why this one is written down.
     `selectForRecall` budgets characters of memory TEXT; a rendered line is
     that text plus a dash and, for anything but an anchor, an age. Measured at
     today's constants the difference does not bite: a 320-atom store renders
     about 2000 characters of lines, under the ceiling, so the block is
     currently bounded by the selector and not by this file.

     That is the reason for the ceiling rather than a reason against it. The
     bound is an accident of two constants in a file this one does not own, and
     raising either grows every system instruction she is ever given, on every
     session, with nothing failing. Here it fails. */
  const store = Array.from({ length: 320 }, (_, i) => atom({ kind: "anchor", text: `anchor ${i} about him` }));
  const spent = (block) => lines(block).reduce((n, l) => n + l.length + 1, 0);

  const today = buildRecallBlock(store, NOW, { ...FIXED, blockBudgetChars: 1e6 });
  assert.ok(spent(today) < RECALL_BLOCK_BUDGET_CHARS, `today it renders ${spent(today)}`);

  const widened = { ...FIXED, budgetChars: 20_000 };
  assert.ok(spent(buildRecallBlock(store, NOW, { ...widened, blockBudgetChars: 1e6 })) > RECALL_BLOCK_BUDGET_CHARS);
  const held = buildRecallBlock(store, NOW, widened);
  assert.ok(spent(held) <= RECALL_BLOCK_BUDGET_CHARS, `the ceiling did not hold: ${spent(held)}`);
});

test("the budget is spent in selection order, so the wander goes before an anchor", () => {
  /* `selectForRecall` has already ranked these. Trimming after grouping would
     let this file's heading order decide what she forgets, which is policy and
     policy does not live here. */
  const store = [
    ...Array.from({ length: 6 }, (_, i) => atom({ kind: "anchor", text: `anchor ${i}` })),
    ...Array.from({ length: 6 }, (_, i) => atom({ kind: "keepsake", text: `keepsake ${i}` })),
  ];
  const full = buildRecallBlock(store, NOW, FIXED);
  const squeezed = buildRecallBlock(store, NOW, { ...FIXED, blockBudgetChars: 90 });
  assert.equal(lines(full).length > lines(squeezed).length, true);
  for (const line of lines(squeezed)) assert.match(line, /^- anchor /);
});

/* ── Stable ───────────────────────────────────────────────────────────────── */

test("the same store at the same instant composes the same prompt", () => {
  const a = buildTemiPersona(realStore(), NOW, FIXED);
  const b = buildTemiPersona(realStore(), NOW, FIXED);
  assert.equal(a, b);
});

test("the order of the store does not change the order of the block", () => {
  /* Within a section the order is retention first, id as the tiebreak, rather
     than the order `selectForRecall` happened to claim them in. That order is
     an artefact of which pass took the atom, so reusing it would make the
     block's shape depend on the wander's luck. */
  const forwards = realStore();
  const backwards = [...realStore()].reverse();
  assert.equal(buildRecallBlock(forwards, NOW, FIXED), buildRecallBlock(backwards, NOW, FIXED));
});

test("equal retention is broken on id, not on insertion", () => {
  const same = { axes: { weight: 0.5, warmth: 0.5, surprise: 0.5, firstness: 0.5 }, lastTouchedAt: NOW };
  const one = buildRecallBlock(
    [atom({ kind: "fact", text: "zzz", id: "zzz", ...same }), atom({ kind: "fact", text: "aaa", id: "aaa", ...same })],
    NOW,
    FIXED,
  );
  assert.deepEqual(lines(one), ["- aaa (today)", "- zzz (today)"]);
});

/* ── The contract the tier exists to hold ─────────────────────────────────── */

test("composing is synchronous, and the module has nothing to await", async () => {
  const composed = buildTemiPersona(realStore(), NOW, FIXED);
  assert.equal(typeof composed, "string");
  const source = await readFile(new URL("../src/services/voice/temiPersona.ts", import.meta.url), "utf8");
  // Comments stripped, because this file argues for its decisions at length and
  // names the very things the code must not do.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bawait\b|\basync\b/, "the injection point must not be able to wait on anything");
  assert.doesNotMatch(code, /temiMemoryStore|GatewayClient/, "the persona is handed the store's contents, it does not reach for them");
});

test("the engine composes the instruction from the resident store", async () => {
  const engine = await readFile(new URL("../src/services/voice/geminiLiveEngine.ts", import.meta.url), "utf8");
  assert.match(engine, /systemInstruction: buildTemiPersona\(readResidentMemory\(\)\),/);
  assert.match(engine, /readResidentMemory = store\.residentMemory/);
  // Never the store's async half: importing it here would be the first step
  // towards awaiting the gateway on the live path.
  assert.doesNotMatch(engine, /import[^;]*primeTemiMemory/);
  assert.doesNotMatch(engine, /await [^;\n]*buildTemiPersona/);
});
