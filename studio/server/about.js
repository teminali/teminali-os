/**
 * What this build is, and what it ships that somebody else wrote.
 *
 * The second half is not decoration. The installers carry an LGPL-2.1 FFmpeg
 * that we built ourselves (`scripts/build-media-stack.sh`), and §6 of that
 * licence is only satisfied when the shipped components are **named with their
 * versions** and the corresponding source is **offered**. A binary in
 * `<Resources>/ffmpeg` with nothing in the interface saying so is a licence
 * breach, which is why `docs/MEDIA_LICENSING.md` calls this surface the
 * shipping blocker rather than a nicety.
 *
 * Everything here is read from the bundle at runtime rather than compiled in.
 * The build script writes `manifest.json` beside the binaries it produced, so
 * the list cannot drift from what actually shipped: a version bumped in the
 * script and not here would otherwise make the About pane state a falsehood
 * about a file sitting two directories away. For the same reason the licence
 * texts are *listed*, not enumerated — `licences/` holds whatever the build
 * copied, and a hard-coded list would survive a component being dropped.
 *
 * A build made without the script ships no bundle at all, which every release
 * up to and including v0.0.6 did. That is a real answer, not an error:
 * `bundled: false` and an empty component list, and the pane says the app is
 * using an ffmpeg it found on the machine and did not build.
 */

import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { currentVersion } from "./releases.js";

/** The `extraResources` destinations the build script fills. Each may carry a manifest. */
export const MEDIA_STACK_BUNDLES = Object.freeze(["ffmpeg", "mpv"]);

/** The product's own name. One string, so a rename is one edit — see CLAUDE.md on the 0.0.1 reset. */
export const PRODUCT_NAME = "Teminali OS";

/** A licence file's size ceiling. GPLv3 is 35 kB; anything past this is not a licence. */
const LICENCE_MAX_BYTES = 512 * 1024;

function componentKey(component) {
  return `${String(component.name).toLowerCase()}@${component.version}`;
}

/**
 * One manifest's components, sanitised.
 *
 * Read off disk, so nothing is trusted: a component without a name is not a
 * disclosure and is dropped rather than rendered as an empty row.
 */
function readComponents(manifest) {
  if (!Array.isArray(manifest?.components)) return [];
  return manifest.components
    .filter((entry) => entry && typeof entry.name === "string" && entry.name.trim())
    .map((entry) => ({
      name: entry.name.trim(),
      version: typeof entry.version === "string" ? entry.version.trim() : null,
      licence: typeof entry.licence === "string" ? entry.licence.trim() : null,
    }));
}

/**
 * What the installers actually put in `<Resources>`.
 *
 * `resourcesPath` is Electron's and is undefined under plain Node, so a
 * checkout and the test suite answer `bundled: false` — which is the truth
 * there. `studio/media-stack/` is deliberately NOT consulted as a fallback: a
 * development run resolves ffmpeg off the PATH (`findFfmpeg` prefers
 * `resourcesPath` and there is none), so reporting the staged bundle would
 * name a binary the process is not using.
 */
export async function readMediaStack({
  resourcesPath = process.resourcesPath,
  bundles = MEDIA_STACK_BUNDLES,
  read = readFile,
  list = readdir,
} = {}) {
  const empty = {
    bundled: false,
    platform: null,
    builtAt: null,
    buildScript: null,
    sourceOffer: null,
    components: [],
    licences: [],
  };
  if (!resourcesPath) return empty;

  const seen = new Map();
  const licences = [];
  let platform = null;
  let builtAt = null;
  let buildScript = null;
  let sourceOffer = null;
  let bundled = false;

  for (const bundle of bundles) {
    let manifest;
    try {
      manifest = JSON.parse(await read(join(resourcesPath, bundle, "manifest.json"), "utf8"));
    } catch {
      /* No bundle here, or one this build cannot read. Either way it discloses nothing. */
      continue;
    }
    bundled = true;
    platform ??= typeof manifest.platform === "string" ? manifest.platform : null;
    builtAt ??= typeof manifest.builtAt === "string" ? manifest.builtAt : null;
    buildScript ??= typeof manifest.buildScript === "string" ? manifest.buildScript : null;
    sourceOffer ??= typeof manifest.sourceOffer === "string" && manifest.sourceOffer.trim()
      ? manifest.sourceOffer.trim()
      : null;

    /* Both bundles carry the same manifest, so the same component is listed
       twice. Keyed by name AND version: a duplicate name at a DIFFERENT version
       is two libraries and has to be disclosed as two. */
    for (const component of readComponents(manifest)) {
      const key = componentKey(component);
      if (!seen.has(key)) seen.set(key, component);
    }

    try {
      for (const file of await list(join(resourcesPath, bundle, "licences"))) {
        if (file.startsWith(".")) continue;
        licences.push({ bundle, file });
      }
    } catch {
      /* A bundle with no licences/ directory. `verify_bundle` will not ship one. */
    }
  }

  if (!bundled) return empty;
  return {
    bundled: true,
    platform,
    builtAt,
    buildScript,
    sourceOffer,
    components: [...seen.values()],
    licences: licences.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

/**
 * A licence text out of the bundle.
 *
 * The name is checked against the real directory listing rather than sanitised,
 * because sanitising a path is a game you eventually lose: `bundle` and `file`
 * only ever name something `readMediaStack` already found, so `../../` cannot
 * resolve to anything this returns.
 */
export async function readLicence(bundle, file, options = {}) {
  const { read = readFile, resourcesPath = process.resourcesPath } = options;
  const stack = await readMediaStack(options);
  const match = stack.licences.find((entry) => entry.bundle === bundle && entry.file === file);
  if (!match) return null;
  const text = await read(join(resourcesPath, match.bundle, "licences", basename(match.file)), "utf8");
  return text.length > LICENCE_MAX_BYTES ? text.slice(0, LICENCE_MAX_BYTES) : text;
}

/** The whole About payload: this build, and what it carries. */
export async function aboutPayload({ appRoot, ...options } = {}) {
  const [version, mediaStack] = await Promise.all([
    currentVersion(appRoot).catch(() => null),
    readMediaStack(options),
  ]);
  return {
    app: {
      name: PRODUCT_NAME,
      version,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      node: process.versions.node,
    },
    mediaStack,
  };
}
