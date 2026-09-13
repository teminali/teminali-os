import test from "node:test";
import assert from "node:assert/strict";
import { runMemoryPass, formatMemoryPass } from "../src/services/voice/temiMemoryPass.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
const ids = () => `id-${(seq += 1)}`;

const turns = [
  { role: "user", content: "I named the build machine after my aunt" },
  { role: "assistant", content: "That is an excellent reason to keep it running" },
];

const candidate = {
  kind: "keepsake",
  text: "He named the build machine after his aunt",
  axes: { weight: 0.1, warmth: 0.9, surprise: 0.6, firstness: 0.8 },
};

const replies = (rows) => async () => JSON.stringify(rows);
const explodes = (message) => async () => {
  throw new Error(message);
};

const atom = (over = {}) => ({
  id: over.id ?? ids(),
  kind: "fact",
  text: "He takes his coffee black",
  axes: { weight: 0.5, warmth: 0.2, surprise: 0.2, firstness: 0.2 },
  bornAt: NOW - DAY,
  lastTouchedAt: NOW - DAY,
  rehearsals: 0,
  ...over,
});

/** A store that records what it was asked to write. */
function fakeStore(initial = []) {
  const store = { atoms: initial, saves: [], loads: 0 };
  return {
    store,
    load: async () => {
      store.loads += 1;
      return store.atoms;
    },
    save: async (atoms) => {
      store.saves.push([...atoms]);
      store.atoms = [...atoms];
      return store.atoms;
    },
  };
}

test("a session with nothing said is not a session, and costs a model nothing", async () => {
  const { load, save, store } = fakeStore();
  let called = false;
  const report = await runMemoryPass({
    turns: [{ role: "user", content: "   " }],
    complete: async () => {
      called = true;
      return "[]";
    },
    now: NOW,
    newId: ids,
    load,
    save,
  });
  assert.equal(report.outcome, "no-transcript");
  assert.equal(called, false);
  assert.equal(store.loads, 0);
  assert.equal(store.saves.length, 0);
});

test("a store that cannot be read is NOT an empty store, and nothing is written", async () => {
  // The one that matters. A save replaces the store wholesale, so treating a
  // failed read as a first run would overwrite everything she has with the two
  // memories from this conversation, silently, and report success.
  const { save, store } = fakeStore();
  const report = await runMemoryPass({
    turns,
    complete: replies([candidate]),
    now: NOW,
    newId: ids,
    load: explodes("gateway is down"),
    save,
  });
  assert.equal(report.outcome, "load-failed");
  assert.equal(store.saves.length, 0);
});

test("a model that could not answer is not a conversation worth forgetting", async () => {
  const { load, save, store } = fakeStore([atom()]);
  const report = await runMemoryPass({
    turns,
    complete: explodes("ollama is not running"),
    now: NOW,
    newId: ids,
    load,
    save,
  });
  assert.equal(report.outcome, "extraction-failed");
  assert.equal(report.kept, 1);
  assert.equal(store.saves.length, 0);
  assert.deepEqual(store.atoms.length, 1);
});

test("a quiet session changes nothing and does not touch the file", async () => {
  const { load, save, store } = fakeStore([atom({ kind: "anchor", text: "He lives in Arusha", subject: "home" })]);
  const report = await runMemoryPass({ turns, complete: replies([]), now: NOW, newId: ids, load, save });
  assert.equal(report.outcome, "nothing-changed");
  assert.equal(store.saves.length, 0);
});

test("a memory from the conversation lands in the store", async () => {
  const { load, save, store } = fakeStore();
  const report = await runMemoryPass({ turns, complete: replies([candidate]), now: NOW, newId: ids, load, save });
  assert.equal(report.outcome, "saved");
  assert.equal(report.laid, 1);
  assert.equal(report.kept, 1);
  assert.equal(store.saves.length, 1);
  assert.equal(store.atoms[0].text, candidate.text);
  assert.equal(store.atoms[0].bornAt, NOW);
});

test("saying it again rehearses rather than writing it twice", async () => {
  const existing = atom({ kind: "keepsake", text: candidate.text, axes: { ...candidate.axes, warmth: 0.4 } });
  const { load, save, store } = fakeStore([existing]);
  const report = await runMemoryPass({ turns, complete: replies([candidate]), now: NOW, newId: ids, load, save });
  assert.equal(report.outcome, "saved");
  assert.equal(report.laid, 0);
  assert.equal(report.rehearsed, 1);
  assert.equal(store.atoms.length, 1);
  assert.equal(store.atoms[0].rehearsals, 1);
});

test("time alone is enough to make a pass worth writing", async () => {
  // Nothing was said worth keeping, but a thread nobody picked back up has
  // gone past the forget floor while the app was closed.
  const dead = atom({ kind: "thread", text: "He was chasing a flaky test in the runner", lastTouchedAt: NOW - 400 * DAY });
  const { load, save, store } = fakeStore([dead]);
  const report = await runMemoryPass({ turns, complete: replies([]), now: NOW, newId: ids, load, save });
  assert.equal(report.outcome, "saved");
  assert.equal(report.forgotten, 1);
  assert.equal(store.atoms.length, 0);
});

test("a save that fails reports so rather than claiming she remembered", async () => {
  const { load, store } = fakeStore();
  const report = await runMemoryPass({
    turns,
    complete: replies([candidate]),
    now: NOW,
    newId: ids,
    load,
    save: explodes("disk is full"),
  });
  assert.equal(report.outcome, "save-failed");
  assert.equal(report.laid, 1);
  assert.equal(store.atoms.length, 0);
});

test("the pass never throws, whatever it is handed", async () => {
  for (const complete of [explodes("boom"), async () => "not json at all", async () => ""]) {
    const { load, save } = fakeStore();
    const report = await runMemoryPass({ turns, complete, now: NOW, newId: ids, load, save });
    assert.ok(typeof report.outcome === "string");
  }
});

test("a superseded anchor leaves the store and is counted", async () => {
  const { load, save, store } = fakeStore([atom({ kind: "anchor", text: "He lives in Arusha", subject: "home" })]);
  const moved = {
    kind: "anchor",
    text: "He moved to Dodoma in September",
    subject: "home",
    axes: { weight: 0.8, warmth: 0.4, surprise: 0.5, firstness: 0.9 },
  };
  const report = await runMemoryPass({ turns, complete: replies([moved]), now: NOW, newId: ids, load, save });
  assert.equal(report.superseded, 1);
  assert.equal(store.atoms.length, 1);
  assert.equal(store.atoms[0].text, moved.text);
});

test("what the console says can tell a quiet session from a broken one", () => {
  assert.match(formatMemoryPass({ outcome: "load-failed", laid: 0, rehearsed: 0, superseded: 0, faded: 0, forgotten: 0, kept: 0 }), /nothing written/);
  assert.match(formatMemoryPass({ outcome: "saved", laid: 2, rehearsed: 1, superseded: 0, faded: 0, forgotten: 3, kept: 40 }), /\+2 new/);
});
