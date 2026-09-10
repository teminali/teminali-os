/* ─────────────────────────────────────────────────────────────────────────────
   Which video encoder to ask ffmpeg for, and how to phrase quality to it.

   Two separate problems, both of which end in `Unknown encoder` or
   `Error setting option` when guessed:

   1. WHICH ENCODER EXISTS. VideoToolbox is macOS only. Naming
      `h264_videotoolbox` on Windows is not a slower encode, it is
      `Unknown encoder` and the run dies. Since 2026-09-10 the same is true of
      `libx264` and `libx265`: they are GPL-only, so the LGPL ffmpeg this
      product bundles (`docs/MEDIA_LICENSING.md`) does not have them, while the
      Homebrew build on a developer's machine does. Neither name is safe to
      hardcode.

   2. HOW TO ASK FOR QUALITY. `-preset`, `-crf` and `-tune` are x264/x265
      PRIVATE options. `libopenh264` — the LGPL replacement — has no CRF mode at
      all and rejects the other two, so an encoder swap that changes only the
      name still fails. Quality has to be phrased per encoder family, which is
      what `videoEncoderArgs` is for.

   The decision is PURE so it can be tested without an ffmpeg and without a
   Windows machine: the caller probes the binary (`encoderProbe.cjs`) and passes
   in what it actually has. Same division as `convertProgress.cjs` — the parsing
   and the deciding are testable under plain Node, the spawning is not.
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
 * Software encoders, ordered best-first.
 *
 * x264 and x265 stay FIRST on purpose, even though the bundled ffmpeg cannot
 * have them. Preferring them keeps an existing install — a Homebrew or distro
 * ffmpeg, which is GPL and has both — encoding exactly as it did before this
 * table existed, at the quality it did. The LGPL entries below them are what a
 * clean machine running the bundled binary gets.
 *
 * Invoking a GPL encoder inside an ffmpeg the USER installed is not a licence
 * problem: we neither ship nor link it. The obligation attaches to what is
 * distributed, and what is distributed is the LGPL build.
 *
 * `libopenh264` is Cisco's, BSD-2. `libkvazaar` is LGPL-2.1. Both are named in
 * `docs/MEDIA_LICENSING.md` as the sanctioned replacements.
 */
const SW_CANDIDATES = {
  h264: ["libx264", "libopenh264"],
  hevc: ["libx265", "libkvazaar"],
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
 * The best software encoder for `codec` that this ffmpeg actually has, or
 * `null` when it has none.
 *
 * @param {"h264"|"hevc"} codec
 * @param {ReadonlySet<string>} available  what `parseEncoders` found
 * @returns {string|null}
 */
function pickSoftwareEncoder(codec, available) {
  const candidates = SW_CANDIDATES[codec] || [];
  return candidates.find((name) => available.has(name)) ?? null;
}

/**
 * The encoder to use, all things considered: hardware when it is wanted and
 * present, else software, else — for HEVC only — H.264.
 *
 * The HEVC→H.264 degrade is deliberate. An LGPL ffmpeg built without kvazaar
 * on a machine with no hardware HEVC encoder has no way to make HEVC at all,
 * and the choice there is between a file in the wrong codec and no file. Every
 * player that opens the HEVC would open the H.264; the reverse is not true. The
 * caller is told which encoder came back so it can drop `-tag:v hvc1`, which is
 * meaningless on H.264 and confuses QuickTime.
 *
 * @param {object} options
 * @param {"h264"|"hevc"} options.codec
 * @param {string} options.platform
 * @param {ReadonlySet<string>} options.available
 * @param {boolean} [options.allowHardware]  false forces a software encode
 * @returns {string|null}  null only when this ffmpeg can encode neither
 */
function pickVideoEncoder({ codec, platform, available, allowHardware = true }) {
  const wanted = codec === "hevc" ? "hevc" : "h264";
  if (allowHardware) {
    const hw = pickHardwareEncoder(wanted, platform, available);
    if (hw) return hw;
  }
  const sw = pickSoftwareEncoder(wanted, available);
  if (sw) return sw;
  if (wanted === "hevc") {
    return pickVideoEncoder({ codec: "h264", platform, available, allowHardware });
  }
  return null;
}

/**
 * Which dialect of quality options an encoder speaks.
 *
 * Matched on the name rather than kept in a table so an encoder nobody has
 * listed yet — `libx264rgb`, a future `hevc_vulkan` — still lands somewhere
 * sensible instead of being handed x264 flags on the strength of being
 * unrecognised.
 *
 * @param {string} encoder
 * @returns {"x26x"|"openh264"|"kvazaar"|"hardware"|"unknown"}
 */
function encoderFamily(encoder) {
  const name = String(encoder || "");
  if (/^libx26[45]/.test(name)) return "x26x";
  if (name === "libopenh264") return "openh264";
  if (name === "libkvazaar") return "kvazaar";
  if (/_(videotoolbox|nvenc|qsv|amf|vaapi)$/.test(name)) return "hardware";
  return "unknown";
}

/**
 * A bitrate for an encoder that has no constant-quality mode.
 *
 * openh264 is bitrate-only, so a call site asking for `-crf 18` has to be
 * answered with a number. The mapping is an APPROXIMATION and is meant to be:
 * it converts a quality intent into the bitrate that usually reaches it at
 * 1080p, scaled by pixel count. CRF 18 → ~12 Mbps at 1080p, and each +6 on the
 * CRF scale is roughly half the bitrate, which is the relationship x264's own
 * rate control has.
 *
 * Erring high is deliberate — the failure this replaces was a file that did not
 * encode at all, and an oversized file is recoverable where a missing one is
 * not.
 *
 * @param {number} crf   on x264's 0–51 scale
 * @param {number} [height]  frame height; 1080 when the caller does not know
 * @returns {number} kbps
 */
function crfToBitrateKbps(crf, height = 1080) {
  const base = 12000 * Math.pow(2, (18 - Number(crf)) / 6);
  const scale = Math.max(0.15, Math.pow(Number(height) || 1080, 2) / (1080 * 1080));
  return Math.max(400, Math.round(base * scale));
}

/**
 * The full `-c:v …` argument list for one encoder at one quality.
 *
 * This is the function that makes an encoder swap safe. Every caller states
 * what it WANTS — a quality, a speed, a latency requirement — and this decides
 * how to say it to the encoder that is actually present. Options that a family
 * does not have are not translated and not passed; they are dropped, because
 * ffmpeg fails the run on an unrecognised private option rather than ignoring
 * it.
 *
 * @param {object} options
 * @param {string} options.encoder             the name `pickVideoEncoder` returned
 * @param {number} [options.crf]               constant-quality request, x264 scale
 * @param {number} [options.bitrateKbps]       explicit bitrate; wins over `crf`
 * @param {number} [options.maxrateKbps]
 * @param {number} [options.bufsizeKbps]
 * @param {string} [options.speed]             ultrafast|veryfast|faster|medium|…
 * @param {boolean} [options.lowLatency]       a live pipe, not a file
 * @param {string|null} [options.pixFmt]       null to leave the format alone
 * @param {string} [options.profile]
 * @param {number} [options.gop]
 * @param {number} [options.keyintMin]
 * @param {number} [options.height]            informs the CRF→bitrate fallback
 * @returns {string[]}
 */
function videoEncoderArgs(options = {}) {
  const {
    encoder, crf, bitrateKbps, maxrateKbps, bufsizeKbps, speed,
    lowLatency = false, pixFmt = "yuv420p", profile, gop, keyintMin, height,
  } = options;

  const family = encoderFamily(encoder);
  const args = ["-c:v", String(encoder)];

  /*
    Rate control first, because it is the one thing every family has in some
    form and the one thing a caller always means.
  */
  if (family === "x26x") {
    if (bitrateKbps) args.push("-b:v", `${Math.round(bitrateKbps)}k`);
    else if (Number.isFinite(crf)) args.push("-crf", String(crf));
    if (speed) args.push("-preset", String(speed));
    if (lowLatency) args.push("-tune", "zerolatency");
  } else {
    /*
      Everything else takes a bitrate and nothing else. A CRF request is
      converted rather than dropped: dropping it would leave ffmpeg on its own
      default, which for openh264 is 2 Mbps regardless of resolution and looks
      it.
    */
    const kbps = bitrateKbps ?? (Number.isFinite(crf) ? crfToBitrateKbps(crf, height) : null);
    if (kbps) args.push("-b:v", `${Math.round(kbps)}k`);
    /*
      kvazaar keeps its speed control inside its own parameter blob; openh264
      and the hardware encoders have no equivalent and are simply not told.
    */
    if (family === "kvazaar" && speed) args.push("-kvazaar-params", `preset=${speed}`);
    /*
      openh264 defaults to dropping frames when it misses the bitrate, which on
      a screen recording silently costs frames the recorder counted. A live
      stream wants the opposite: keeping up matters more than any one frame.
    */
    if (family === "openh264") args.push("-allow_skip_frames", lowLatency ? "1" : "0");
  }

  if (maxrateKbps) args.push("-maxrate", `${Math.round(maxrateKbps)}k`);
  if (bufsizeKbps) args.push("-bufsize", `${Math.round(bufsizeKbps)}k`);
  if (pixFmt) args.push("-pix_fmt", pixFmt);
  /*
    openh264's profile values are not x264's, and `high` is its default anyway,
    so the option is only passed to the families that share x264's spelling.
  */
  if (profile && (family === "x26x" || family === "hardware")) args.push("-profile:v", profile);
  if (gop) args.push("-g", String(gop));
  if (keyintMin) args.push("-keyint_min", String(keyintMin));
  return args;
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

module.exports = {
  HW_CANDIDATES, SW_CANDIDATES,
  pickHardwareEncoder, pickSoftwareEncoder, pickVideoEncoder,
  encoderFamily, crfToBitrateKbps, videoEncoderArgs,
  parseEncoders,
};
