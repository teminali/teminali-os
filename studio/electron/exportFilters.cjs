/*
  The pure half of the exporter: argv and filter strings, and nothing that
  spawns, opens or writes.

  Separated from `videoExport.cjs` for the reason `hardwareEncoder.cjs` and
  `convertProgress.cjs` are separate — this is the part most likely to be
  wrong in a way nothing throws about. A misplaced `adelay` moves a line of
  narration half a second and ffmpeg still exits 0, so the strings are
  asserted as text by `tests/video-export.test.mjs`. Requiring electron here
  would put that beyond a plain `node --test`.
*/

const { encoderFamily, videoEncoderArgs } = require("./hardwareEncoder.cjs");

/**
 * The video encoder half of the ffmpeg argv.
 *
 * Pure, and exported, because every branch here is a decision that shows up
 * as a property of the finished file — the container, whether it plays on an
 * iPhone, whether the bitrate flag means anything at all — and those are
 * cheaper to assert than to discover in a player.
 *
 * `encoder` is the name the caller PROBED for, not a preference: since the
 * bundled ffmpeg is LGPL and has no `libx264`, there is no name this can
 * safely assume. `encoderProbe.chooseEncoder` produces it; a null means that
 * ffmpeg can encode nothing and the caller should not have got this far.
 */
function encoderArgs(options, encoder) {
  const { codec, bitrateMbps, height, superSpeed } = options;

  /*
    ProRes ignores `encoder` and `bitrateMbps` both: it is a constant-quality
    intra codec with no rate control to hand a number to, and no platform
    ships a hardware ProRes encoder ffmpeg can reach. Profile 3 is 422 HQ.
  */
  if (codec === "prores") {
    return ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"];
  }

  const family = encoderFamily(encoder);
  const hardware = family === "hardware";

  /*
    `hvc1` follows the ENCODER, not the request. Without it QuickTime and
    Safari refuse an HEVC file outright — they accept only that branding, and
    ffmpeg's default `hev1` is legal but unplayable on exactly the platforms
    most likely to open the export. Putting it on an H.264 stream is the same
    mistake in reverse, and that is reachable now: an LGPL ffmpeg with no
    kvazaar answers a request for HEVC with H.264.
  */
  const isHevc = /^(libx265|libkvazaar|hevc_)/.test(String(encoder));
  const tag = isHevc ? ["-tag:v", "hvc1"] : [];

  /*
    CRF is meaningless to a hardware encoder — VideoToolbox and NVENC take a
    bitrate — so a request for "quality" has to become a number. 40 Mbps
    above 2000 lines, 12 below, which is roughly where each stops being the
    limiting factor against a screen recording's flat colour. The same is true
    of openh264, but `videoEncoderArgs` derives that one from the CRF and the
    frame height rather than from this pair of constants.
  */
  const bitrateKbps = bitrateMbps
    ? bitrateMbps * 1000
    : hardware ? (height >= 2000 ? 40000 : 12000) : undefined;

  const turboHw = superSpeed && String(encoder).includes("videotoolbox") ? ["-realtime", "0"] : [];

  return [
    ...videoEncoderArgs({
      encoder,
      bitrateKbps,
      crf: bitrateKbps ? undefined : 18,
      speed: hardware ? undefined : (superSpeed ? "faster" : "medium"),
      height,
      pixFmt: "yuv420p",
    }),
    ...turboHw,
    ...tag,
  ];
}

/**
 * Shift pitch without changing duration.
 *
 * `asetrate` moves pitch and speed together; `atempo` then puts the speed
 * back. atempo only accepts 0.5–2.0 per instance, so a large shift is chained
 * — which is why this returns a list and not a string.
 */
function pitchShift(semitones) {
  const ratio = Math.pow(2, semitones / 12);
  const out = [`asetrate=48000*${ratio.toFixed(6)}`, "aresample=48000"];
  let remaining = 1 / ratio;
  while (remaining > 2) { out.push("atempo=2.0"); remaining /= 2; }
  while (remaining < 0.5) { out.push("atempo=0.5"); remaining /= 0.5; }
  out.push(`atempo=${remaining.toFixed(6)}`);
  return out;
}

const VOICE_EFFECTS = {
  deep: () => pitchShift(-5),
  high: () => pitchShift(5),
  robot: () => ["vibrato=f=32:d=0.9", "aecho=0.8:0.9:5:0.6"],
  echo: () => ["aecho=0.8:0.85:180|340:0.5|0.28"],
  telephone: () => ["highpass=f=400", "lowpass=f=3200", "volume=1.4"],
  stadium: () => ["aecho=0.7:0.85:420|780|1200:0.5|0.35|0.22", "lowpass=f=9000"],
};

/*
  A piecewise-linear gain curve, as one `volume` expression.

  `gte(t,a)*lt(t,b)` is 1 inside exactly one segment and 0 everywhere else, so
  the terms can simply be summed — no nesting, no `if()`, and a curve of any
  length stays one flat expression ffmpeg can evaluate per frame.
*/
function envelopeExpression(points) {
  const terms = [`lt(t,${(points[0].tMs / 1000).toFixed(4)})*${points[0].v.toFixed(4)}`];

  for (let k = 0; k < points.length - 1; k += 1) {
    const a = points[k].tMs / 1000;
    const b = points[k + 1].tMs / 1000;
    if (b <= a) continue; // two points on the same frame would divide by zero
    const va = points[k].v;
    const vb = points[k + 1].v;
    terms.push(
      `(gte(t,${a.toFixed(4)})*lt(t,${b.toFixed(4)}))`
      + `*(${va.toFixed(4)}+(${(vb - va).toFixed(4)})*(t-${a.toFixed(4)})/${(b - a).toFixed(4)})`,
    );
  }

  const last = points[points.length - 1];
  terms.push(`gte(t,${(last.tMs / 1000).toFixed(4)})*${last.v.toFixed(4)}`);
  return `volume=volume='${terms.join("+")}':eval=frame`;
}

function speedStages(speed) {
  const stages = [];
  let remaining = speed;
  while (remaining > 2) { stages.push("atempo=2.0000"); remaining /= 2; }
  while (remaining < 0.5) { stages.push("atempo=0.5000"); remaining /= 0.5; }
  stages.push(`atempo=${remaining.toFixed(4)}`);
  return stages;
}

/**
 * The whole second-pass argv: every clip as an input, one filter chain each,
 * and a bus that mixes them down.
 *
 * Pure and exported. The filter string is the part of this feature most
 * likely to be wrong in a way no exception reports — a misplaced `adelay`
 * moves a line of narration half a second and ffmpeg exits 0 — so it is
 * asserted as text.
 */
function mixArgsFor(clips, outPath) {
  const inputs = [];
  const filters = [];

  clips.forEach((clip, i) => {
    /*
      ffmpeg's default user agent is refused outright by some CDNs, and the
      403 arrives as an empty audio stream rather than an error — a silent
      export with a successful exit code.
    */
    if (/^https?:/.test(clip.mediaUrl)) {
      inputs.push("-user_agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        + "(KHTML, like Gecko) Chrome/132.0 Safari/537.36");
    }

    // Input-side `-ss`, so ffmpeg seeks the file rather than decoding and discarding.
    inputs.push("-ss", (clip.sourceStartMs / 1000).toFixed(3), "-i", clip.mediaUrl);

    const speed = clip.speed || 1;
    const chain = [];

    // Relative to the already-seeked input, so it starts at 0.
    chain.push(`atrim=0:${((clip.durationMs * speed) / 1000).toFixed(3)}`);

    /*
      After the trim and before the speed change: `areverse` buffers its whole
      input, so an untrimmed source would pull the entire file into memory.
    */
    if (clip.reversed) chain.push("areverse");
    if (speed !== 1) chain.push(...speedStages(speed));

    chain.push("asetpts=PTS-STARTPTS"); // everything below is clip-local time
    if (clip.noiseReduction) chain.push("afftdn=nf=-25");
    if (clip.pitch) chain.push(...pitchShift(clip.pitch));

    // After pitch, so a voice effect and a pitch shift stack rather than fight.
    const effect = VOICE_EFFECTS[clip.voiceEffect];
    if (effect) chain.push(...effect());

    /*
      An envelope REPLACES the static volume. The renderer has already
      multiplied the envelope through the track fader, so applying both would
      square it and a fader at 0.5 would land at 0.25.
    */
    const envelope = clip.volumeEnvelope;
    if (Array.isArray(envelope) && envelope.length >= 2) chain.push(envelopeExpression(envelope));
    else if (clip.volume !== 1) chain.push(`volume=${clip.volume.toFixed(3)}`);

    if (clip.fadeInMs > 0) chain.push(`afade=t=in:st=0:d=${(clip.fadeInMs / 1000).toFixed(3)}`);
    if (clip.fadeOutMs > 0) {
      /*
        `st` is measured on the TIMELINE duration, not the source duration:
        the fade has to end where the clip ends on the sequence, and a clip at
        2x speed consumes twice the source in the same span.
      */
      const st = Math.max(0, (clip.durationMs - clip.fadeOutMs) / 1000);
      chain.push(`afade=t=out:st=${st.toFixed(3)}:d=${(clip.fadeOutMs / 1000).toFixed(3)}`);
    }

    chain.push(`adelay=${Math.round(clip.startTimeMs)}:all=1`); // clip-local -> timeline
    chain.push("aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo");

    filters.push(`[${i}:a]${chain.join(",")}[a${i}]`);
  });

  const ducked = clips.map((c, i) => (c.ducking ? i : -1)).filter((i) => i >= 0);
  const keys = clips.map((_, i) => i).filter((i) => !ducked.includes(i));

  const label = (list) => list.map((i) => `[a${i}]`).join("");
  const flat = (list, name) =>
    `${label(list)}amix=inputs=${list.length}:dropout_transition=0:normalize=0${name}`;

  if (ducked.length > 0 && keys.length > 0) {
    /*
      Ducking: the key bus (dialogue, usually) compresses the ducked bus
      (music) as a sidechain. `asplit` because a filter output cannot feed two
      consumers, and the key bus is both the sidechain input and part of the
      final mix.
    */
    filters.push(flat(ducked, "[dbus]"));
    filters.push(flat(keys, "[kbus]"));
    filters.push("[kbus]asplit=2[kmix][kside]");
    filters.push("[dbus][kside]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=320:makeup=1[dcomp]");
    filters.push("[dcomp][kmix]amix=inputs=2:dropout_transition=0:normalize=0[out]");
  } else {
    /*
      `normalize=0` because amix otherwise divides by the input count: a
      timeline with one clip would come out at full level and the same clip
      beside three others at a quarter, purely from the mixer.
    */
    filters.push(flat(clips.map((_, i) => i), "[out]"));
  }

  return [
    "-y", "-nostdin", ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[out]", "-c:a", "aac", "-b:a", "320k", outPath,
  ];
}

module.exports = {
  encoderArgs, pitchShift, speedStages, envelopeExpression, mixArgsFor, VOICE_EFFECTS,
};
