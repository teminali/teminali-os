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
} = require("../electron/hardwareEncoder.cjs");
const { fixedFfmpegDirs, ffmpegInstallHint } = require("../electron/mediaAccess.cjs");

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
