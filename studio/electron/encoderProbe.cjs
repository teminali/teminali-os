/* ─────────────────────────────────────────────────────────────────────────────
   What THIS ffmpeg can encode with — asked once, answered from cache after.

   Split out of `videoExport.cjs`, which owned the only copy until the encoder
   names stopped being safe to hardcode. Five call sites now need the same
   answer (export, playback transcode, screen recording, live streaming, the
   workspace media tool) and a per-caller probe would be five process spawns
   for one fact that cannot change while the app is open.

   The impure half of the pair: `hardwareEncoder.cjs` decides, this one asks.
   Nothing here is worth a unit test that a spawn would not dominate; the
   decisions it feeds are all tested without it.
   ───────────────────────────────────────────────────────────────────────────── */

const { execFileSync } = require("node:child_process");
const {
  parseEncoders, pickVideoEncoder, videoEncoderArgs,
} = require("./hardwareEncoder.cjs");

/** Keyed by binary path: a bundled ffmpeg and a system one have different tables. */
const cache = new Map();

/**
 * The set of encoder names `ff` was built with.
 *
 * Cached for the life of the process: the binary does not grow encoders while
 * the app is open, and the probe costs a process spawn. A throw caches an
 * EMPTY set rather than nothing, because an ffmpeg that cannot answer
 * `-encoders` is simply one with nothing to offer — and re-asking a broken
 * binary once per export is a stall, not a recovery. A missing binary is the
 * one case that is NOT cached; there is nothing to learn from it and the path
 * may appear later.
 *
 * @param {string|null|undefined} ff
 * @returns {Set<string>}
 */
function availableEncoders(ff) {
  if (!ff) return new Set();
  const hit = cache.get(ff);
  if (hit) return hit;
  let names;
  try {
    const stdout = execFileSync(ff, ["-hide_banner", "-encoders"], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    names = parseEncoders(stdout);
  } catch {
    names = new Set();
  }
  cache.set(ff, names);
  return names;
}

/**
 * The encoder `ff` should use for `codec` on this machine.
 *
 * @param {"h264"|"hevc"} codec
 * @param {string|null} ff
 * @param {{ allowHardware?: boolean }} [options]
 * @returns {string|null}
 */
function chooseEncoder(codec, ff, options = {}) {
  return pickVideoEncoder({
    codec,
    platform: process.platform,
    available: availableEncoders(ff),
    allowHardware: options.allowHardware !== false,
  });
}

/**
 * `chooseEncoder` and `videoEncoderArgs` in one step, for the call sites that
 * want a line rather than a name.
 *
 * Returns `null` when this ffmpeg can encode neither H.264 nor HEVC, which the
 * caller must treat as "do not run" — an empty encoder list would silently
 * become ffmpeg's own default.
 *
 * @param {object} request  `videoEncoderArgs` options, minus `encoder`, plus
 *                          `codec` and the ffmpeg path as `ff`
 * @returns {{ encoder: string, args: string[] }|null}
 */
function encoderLine({ codec = "h264", ff, allowHardware = true, ...quality }) {
  const encoder = chooseEncoder(codec, ff, { allowHardware });
  if (!encoder) return null;
  return { encoder, args: videoEncoderArgs({ ...quality, encoder }) };
}

/** Test seam: forget what was probed. Never called in production. */
function resetEncoderCache() {
  cache.clear();
}

module.exports = { availableEncoders, chooseEncoder, encoderLine, resetEncoderCache };
