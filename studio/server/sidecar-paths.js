/**
 * Where voice-runtime/ actually is, in a checkout and in a packaged app.
 *
 * The sidecar ships as an extraResource BESIDE the asar, because onnxruntime's
 * native binding cannot be loaded out of an archive. That puts it one level
 * further out than a checkout does:
 *
 *   checkout    studio/server/  →  ../voice-runtime         (inside the package)
 *   packaged    app.asar/server/ →  <Resources>/voice-runtime (outside the asar)
 *
 * No single relative specifier serves both, which is why `import
 * "../voice-runtime/lexicon.js"` threw ERR_MODULE_NOT_FOUND in every packaged
 * build, took server/gateway.js down as it loaded, and left v0.0.1 with no
 * backend at all. It cannot be fixed in electron-builder's `files` either: a
 * pattern whose source is also an extraResources `from:` is dropped.
 *
 * electron/main.cjs already resolves cli.js this way. This is the same rule,
 * shared, and taking its inputs as arguments so both layouts can be tested
 * from either one.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The path a voice-runtime file should be read from.
 *
 * `resourcesPath` is Electron's `process.resourcesPath`, absent when the
 * gateway runs as its own process under plain node — in which case only the
 * checkout layout can be right anyway.
 *
 * Returns null when neither layout has the file, so a caller degrades instead
 * of importing a path that does not exist. The old static import could not:
 * a missing file was a module-load throw, and it took the whole gateway with it.
 */
export function voiceRuntimeFile(
  name,
  { here = HERE, resourcesPath = process.resourcesPath, exists = existsSync } = {},
) {
  const candidates = [path.join(here, "..", "voice-runtime", name)];
  if (resourcesPath) candidates.push(path.join(resourcesPath, "voice-runtime", name));
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** The same path as a file:// URL, for `import()`. Null when there is none. */
export function voiceRuntimeUrl(name, options) {
  const found = voiceRuntimeFile(name, options);
  return found ? pathToFileURL(found).href : null;
}
