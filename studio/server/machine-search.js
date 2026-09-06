/**
 * Files and folders on the machine, outside the workspace.
 *
 * The sidebar's search covers everything *inside* the app — the workspace, the
 * chats, the browser's lists, the panels. The operator asked whether it could
 * also find files on their Mac, which is a different question with a different
 * answer, because the workspace search is a walk and the machine is not
 * walkable: `~` alone is hundreds of thousands of entries, and a search that
 * takes eleven seconds is one nobody uses twice.
 *
 * So this asks the index that already exists. On macOS that is **Spotlight**,
 * through `mdfind`, which answers a name query over an index the operating
 * system maintains anyway. There is no equivalent on Windows or Linux that can
 * be assumed present — `dir /s` and `find` are the walk this exists to avoid,
 * and Everything or `locate` are installations, not guarantees — so those
 * platforms are told plainly that this lane is unavailable rather than being
 * given something slow that looks broken.
 *
 * ## What it will not do
 *
 * - **No shell string.** `mdfind` is spawned with an argument array, so a
 *   query containing a quote or a semicolon is a query, not a command.
 * - **Bounded to the home directory.** `-onlyin` keeps `/System` and every
 *   other machine's mounted volume out of it; "my files" is what was asked for
 *   and it is also the only part worth indexing an answer from.
 * - **Bounded in time and in count.** A search that has not answered in
 *   `MACHINE_SEARCH_TIMEOUT_MS` is killed and reports what it had, and at most
 *   `MACHINE_SEARCH_LIMIT` rows are classified — a `stat` per row is the cost,
 *   and forty is already more than a person reads.
 * - **It does not read anything.** The result is a path, a name and whether it
 *   is a directory. Opening one is the renderer's decision and goes through the
 *   same workspace boundary as a dropped file: nothing outside the project root
 *   is read across it.
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { homedir, platform } from "node:os";

/** At most this many rows are classified and returned. */
export const MACHINE_SEARCH_LIMIT = 40;

/** A search that has not answered by now is killed and reports what it had. */
export const MACHINE_SEARCH_TIMEOUT_MS = 2500;

/** Shorter than this matches most of the disk, which is not an answer. */
export const MACHINE_SEARCH_MIN_QUERY = 2;

/**
 * Whether this machine can answer at all, and why not when it cannot.
 *
 * Returned to the renderer rather than thrown, because "your platform has no
 * index for this" is a fact to show once under the results, not an error state
 * for a search that otherwise worked.
 */
export function machineSearchAvailability(platformName = platform()) {
  if (platformName === "darwin") return { available: true, reason: null };
  return {
    available: false,
    reason: "Searching the whole machine uses Spotlight, which is macOS only.",
  };
}

/**
 * The argument array `mdfind` is given.
 *
 * Exported for its own sake: that the query lands as one argv entry — never
 * interpolated, never a flag — is the security property of this file, and it
 * is checkable here without a Mac.
 */
export function spotlightArgs(query, root) {
  // `-name` rather than a free-text query: a person typing in a file search
  // means the name, and full-text would return every document mentioning it.
  return ["-onlyin", root, "-name", query];
}

/** Trimmed, or null when it is not worth asking. */
export function machineSearchQuery(raw) {
  const query = typeof raw === "string" ? raw.trim() : "";
  if (query.length < MACHINE_SEARCH_MIN_QUERY || query.length > 200) return null;
  // A leading dash would be read as a flag however it is quoted.
  if (query.startsWith("-")) return null;
  return query;
}

/**
 * The paths `mdfind` printed, in order, capped.
 *
 * Pure, so the parsing is testable without spawning anything: one path per
 * line, blanks dropped, and only absolute paths kept — a relative line is not
 * something this ever emits, and acting on one would be acting on a path
 * resolved against whatever the gateway's working directory happens to be.
 */
export function parseSpotlightOutput(stdout, limit = MACHINE_SEARCH_LIMIT) {
  return String(stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"))
    .slice(0, limit);
}

/**
 * Ask the machine.
 *
 * `spawnImpl` and `availability` are injected so the whole path — including the
 * timeout and the kill — can be exercised in a test without Spotlight and
 * without a Mac.
 */
export async function searchMachine(rawQuery, options = {}) {
  const {
    root = homedir(),
    limit = MACHINE_SEARCH_LIMIT,
    timeoutMs = MACHINE_SEARCH_TIMEOUT_MS,
    spawnImpl = spawn,
    statImpl = stat,
    availability = machineSearchAvailability(),
  } = options;

  if (!availability.available) return { available: false, reason: availability.reason, results: [] };

  const query = machineSearchQuery(rawQuery);
  if (!query) return { available: true, reason: null, results: [] };

  const stdout = await new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawnImpl("/usr/bin/mdfind", spotlightArgs(query, root), { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // No Spotlight binary on a machine that claimed to be macOS. Nothing
      // found is the honest answer; it is not the renderer's problem.
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* Already gone. */
      }
      resolve(output);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      output += chunk;
      // Enough lines to fill the answer; the rest is work nobody will read.
      if (output.length > 64_000) {
        clearTimeout(timer);
        try {
          child.kill("SIGKILL");
        } catch {
          /* Already gone. */
        }
        resolve(output);
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(output);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });

  const paths = parseSpotlightOutput(stdout, limit);
  const results = [];
  for (const path of paths) {
    try {
      const entry = await statImpl(path);
      results.push({ path, name: basename(path), directory: entry.isDirectory() });
    } catch {
      // The index is a snapshot; a file deleted since it was written is not a
      // result, and it is not an error either.
    }
  }
  return { available: true, reason: null, results };
}
