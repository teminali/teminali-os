/* ─────────────────────────────────────────────────────────────────────────────
   Which hardware video encoder to ask ffmpeg for.

   VideoToolbox is macOS only. Naming `h264_videotoolbox` on Windows is not a
   slower encode, it is `Unknown encoder` and the run dies — and hardware
   encoding is the sensible default, so an export that works on the Mac this
   was built on would fail outright on every Windows machine.

   The decision is PURE so it can be tested without an ffmpeg and without a
   Windows machine: the caller probes the binary and passes in what it actually
   has. Same division as `convertProgress.cjs` — the parsing and the deciding
   are testable under plain Node, the spawning is not.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Ordered best-first, per platform.
 *
 * On Windows NVENC beats QSV beats AMF for both quality and availability.
 * Linux has no entry on purpose: VAAPI needs a render node passed as a device
 * argument, which the call sites do not have, and guessing
 * `/dev/dri/renderD128` fails on exactly the machines that lack it. No entry
 * means software, which always works.
 */
const HW_CANDIDATES = {
  darwin: {
    h264: ["h264_videotoolbox"],
    hevc: ["hevc_videotoolbox"],
  },
  win32: {
    h264: ["h264_nvenc", "h264_qsv", "h264_amf"],
    hevc: ["hevc_nvenc", "hevc_qsv", "hevc_amf"],
  },
};

/**
 * The best hardware encoder for `codec` that this ffmpeg actually has, or
 * `null` when there is none and the caller should encode in software.
 *
 * @param {"h264"|"hevc"} codec
 * @param {string} platform  `process.platform` of the machine being decided for
 * @param {ReadonlySet<string>} available  what `parseEncoders` found
 * @returns {string|null}
 */
function pickHardwareEncoder(codec, platform, available) {
  const candidates = (HW_CANDIDATES[platform] || {})[codec] || [];
  return candidates.find((name) => available.has(name)) ?? null;
}

/**
 * Parse the encoder names out of `ffmpeg -encoders`.
 *
 * Lines look like ` V....D h264_nvenc           NVIDIA NVENC H.264 encoder`:
 * six capability flag characters, whitespace, then the name.
 *
 * The name is checked against a name SHAPE and not just taken as the second
 * column, because ffmpeg's own legend (` V..... = Video`) fits the flag
 * column exactly and would otherwise enter the set as an encoder called `=`.
 * Nothing downstream would use it — `pickHardwareEncoder` only ever asks
 * about names it already knows — but a lookup table with `=` in it is a
 * question somebody has to answer twice.
 *
 * @param {string} stdout
 * @returns {Set<string>}
 */
function parseEncoders(stdout) {
  const names = new Set();
  for (const line of String(stdout).split("\n")) {
    const match = /^\s*[A-Z.]{6}\s+([A-Za-z][A-Za-z0-9_.-]*)\s/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

module.exports = { HW_CANDIDATES, pickHardwareEncoder, parseEncoders };
