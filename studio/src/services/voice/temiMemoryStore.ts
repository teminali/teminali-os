import { GatewayClient } from "../gatewayClient.ts";
import type { MemoryAtom } from "./temiMemory.ts";

/**
 * The renderer's half of Temi's memory: fetching it, holding it, handing it back.
 *
 * `temiMemory.ts` decides what is worth keeping; `server/temi-memory.js` holds the
 * bytes. This is the seam between them, and its whole job is the timing.
 *
 * The latency contract in DESIGN.md §6.48 is that per-turn cost is structurally
 * zero — not small, zero, because there is no code on the live path to be fast.
 * That is only true if the store is RESIDENT before `live.connect`. So the shape
 * here is deliberately two calls, not one:
 *
 *   `primeTemiMemory()`  once, awaited, before the session opens. Pays the I/O.
 *   `residentMemory()`   synchronous, no promise, no fetch. Used from then on.
 *
 * A single async accessor would have been tidier and would have quietly allowed a
 * fetch to happen at recall time, which is exactly the thing this contract exists
 * to prevent. The awkwardness is the point.
 *
 * Plain functions rather than a class: these modules are imported as TypeScript
 * directly by `node --test`, whose strip-only mode cannot erase constructor
 * parameter properties. See the note at `ambientMemory.ts:166`.
 */

export interface TemiMemoryStore {
  atoms: MemoryAtom[];
}

/**
 * The resident copy, per renderer.
 *
 * Module-level state is right here and wrong a few files away — `playerControl.ts`
 * has a module-level `Set` that fails across renderers precisely because it needs
 * to be shared. This one must NOT be shared: it is a cache of a file, and the file
 * in the gateway is the single truth. What follows from that is a real constraint
 * rather than a hypothetical: two windows each holding a resident copy and each
 * saving would last-write-wins the whole store, because a save replaces it
 * wholesale. Temi's stage is one window, so that is not a live bug today; it
 * becomes one the moment a second surface writes memory, and the fix then is to
 * consolidate in one place, not to merge two caches.
 */
let resident: MemoryAtom[] | null = null;

/**
 * Loads the store and keeps it. Call once, awaited, BEFORE `live.connect`.
 *
 * Never throws. A gateway that is unreachable means she starts the conversation
 * without her memory, which is how she has always started every conversation
 * until now, and is not a reason to fail opening a voice session.
 *
 * Loads only — it does not consolidate. Time passing while the app was closed may
 * have taken atoms below the forget floor, but removing them is a policy decision
 * and it belongs to the post-session pass, not to a read. `selectForRecall` ranks
 * by retention anyway, so a dead atom is never chosen; it is merely still on disk
 * until the next consolidation, which is also what forgetting looks like from the
 * inside.
 */
export async function primeTemiMemory(): Promise<MemoryAtom[]> {
  try {
    return await loadTemiMemory();
  } catch {
    resident = [];
    return resident;
  }
}

/**
 * The same read, allowed to fail.
 *
 * The cache exists for the live path, where an unreachable gateway costs her
 * her memory for one conversation and nothing more. The WRITE path cannot use
 * it, and that asymmetry is the whole reason this function exists separately:
 * a save replaces the entire store, so a consolidation pass that merged one
 * session's memories into a cache holding `[]` because a fetch failed would
 * write those few atoms over everything she had, permanently, and look like a
 * successful pass while doing it.
 *
 * So `runMemoryPass` reads through here and declines to write when it throws.
 * It can afford to: by then the session is over and nothing is waiting.
 */
export async function loadTemiMemory(): Promise<MemoryAtom[]> {
  const response = await GatewayClient.expectOk(await GatewayClient.request("/api/workspace/temi-memory"));
  const data = (await response.json()) as Partial<TemiMemoryStore>;
  resident = Array.isArray(data.atoms) ? data.atoms : [];
  return resident;
}

/**
 * What she is holding right now. Synchronous by design: see the contract above.
 *
 * Empty before priming rather than null, so a caller that forgot to prime gets a
 * woman with no memory instead of a crash. That failure is silent on purpose —
 * it is indistinguishable from a first run, which is a state she already handles
 * gracefully — and `isTemiMemoryPrimed()` exists for the one caller that needs to
 * tell the two apart.
 */
export function residentMemory(): readonly MemoryAtom[] {
  return resident ?? [];
}

export function isTemiMemoryPrimed(): boolean {
  return resident !== null;
}

/**
 * Writes the store back after a consolidation pass, and re-seats the resident copy
 * from what the server actually kept.
 *
 * The reply is used rather than the argument because the server sanitises: an atom
 * that was dropped or a text that was trimmed on the way in must not still look
 * present in memory here. A cache that disagrees with the file is worse than no
 * cache, because it disagrees silently and only at the next session.
 *
 * This runs AFTER a session has ended. It is the only write in the tier.
 */
export async function saveTemiMemory(atoms: readonly MemoryAtom[]): Promise<MemoryAtom[]> {
  const response = await GatewayClient.expectOk(
    await GatewayClient.request("/api/workspace/temi-memory/save", {
      method: "POST",
      body: JSON.stringify({ atoms }),
    }),
  );
  const data = (await response.json()) as Partial<TemiMemoryStore>;
  resident = Array.isArray(data.atoms) ? data.atoms : [];
  return resident;
}

/** Drops one memory — "forget that". Answers whether there was anything to forget. */
export async function forgetMemory(id: string): Promise<boolean> {
  const response = await GatewayClient.expectOk(
    await GatewayClient.request("/api/workspace/temi-memory/forget", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  );
  const data = (await response.json()) as { forgot?: boolean; atoms?: MemoryAtom[] };
  if (Array.isArray(data.atoms)) resident = data.atoms;
  return data.forgot === true;
}

/** Everything, gone. */
export async function clearMemory(): Promise<void> {
  await GatewayClient.expectOk(
    await GatewayClient.request("/api/workspace/temi-memory/clear", { method: "POST" }),
  );
  resident = [];
}

/** Test seam. Nothing in the app calls this; it exists so tests do not leak state. */
export function __resetTemiMemoryForTest(): void {
  resident = null;
}
