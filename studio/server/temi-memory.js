import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Where what Temi remembers actually lives.
 *
 * The policy — what a memory is worth, how it decays, what fades and what is
 * evicted — is `src/services/voice/temiMemory.ts` and none of it is here. This
 * file is the tier below it: bytes on disk, and the structural gate that stands
 * between a JSON file anyone can hand-edit and the policy that trusts its input.
 *
 * In the gateway rather than the renderer for the same reason `browser-data.js`
 * is, and one more. The shared reason is the agent: a renderer-only store is one
 * the agent routes cannot read. The additional one is time. This is data meant to
 * last years, and localStorage is cleared by things that have nothing to do with
 * wanting to be forgotten — a profile reset, a cache purge, an Electron upgrade.
 *
 * Written 0600, unlike the browser store and like the provider keys. Bookmarks
 * are a list of addresses; this is a record of what someone said and how it
 * landed. The temp file is created 0600 and `rename` carries the mode across, so
 * the store is never briefly world-readable.
 *
 * NOTHING HERE RUNS DURING A TURN. The latency contract in DESIGN.md §6.48 is
 * that per-turn cost is structurally zero: the store is read once, before
 * `live.connect`, and written once, after the session has ended. If a future
 * change puts a read or a write on the live path, that contract is broken even
 * if the measurement still looks fast on this machine.
 */

/**
 * A ceiling, not the policy's cap.
 *
 * `MEMORY_MAX_ATOMS` in `temiMemory.ts` is 320 and it is the real bound; a
 * consolidation pass never hands this file more than that. This number is
 * deliberately above it so the two are not the same knob: the server's job is to
 * refuse an unbounded file, not to re-decide what is kept. If these were equal, a
 * later change to the policy cap would silently truncate here instead of failing
 * somewhere it could be seen.
 */
export const MAX_STORED_ATOMS = 512;

const MAX_ID_CHARS = 64;
const MAX_TEXT_CHARS = 400;

/**
 * The four kinds, copied from `temiMemory.ts` rather than imported.
 *
 * The server is plain JS and the policy is TypeScript in the renderer tree, so
 * there is no import that would keep these in step. This is the one piece of
 * policy knowledge duplicated here, and it is duplicated because a sanitiser that
 * accepted any string as a `kind` would let a typo become a fifth kind that holds
 * no reserve and decays as nothing. `tests/temi-memory-store.test.mjs` asserts the
 * two lists are identical by reading both files, so the copy cannot drift quietly.
 */
export const STORED_KINDS = Object.freeze(["anchor", "fact", "keepsake", "thread"]);

const AXES = Object.freeze(["weight", "warmth", "surprise", "firstness"]);

/** Display text: one line, no control characters, bounded. */
function cleanText(value) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

/** An axis is a number in 0..1. Anything else reads as zero, never as NaN. */
function cleanAxis(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * An epoch milliseconds stamp that is actually a time.
 *
 * A missing or nonsense stamp becomes `now`, which makes the atom look freshly
 * laid down rather than infinitely old. That direction is chosen on purpose: the
 * other one would hand a corrupted file straight to the forget floor and delete
 * memories because a number was malformed.
 */
function cleanStamp(value, now) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : now;
}

function cleanAtom(entry, now) {
  if (!entry || typeof entry !== "object") return null;
  const id = typeof entry.id === "string" ? entry.id.trim().slice(0, MAX_ID_CHARS) : "";
  if (!id) return null;
  if (!STORED_KINDS.includes(entry.kind)) return null;
  const text = cleanText(entry.text);
  // A memory with no words is not a memory. It cannot be recalled, spoken or
  // faded to a gist, so it is dropped rather than stored as an empty row.
  if (!text) return null;

  const axes = {};
  for (const axis of AXES) axes[axis] = cleanAxis(entry.axes?.[axis]);

  const bornAt = cleanStamp(entry.bornAt, now);
  // Decay counts from `lastTouchedAt`, so a stamp before the atom was born would
  // age it faster than time has actually passed.
  const lastTouchedAt = Math.max(bornAt, cleanStamp(entry.lastTouchedAt, now));
  const rehearsals = Number.isFinite(entry.rehearsals) && entry.rehearsals > 0 ? Math.floor(entry.rehearsals) : 0;

  const atom = { id, kind: entry.kind, text, axes, bornAt, lastTouchedAt, rehearsals };
  const gist = cleanText(entry.gist);
  if (gist) atom.gist = gist;
  // `faded` claims the detail is already gone. The flag is carried across as
  // given: it is `stageOf` that decides what an atom's stage is now, and a
  // sanitiser that second-guessed the flag would be making a policy call.
  if (entry.faded === true) atom.faded = true;
  return atom;
}

/** The file as the routes may trust it. Every atom is rebuilt; nothing unknown survives. */
export function sanitizeTemiMemory(raw, now = Date.now()) {
  const source = raw && typeof raw === "object" ? raw : {};
  const atoms = [];
  const seen = new Set();
  for (const entry of Array.isArray(source.atoms) ? source.atoms : []) {
    const clean = cleanAtom(entry, now);
    // One id is one memory. A duplicated id is the shape a bad merge takes, and
    // keeping the first occurrence makes the store's own order authoritative.
    if (!clean || seen.has(clean.id)) continue;
    seen.add(clean.id);
    atoms.push(clean);
    if (atoms.length >= MAX_STORED_ATOMS) break;
  }
  return { atoms };
}

async function readStore(storePath) {
  try {
    return sanitizeTemiMemory(JSON.parse(await readFile(storePath, "utf8")));
  } catch {
    // A store that cannot be read is an empty one, never an error. She has no
    // memory on a first run either, and that is a state she already handles.
    return { atoms: [] };
  }
}

async function writeStore(storePath, data) {
  await mkdir(dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, storePath);
  return data;
}

/** Read once, before `live.connect`. See the latency note at the top of this file. */
export async function readTemiMemory(storePath) {
  return readStore(storePath);
}

/**
 * Replaces the whole store with the result of a consolidation pass.
 *
 * Whole-file rather than row-at-a-time because consolidation is not an insert: a
 * pass decides what survives, what faded to its gist and what is gone, all at
 * once, and there is no sequence of single-row writes that expresses that without
 * a window in which the store is half-consolidated. It is also the only write
 * this tier has, which is what keeps "nothing runs during a turn" checkable.
 */
export async function writeTemiMemory(storePath, atoms) {
  const data = sanitizeTemiMemory({ atoms: Array.isArray(atoms) ? atoms : [] });
  await writeStore(storePath, data);
  return data;
}

/**
 * Drops one memory by id — "forget that".
 *
 * Returns whether anything went, because the honest answer to being asked to
 * forget something she was never told differs from the answer to forgetting it.
 */
export async function forgetTemiMemory(storePath, id) {
  const data = await readStore(storePath);
  const before = data.atoms.length;
  data.atoms = data.atoms.filter((atom) => atom.id !== id);
  const forgot = data.atoms.length < before;
  if (forgot) await writeStore(storePath, data);
  return { forgot, atoms: data.atoms };
}

/** Everything, gone. The store is personal; forgetting all of it has to be one call. */
export async function clearTemiMemory(storePath) {
  return writeStore(storePath, { atoms: [] });
}
