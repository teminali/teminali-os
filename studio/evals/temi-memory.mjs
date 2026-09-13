/**
 * Does the policy actually keep what a person would keep?
 *
 * The brief forbade ranking retention on importance alone, on the grounds that
 * an importance-ranked store becomes a CRM record and stops being a memory. That
 * is a claim about an outcome, and an outcome can be measured instead of
 * asserted, so this simulates a year and counts what survived.
 *
 * The simulation's realism is in the RATIO, not in the sentences: a heavy,
 * continuous stream of genuinely useful facts, against a thin scatter of things
 * that were merely wonderful. That ratio is the adversary. Any policy looks fine
 * on a balanced diet; the question is what happens to twenty-six jokes when three
 * hundred deadlines arrive in the same year.
 *
 * It is run against a baseline that is exactly the design the brief rejected:
 * rank by importance, keep the top N, no decay, no kinds. Both policies see the
 * identical event stream from the identical seed, so the difference in what
 * survives is caused by the policy and nothing else.
 *
 *   node evals/temi-memory.mjs
 */
import {
  consolidate,
  retention,
  strength,
  selectForRecall,
  rehearse,
  MEMORY_MAX_ATOMS,
} from "../src/services/voice/temiMemory.ts";

const DAY = 24 * 60 * 60 * 1000;
const START = 1_800_000_000_000;
const YEAR_DAYS = 365;

/** Seeded so a re-run is comparable; mulberry32. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rand = rng(20260913);
const between = (lo, hi) => lo + rand() * (hi - lo);

let nextId = 0;
function atom(kind, day, axes, text) {
  const at = START + day * DAY;
  nextId += 1;
  return {
    id: `m${nextId}`,
    kind,
    text,
    gist: text.split(",")[0],
    axes,
    bornAt: at,
    lastTouchedAt: at,
    rehearsals: 0,
  };
}

/*
 * The event stream, as a function of how hard the useful tier pushes.
 *
 * `factsPerDay` is the adversary. At 6 a week the store never fills and the
 * half-lives alone decide what survives; the reserve is never consulted, so a
 * pass at that load proves D1 and D3 and says NOTHING about D2. Running it again
 * at a load that genuinely overruns the cap is the only way the reserved slots
 * are ever put under the pressure they exist for.
 */
function buildEvents(factsPerDay) {
  nextId = 0;
  rand = rng(20260913);
  const events = [];
  for (let day = 0; day < YEAR_DAYS; day += 1) {
    if (day < 30 && day % 4 === 0) {
      events.push({ day, atom: atom("anchor", day, { weight: between(0.5, 0.9), warmth: between(0.3, 0.7), surprise: between(0, 0.3), firstness: between(0.5, 1) }, `anchor ${day}: who he is`) });
    }
    for (let n = 0; n < factsPerDay; n += 1) {
      events.push({ day, atom: atom("fact", day, { weight: between(0.5, 0.95), warmth: between(0, 0.2), surprise: between(0, 0.15), firstness: between(0, 0.1) }, `fact ${day}.${n}: a deadline, a preference, a constraint`) });
    }
    // One wonderful thing every twelve days, at every load. This is what must survive.
    if (day % 12 === 5) {
      events.push({ day, atom: atom("keepsake", day, { weight: between(0, 0.15), warmth: between(0.7, 0.98), surprise: between(0.3, 0.9), firstness: between(0, 0.4) }, `keepsake ${day}: the absurd thing that happened`) });
    }
    if (day % 21 === 3) {
      events.push({ day, atom: atom("thread", day, { weight: between(0.3, 0.6), warmth: between(0.2, 0.5), surprise: between(0.1, 0.3), firstness: between(0.2, 0.5) }, `thread ${day}: an ongoing story`) });
    }
  }
  const rehearsalPlan = [];
  for (let day = 7; day < YEAR_DAYS; day += 1) {
    const eligible = events.filter((e) => e.day < day - 1);
    if (eligible.length === 0) continue;
    const draw = rand();
    const pick = (kind) => {
      const pool = eligible.filter((e) => e.atom.kind === kind);
      return pool.length ? pool[Math.floor(rand() * pool.length)].atom.id : null;
    };
    let id = null;
    if (draw < 0.35) id = pick("thread");
    else if (draw < 0.45) id = pick("keepsake");
    else if (draw < 0.5) id = pick("fact");
    if (id) rehearsalPlan.push({ day, id });
  }
  return { events, rehearsalPlan };
}

function runPolicy(events, rehearsalPlan) {
  let store = [];
  for (let day = 0; day < YEAR_DAYS; day += 1) {
    const now = START + day * DAY;
    for (const e of events.filter((x) => x.day === day)) store.push(e.atom);
    for (const r of rehearsalPlan.filter((x) => x.day === day)) {
      const i = store.findIndex((a) => a.id === r.id);
      if (i >= 0) store[i] = rehearse(store[i], undefined, now);
    }
    if (day % 7 === 0) store = consolidate(store, now).kept;
  }
  return consolidate(store, START + YEAR_DAYS * DAY).kept;
}

/* The rejected design, implemented faithfully: importance only, top N, no decay. */
function runImportanceOnly(events, rehearsalPlan) {
  let store = [];
  for (let day = 0; day < YEAR_DAYS; day += 1) {
    const now = START + day * DAY;
    for (const e of events.filter((x) => x.day === day)) store.push(e.atom);
    for (const r of rehearsalPlan.filter((x) => x.day === day)) {
      const i = store.findIndex((a) => a.id === r.id);
      if (i >= 0) store[i] = rehearse(store[i], undefined, now);
    }
    if (store.length > MEMORY_MAX_ATOMS) {
      store = [...store].sort((a, b) => b.axes.weight - a.axes.weight).slice(0, MEMORY_MAX_ATOMS);
    }
  }
  return store;
}

const byKind = (s) => {
  const out = {};
  for (const a of s) out[a.kind] = (out[a.kind] || 0) + 1;
  return out;
};

const pct = (n, d) => (d === 0 ? " n/a" : `${((100 * n) / d).toFixed(0).padStart(3)}%`);
const row = (label, a, b) => `  ${label.padEnd(24)} ${String(a).padStart(6)}   ${String(b).padStart(6)}`;

function scenario(name, factsPerDay, note) {
  const { events, rehearsalPlan } = buildEvents(factsPerDay);
  const laid = byKind(events.map((e) => e.atom));
  const mine = runPolicy(events, rehearsalPlan);
  const naive = runImportanceOnly(events, rehearsalPlan);
  const end = START + YEAR_DAYS * DAY;

  const earlyKeepsakes = events.filter((e) => e.atom.kind === "keepsake" && e.day < 90).map((e) => e.atom.id);
  const survivedEarly = (s) => earlyKeepsakes.filter((id) => s.some((a) => a.id === id)).length;

  console.log(`\n${"=".repeat(58)}`);
  console.log(`${name}  (${factsPerDay} fact${factsPerDay === 1 ? "" : "s"}/day)`);
  console.log(note);
  console.log(`${"=".repeat(58)}`);
  console.log(`Laid down ${events.length} atoms ${JSON.stringify(laid)}, ${rehearsalPlan.length} rehearsals`);
  console.log(`Cap ${MEMORY_MAX_ATOMS}. Reserve pressure: ${events.length > MEMORY_MAX_ATOMS * 1.5 ? "YES, the cap binds" : "low"}\n`);
  console.log(`  ${"".padEnd(24)} ${"policy".padStart(6)}   ${"naive".padStart(6)}`);
  console.log(row("total surviving", mine.length, naive.length));
  for (const k of ["anchor", "fact", "keepsake", "thread"]) {
    console.log(row(`  ${k}`, byKind(mine)[k] || 0, byKind(naive)[k] || 0));
  }
  console.log("");
  console.log(row("keepsakes laid down", laid.keepsake || 0, laid.keepsake || 0));
  console.log(row("  still kept", byKind(mine).keepsake || 0, byKind(naive).keepsake || 0));
  console.log(row("  of those, 9+ months old", survivedEarly(mine), survivedEarly(naive)));
  console.log("");
  console.log(`  keepsake survival        ${pct(byKind(mine).keepsake || 0, laid.keepsake)}     ${pct(byKind(naive).keepsake || 0, laid.keepsake)}`);
  console.log(`  the oldest of them       ${pct(survivedEarly(mine), earlyKeepsakes.length)}     ${pct(survivedEarly(naive), earlyKeepsakes.length)}`);

  const recalled = selectForRecall(mine, end, { random: rng(7) });
  const chars = recalled.reduce((s, a) => s + a.text.length + 1, 0);
  console.log(`\n  faded to gist            ${mine.filter((a) => a.faded).length} of ${mine.length} kept`);
  console.log(`  recall block             ${recalled.length} atoms, ${chars} chars  ${JSON.stringify(byKind(recalled))}`);
  return { mine, naive, laid, survivedEarly: survivedEarly(mine), earlyTotal: earlyKeepsakes.length };
}

console.log(`\nTemi memory retention: ${YEAR_DAYS} simulated days, two loads, same seed.`);
console.log("The naive column is the design the brief rejected: rank by importance, keep the top N.");

const ordinary = scenario(
  "AN ORDINARY YEAR",
  1,
  "The cap never binds, so this isolates decay: half-lives and rehearsal alone.",
);
const heavy = scenario(
  "A PUNISHING YEAR",
  4,
  "Four useful facts every day for a year. Here the cap binds and the reserve is\nthe only thing standing between the keepsakes and the flood.",
);

console.log(`\n${"=".repeat(58)}`);
const ok =
  (byKind(ordinary.mine).keepsake || 0) === (ordinary.laid.keepsake || 0) &&
  (byKind(heavy.mine).keepsake || 0) >= (heavy.laid.keepsake || 0) * 0.9 &&
  (byKind(heavy.naive).keepsake || 0) < (byKind(heavy.mine).keepsake || 0);
console.log(ok ? "PASS  the fun things survive both loads; the rejected design loses them." : "FAIL  a keepsake was lost. The policy is not doing what it claims.");
console.log(`${"=".repeat(58)}\n`);
