/* ═══════════════════════════════════════════════════════════════════
   The mac/Windows encoder seam, proven without a Windows machine.

   This exists because the failure it guards is not a slow export, it is
   a dead one: `h264_videotoolbox` on Windows is `Unknown encoder` and
   ffmpeg exits before the first frame. Nobody developing on a Mac can
   see that happen, and no amount of testing the export on a Mac would
   reveal it — which is exactly why the decision was made pure and the
   platform passed in rather than read.

   `findFfmpeg` is tested here too, for the same reason: it resolved
   four hardcoded POSIX paths and would have found nothing at all on
   Windows.
   ═══════════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  HW_CANDIDATES, pickHardwareEncoder, parseEncoders,
  pickSoftwareEncoder, pickVideoEncoder, encoderFamily, videoEncoderArgs,
} = require("../electron/hardwareEncoder.cjs");
const { fixedFfmpegDirs, ffmpegInstallHint, findFfmpeg } = require("../electron/mediaAccess.cjs");

/* A real `ffmpeg -encoders` table: the header ffmpeg prints, then rows
   in the shape it actually writes them. Trimmed to the rows that decide
   something, plus two that must NOT be mistaken for encoder names. */
const ENCODERS_TABLE = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder
 V....D hevc_videotoolbox    VideoToolbox H.265 Encoder
 V..... libx264              libx264 H.264 / AVC
 V..... libx265              libx265 H.265 / HEVC
 A..... aac                  AAC (Advanced Audio Coding)
`;

const WINDOWS_TABLE = `Encoders:
 V....D h264_qsv             H.264 / AVC (Intel Quick Sync Video)
 V....D h264_amf             AMD AMF H.264 Encoder
 V..... libx264              libx264 H.264 / AVC
`;

/* ── parseEncoders ─────────────────────────────────────────────── */

test("parseEncoders reads the names out of ffmpeg's table", () => {
  const names = parseEncoders(ENCODERS_TABLE);
  assert.ok(names.has("h264_videotoolbox"));
  assert.ok(names.has("hevc_videotoolbox"));
  assert.ok(names.has("libx264"));
  assert.ok(names.has("aac"));
});

test("parseEncoders ignores the legend above the table", () => {
  const names = parseEncoders(ENCODERS_TABLE);
  // "= Video" and "------" are not encoders, and a Set that contained
  // them would still behave correctly — but a name like "Encoders:"
  // reaching a `-c:v` argument would not.
  assert.ok(!names.has("Encoders:"));
  assert.ok(!names.has("------"));
  assert.ok(!names.has("="));
});

test("parseEncoders survives empty and junk input", () => {
  assert.equal(parseEncoders("").size, 0);
  assert.equal(parseEncoders("no table here\nat all\n").size, 0);
});

/* ── pickHardwareEncoder ───────────────────────────────────────── */

test("macOS picks VideoToolbox when ffmpeg has it", () => {
  const have = parseEncoders(ENCODERS_TABLE);
  assert.equal(pickHardwareEncoder("h264", "darwin", have), "h264_videotoolbox");
  assert.equal(pickHardwareEncoder("hevc", "darwin", have), "hevc_videotoolbox");
});

test("Windows never gets a VideoToolbox encoder, whatever ffmpeg reports", () => {
  // The exact regression: a Mac-shaped decision reaching a Windows box.
  const have = parseEncoders(ENCODERS_TABLE);
  assert.equal(pickHardwareEncoder("h264", "win32", have), null);
  assert.equal(pickHardwareEncoder("hevc", "win32", have), null);
});

test("Windows prefers NVENC, then QSV, then AMF", () => {
  const all = new Set(["h264_nvenc", "h264_qsv", "h264_amf"]);
  assert.equal(pickHardwareEncoder("h264", "win32", all), "h264_nvenc");

  // No NVIDIA card: QSV is next.
  const noNvidia = parseEncoders(WINDOWS_TABLE);
  assert.equal(pickHardwareEncoder("h264", "win32", noNvidia), "h264_qsv");

  // AMD only.
  assert.equal(pickHardwareEncoder("h264", "win32", new Set(["h264_amf"])), "h264_amf");
});

test("an ffmpeg with no hardware encoder falls back to software", () => {
  const software = new Set(["libx264", "libx265"]);
  assert.equal(pickHardwareEncoder("h264", "darwin", software), null);
  assert.equal(pickHardwareEncoder("h264", "win32", software), null);
});

test("Linux and unknown platforms always fall back to software", () => {
  // VAAPI needs a render node the call sites have not got. No entry is
  // the correct answer, not an oversight — assert it stays that way.
  const everything = new Set([...HW_CANDIDATES.darwin.h264, ...HW_CANDIDATES.win32.h264, "h264_vaapi"]);
  assert.equal(pickHardwareEncoder("h264", "linux", everything), null);
  assert.equal(pickHardwareEncoder("h264", "freebsd", everything), null);
  assert.equal(pickHardwareEncoder("h264", "", everything), null);
});

test("every candidate is codec-matched, so hevc never yields an h264 encoder", () => {
  for (const platform of Object.keys(HW_CANDIDATES)) {
    for (const codec of ["h264", "hevc"]) {
      for (const name of HW_CANDIDATES[platform][codec]) {
        assert.ok(name.startsWith(codec), `${name} is listed under ${codec}`);
      }
    }
  }
});

/* ── Finding ffmpeg at all ─────────────────────────────────────── */

test("the search list is platform-shaped, and Windows is not POSIX", () => {
  const dirs = fixedFfmpegDirs();
  assert.ok(dirs.length > 0, "some directory is always tried");
  if (process.platform === "win32") {
    // A list of /usr/bin on Windows is the bug this replaced.
    assert.ok(dirs.some((dir) => /ffmpeg|chocolatey|scoop|WinGet/i.test(dir)));
    for (const dir of dirs) assert.ok(!dir.startsWith("/"), `${dir} is not a POSIX path`);
  } else {
    for (const dir of dirs) assert.ok(path.isAbsolute(dir), `${dir} is absolute`);
  }
});

test("the install hint names a package manager the operator actually has", () => {
  const hint = ffmpegInstallHint();
  assert.ok(hint.includes("ffmpeg") || hint.includes("FFmpeg"));
  if (process.platform === "darwin") assert.match(hint, /brew/);
  if (process.platform === "win32") assert.match(hint, /winget/);
  // The regression: telling a Windows operator to run Homebrew.
  if (process.platform !== "darwin") assert.doesNotMatch(hint, /brew/);
});

/* ── The LGPL swap ──────────────────────────────────────────────────
   Since 2026-09-10 the product bundles an LGPL ffmpeg, which has no
   `libx264` and no `libx265` — they are GPL-only. A developer's
   Homebrew build has both. So neither name is safe to hardcode, and
   these are the decisions that keep an export alive on both machines.
   ─────────────────────────────────────────────────────────────────── */

const GPL_BUILD = new Set(["libx264", "libx265", "libopenh264", "aac"]);
const LGPL_BUILD = new Set(["libopenh264", "libkvazaar", "aac"]);
const LGPL_MINIMAL = new Set(["libopenh264", "aac"]);

test("a GPL ffmpeg keeps encoding exactly as it did before this table existed", () => {
  assert.equal(pickSoftwareEncoder("h264", GPL_BUILD), "libx264");
  assert.equal(pickSoftwareEncoder("hevc", GPL_BUILD), "libx265");
});

test("the bundled LGPL ffmpeg falls to the licence-clean encoders", () => {
  assert.equal(pickSoftwareEncoder("h264", LGPL_BUILD), "libopenh264");
  assert.equal(pickSoftwareEncoder("hevc", LGPL_BUILD), "libkvazaar");
});

test("hardware still beats software when it is there", () => {
  const mac = new Set([...LGPL_BUILD, "h264_videotoolbox", "hevc_videotoolbox"]);
  assert.equal(pickVideoEncoder({ codec: "h264", platform: "darwin", available: mac }), "h264_videotoolbox");
  assert.equal(
    pickVideoEncoder({ codec: "h264", platform: "darwin", available: mac, allowHardware: false }),
    "libopenh264",
    "a caller that wants a reproducible file must be able to refuse the GPU",
  );
});

test("an hevc request with no hevc encoder degrades to h264 rather than failing", () => {
  // An LGPL build without kvazaar on a machine with no hardware HEVC: the
  // choice is a file in the wrong codec or no file at all.
  assert.equal(pickVideoEncoder({ codec: "hevc", platform: "linux", available: LGPL_MINIMAL }), "libopenh264");
});

test("an ffmpeg that can encode nothing says so instead of naming something", () => {
  assert.equal(pickVideoEncoder({ codec: "h264", platform: "linux", available: new Set(["aac"]) }), null);
  assert.equal(pickVideoEncoder({ codec: "hevc", platform: "linux", available: new Set() }), null);
});

test("encoderFamily does not hand x264 flags to an encoder it has never seen", () => {
  assert.equal(encoderFamily("libx264"), "x26x");
  assert.equal(encoderFamily("libx265"), "x26x");
  assert.equal(encoderFamily("libopenh264"), "openh264");
  assert.equal(encoderFamily("libkvazaar"), "kvazaar");
  assert.equal(encoderFamily("h264_nvenc"), "hardware");
  assert.equal(encoderFamily("hevc_videotoolbox"), "hardware");
  assert.equal(encoderFamily("some_future_codec"), "unknown");
  assert.equal(encoderFamily(null), "unknown");
});

/* ── Phrasing quality per encoder ───────────────────────────────────
   The half the licence swap is most likely to be got wrong in: an
   encoder swap that changes only the NAME still dies, because
   `-preset`, `-crf` and `-tune` are x264/x265 private options and
   ffmpeg fails the run on one it does not recognise.
   ─────────────────────────────────────────────────────────────────── */

test("x264 gets the CRF and the preset it has always got", () => {
  assert.deepEqual(
    videoEncoderArgs({ encoder: "libx264", crf: 18, speed: "medium" }),
    ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p"],
  );
});

test("openh264 is given none of x264's private options", () => {
  const args = videoEncoderArgs({ encoder: "libopenh264", crf: 18, speed: "medium", profile: "high" });
  const line = args.join(" ");
  for (const dead of ["-crf", "-preset", "-tune", "-profile:v"]) {
    assert.ok(!args.includes(dead), `${dead} is not an openh264 option and ffmpeg exits rather than ignoring it`);
  }
  assert.match(line, /-b:v \d+k/, "a CRF request has to survive as a bitrate or the default 2Mbps looks it");
});

test("a CRF request becomes a bitrate that tracks quality and resolution", () => {
  const at = (crf, height) => Number(/-b:v (\d+)k/.exec(videoEncoderArgs({ encoder: "libopenh264", crf, height }).join(" "))[1]);
  assert.ok(at(18, 1080) > at(23, 1080), "a lower CRF is a higher quality and must cost more bits");
  assert.ok(at(18, 2160) > at(18, 1080), "4K at the same quality needs more bits than 1080p");
  assert.ok(at(18, 480) >= 400, "the floor keeps a small frame from being encoded at nothing");
});

test("kvazaar takes its preset inside its own parameter blob", () => {
  const args = videoEncoderArgs({ encoder: "libkvazaar", crf: 20, speed: "veryfast" });
  assert.ok(!args.includes("-preset"), "kvazaar has no -preset of its own");
  assert.equal(args[args.indexOf("-kvazaar-params") + 1], "preset=veryfast");
});

test("zerolatency reaches x264 as a tune and openh264 as frame skipping", () => {
  assert.ok(videoEncoderArgs({ encoder: "libx264", lowLatency: true }).join(" ").includes("-tune zerolatency"));
  const live = videoEncoderArgs({ encoder: "libopenh264", lowLatency: true });
  assert.ok(!live.includes("-tune"));
  assert.equal(live[live.indexOf("-allow_skip_frames") + 1], "1", "a live stream keeps up; a file keeps every frame");
  const file = videoEncoderArgs({ encoder: "libopenh264", crf: 18 });
  assert.equal(file[file.indexOf("-allow_skip_frames") + 1], "0");
});

test("a hardware encoder is never given a CRF", () => {
  const args = videoEncoderArgs({ encoder: "h264_videotoolbox", crf: 18, speed: "medium", bitrateKbps: 12000 });
  assert.ok(!args.includes("-crf"));
  assert.ok(!args.includes("-preset"));
  assert.ok(args.includes("-b:v") && args.includes("12000k"));
});

test("an explicit bitrate never joins a CRF, whichever encoder answers", () => {
  for (const encoder of ["libx264", "libopenh264", "libkvazaar"]) {
    const args = videoEncoderArgs({ encoder, crf: 18, bitrateKbps: 6000 });
    assert.ok(!args.includes("-crf"), `${encoder}: CRF and -b:v together let the last one silently win`);
    assert.ok(args.includes("6000k"));
  }
});

/* ── Which ffmpeg wins ──────────────────────────────────────────────
   The app ships one now, and a bundled copy that loses to whatever a
   package manager left on PATH is a bundle that changed nothing. The
   order is asserted rather than trusted because it is invisible on a
   developer's machine, where both exist and either would work.
   ─────────────────────────────────────────────────────────────────── */

const HAS = (...paths) => {
  const set = new Set(paths);
  return (candidate) => set.has(candidate);
};

test("the bundled ffmpeg beats one that is installed and one on PATH", () => {
  const bundled = path.join("/Apps/Teminali.app/Contents/Resources", "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const found = findFfmpeg({
    env: { PATH: "/usr/local/bin" },
    resourcesPath: "/Apps/Teminali.app/Contents/Resources",
    exists: HAS(bundled, "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"),
  });
  assert.equal(found, bundled);
});

test("FFMPEG_PATH still overrides the bundled copy", () => {
  // The LGPL build drops x264; this is how somebody gets their own back.
  const found = findFfmpeg({
    env: { FFMPEG_PATH: "/my/own/ffmpeg", PATH: "" },
    resourcesPath: "/Apps/Teminali.app/Contents/Resources",
    exists: HAS("/my/own/ffmpeg", path.join("/Apps/Teminali.app/Contents/Resources", "ffmpeg", "ffmpeg")),
  });
  assert.equal(found, "/my/own/ffmpeg");
});

test("with nothing bundled it falls back exactly as it did before", () => {
  const found = findFfmpeg({
    env: { PATH: "" },
    resourcesPath: undefined,
    exists: HAS("/opt/homebrew/bin/ffmpeg", "/usr/bin/ffmpeg"),
  });
  assert.ok(found && found.endsWith("ffmpeg"), "a checkout has no resourcesPath and must still find one");
});

test("no ffmpeg anywhere is null, not a path that does not exist", () => {
  assert.equal(findFfmpeg({ env: { PATH: "/usr/bin" }, resourcesPath: "/R", exists: () => false }), null);
});
