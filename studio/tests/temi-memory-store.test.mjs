import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_STORED_ATOMS,
  STORED_KINDS,
  clearTemiMemory,
  forgetTemiMemory,
  readTemiMemory,
  sanitizeTemiMemory,
  writeTemiMemory,
} from "../server/temi-memory.js";
import { MEMORY_KINDS, MEMORY_MAX_ATOMS } from "../src/services/voice/temiMemory.ts";

/**
 * The tier below the policy: bytes on disk, and the gate in front of them.
 *
 * What is worth pinning here is not the round trip, which is obvious, but the
 * three things that would fail quietly: the kinds list duplicated out of the
 * TypeScript policy into plain server JS, the file mode on data this personal,
 * and the sanitiser refusing input the policy would otherwise take on trust.
 */

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function storePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "temi-memory-")), "gateway", "temi-memory.json");
}

function atom(overrides = {}) {
  return {
    id: "a1",
    kind: "keepsake",
    text: "He called the deploy script a haunted house.",
    axes: { weight: 0.2, warmth: 0.8, surprise: 0.5, firstness: 0.3 },
    bornAt: NOW - 10 * DAY,
    lastTouchedAt: NOW - 10 * DAY,
    rehearsals: 0,
    ...overrides,
  };
}

test("the server's kinds are the policy's kinds", () => {
  // The one piece of policy knowledge server/temi-memory.js duplicates, because
  // it is plain JS and cannot import the TypeScript it is guarding. A typo here
  // would invent a fifth kind that holds no reserve and decays as nothing.
  assert.deepEqual([...STORED_KINDS], [...MEMORY_KINDS]);
});

test("the storage ceiling sits above the policy cap, not on it", () => {
  // If these were equal, raising MEMORY_MAX_ATOMS would silently truncate in the
  // store instead of failing somewhere visible.
  assert.ok(MAX_STORED_ATOMS > MEMORY_MAX_ATOMS, `${MAX_STORED_ATOMS} should exceed ${MEMORY_MAX_ATOMS}`);
});

test("a store that has never been written reads as no memory at all", async () => {
  assert.deepEqual(await readTemiMemory(storePath()), { atoms: [] });
});

test("a corrupt store reads as empty rather than throwing", async () => {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ this is not json");
  // She has no memory on a first run either. That is a state she handles.
  assert.deepEqual(await readTemiMemory(file), { atoms: [] });
});

test("an atom survives the round trip whole", async () => {
  const file = storePath();
  const written = await writeTemiMemory(file, [atom({ gist: "A joke about the deploy script." })]);
  assert.equal(written.atoms.length, 1);
  const read = await readTemiMemory(file);
  assert.deepEqual(read.atoms[0], written.atoms[0]);
  assert.equal(read.atoms[0].gist, "A joke about the deploy script.");
  assert.equal(read.atoms[0].kind, "keepsake");
});

test("the store is written 0600, and is never briefly wider", async () => {
  // Bookmarks are a list of addresses; this is a record of what someone said and
  // how it landed. The temp file is created 0600 and rename carries the mode, so
  // there is no window in which the file is world-readable.
  const file = storePath();
  await writeTemiMemory(file, [atom()]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("the sanitiser refuses what the policy would otherwise trust", () => {
  const { atoms } = sanitizeTemiMemory(
    {
      atoms: [
        atom({ id: "" }),
        atom({ id: "b", kind: "vibe" }),
        atom({ id: "c", text: "   " }),
        atom({ id: "d", text: 42 }),
        null,
        "not an atom",
        atom({ id: "keeper" }),
      ],
    },
    NOW,
  );
  assert.deepEqual(
    atoms.map((entry) => entry.id),
    ["keeper"],
  );
});

test("axes are clamped into 0..1 and never land on NaN", () => {
  const { atoms } = sanitizeTemiMemory(
    { atoms: [atom({ axes: { weight: 5, warmth: -2, surprise: Number.NaN, firstness: "high" } })] },
    NOW,
  );
  assert.deepEqual(atoms[0].axes, { weight: 1, warmth: 0, surprise: 0, firstness: 0 });
});

test("a missing axis reads as zero rather than undefined", () => {
  const { atoms } = sanitizeTemiMemory({ atoms: [atom({ axes: { warmth: 0.6 } })] }, NOW);
  assert.deepEqual(atoms[0].axes, { weight: 0, warmth: 0.6, surprise: 0, firstness: 0 });
});

test("a nonsense timestamp reads as now, not as infinitely old", () => {
  // The other direction would hand a corrupted file straight to the forget floor
  // and delete memories because a number was malformed.
  const { atoms } = sanitizeTemiMemory({ atoms: [atom({ bornAt: "yesterday", lastTouchedAt: null })] }, NOW);
  assert.equal(atoms[0].bornAt, NOW);
  assert.equal(atoms[0].lastTouchedAt, NOW);
});

test("an atom cannot have been touched before it was born", () => {
  // Decay counts from lastTouchedAt, so a stamp before bornAt would age it faster
  // than time has actually passed.
  const { atoms } = sanitizeTemiMemory(
    { atoms: [atom({ bornAt: NOW - DAY, lastTouchedAt: NOW - 400 * DAY })] },
    NOW,
  );
  assert.equal(atoms[0].lastTouchedAt, NOW - DAY);
});

test("control characters do not survive into her words", () => {
  const { atoms } = sanitizeTemiMemory({ atoms: [atom({ text: "he said\u0000 the\u001b thing\u007f" })] }, NOW);
  assert.equal(atoms[0].text, "he said the thing");
});

test("one id is one memory", () => {
  const { atoms } = sanitizeTemiMemory(
    { atoms: [atom({ id: "same", text: "first" }), atom({ id: "same", text: "second" })] },
    NOW,
  );
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].text, "first");
});

test("the ceiling holds against a file that grew without a policy", () => {
  const many = Array.from({ length: MAX_STORED_ATOMS + 50 }, (_, i) => atom({ id: `a${i}` }));
  assert.equal(sanitizeTemiMemory({ atoms: many }, NOW).atoms.length, MAX_STORED_ATOMS);
});

test("negative and fractional rehearsals become a count", () => {
  const { atoms } = sanitizeTemiMemory(
    { atoms: [atom({ id: "x", rehearsals: -3 }), atom({ id: "y", rehearsals: 2.7 })] },
    NOW,
  );
  assert.equal(atoms[0].rehearsals, 0);
  assert.equal(atoms[1].rehearsals, 2);
});

test("a save replaces the whole store, because a consolidation pass decides it all at once", async () => {
  const file = storePath();
  await writeTemiMemory(file, [atom({ id: "one" }), atom({ id: "two" })]);
  const after = await writeTemiMemory(file, [atom({ id: "three" })]);
  assert.deepEqual(after.atoms.map((entry) => entry.id), ["three"]);
  assert.deepEqual((await readTemiMemory(file)).atoms.map((entry) => entry.id), ["three"]);
});

test("forgetting one memory says whether there was one to forget", async () => {
  const file = storePath();
  await writeTemiMemory(file, [atom({ id: "one" }), atom({ id: "two" })]);

  const missing = await forgetTemiMemory(file, "nope");
  assert.equal(missing.forgot, false);
  assert.equal(missing.atoms.length, 2);

  const hit = await forgetTemiMemory(file, "one");
  assert.equal(hit.forgot, true);
  assert.deepEqual((await readTemiMemory(file)).atoms.map((entry) => entry.id), ["two"]);
});

test("clearing leaves nothing behind", async () => {
  const file = storePath();
  await writeTemiMemory(file, [atom({ id: "one" }), atom({ id: "two" })]);
  await clearTemiMemory(file);
  assert.deepEqual((await readTemiMemory(file)).atoms, []);
});

test("a save leaves no temp file beside the store", async () => {
  // Atomic temp+rename: if the rename did not happen, the store is stale AND the
  // directory is littered, and only the second of those is visible.
  const file = storePath();
  await writeTemiMemory(file, [atom()]);
  const siblings = fs.readdirSync(path.dirname(file));
  assert.deepEqual(siblings, ["temi-memory.json"]);
});
