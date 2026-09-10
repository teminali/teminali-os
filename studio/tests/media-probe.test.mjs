/*
  What a media file holds, and how it will be played.

  The pane asks this before it points an element anywhere, so the decisions
  are worth pinning: a container Chromium cannot demux must not be handed to
  it, a file it *can* play must not be pushed through ffmpeg for nothing, and
  10-bit H.264 — a codec whose name is on the native list but which Chromium
  cannot decode — must not be mistaken for playable. The ffmpeg line is built
  here rather than typed in a pane so a fragmented-MP4 flag cannot go missing.
*/
import test from "node:test";
import assert from "node:assert/strict";

import {
  NATIVE_CONTAINERS, playbackPlan, subtitleArgs, summariseProbe, transcodeArgs, transcodeHeaders,
} from "../server/media-probe.js";

const h264 = { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p", avg_frame_rate: "24000/1001" };
const hevc = { codec_type: "video", codec_name: "hevc", width: 3840, height: 2160, pix_fmt: "yuv420p10le", avg_frame_rate: "25/1" };
const aac = { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" };
const ac3 = { codec_type: "audio", codec_name: "ac3", channels: 6, sample_rate: "48000" };

function probe(streams, path = "film.mkv", duration = "1200.5") {
  return summariseProbe({ streams, format: { format_name: "matroska", duration } }, path);
}

test("ffprobe's JSON is reduced to what the plan and the pane read", () => {
  const summary = probe([h264, aac, { codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng", title: "English" } }]);
  assert.equal(summary.container, ".mkv");
  assert.equal(summary.duration, 1200.5);
  assert.equal(summary.video.codec, "h264");
  assert.equal(summary.video.fps, 23.976);
  assert.equal(summary.audio.channels, 2);
  assert.deepEqual(summary.subtitles, [{ stream: 0, codec: "subrip", language: "eng", title: "English", text: true }]);
});

test("cover art is not the video stream", () => {
  // A music file's embedded picture is a video stream to ffprobe, and treating
  // it as one would re-encode an album cover instead of playing the song.
  const summary = probe([{ codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } }, { codec_type: "audio", codec_name: "flac" }], "song.flac");
  assert.equal(summary.video, null);
  assert.equal(summary.audio.codec, "flac");
});

test("a bitmap subtitle stream is marked as not text, because ffmpeg cannot write it as one", () => {
  const summary = probe([h264, aac, { codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle" }]);
  assert.equal(summary.subtitles[0].text, false);
});

test("what Chromium can already play is handed straight to it", () => {
  const plan = playbackPlan(probe([h264, aac], "film.mp4"), { ffmpeg: "/usr/bin/ffmpeg" });
  assert.equal(plan.mode, "direct");
  assert.ok(NATIVE_CONTAINERS.has(".mkv"), "Chromium demuxes Matroska; only the codecs inside decide");
  assert.equal(playbackPlan(probe([h264, aac], "film.mkv"), { ffmpeg: "/usr/bin/ffmpeg" }).mode, "direct");
});

test("a foreign codec is re-encoded and the reason names it", () => {
  const plan = playbackPlan(probe([hevc, ac3]), { ffmpeg: "/usr/bin/ffmpeg" });
  assert.equal(plan.mode, "transcode");
  assert.equal(plan.video, "h264");
  assert.equal(plan.audio, "aac");
  assert.match(plan.reason, /hevc/);
  assert.match(plan.reason, /ac3/);
});

test("a foreign container with playable streams is rewrapped, not re-encoded", () => {
  const plan = playbackPlan(probe([h264, aac], "clip.avi"), { ffmpeg: "/usr/bin/ffmpeg" });
  assert.equal(plan.mode, "remux");
  assert.equal(plan.video, "copy");
  assert.equal(plan.audio, "copy");
});

test("10-bit H.264 is on the native list by name and cannot be decoded", () => {
  const tenBit = { ...h264, pix_fmt: "yuv420p10le" };
  const plan = playbackPlan(probe([tenBit, aac], "film.mp4"), { ffmpeg: "/usr/bin/ffmpeg" });
  assert.equal(plan.mode, "transcode");
  assert.match(plan.reason, /10-bit/);
});

test("without ffmpeg the answer is what is missing and how to get it", () => {
  const plan = playbackPlan(probe([hevc, ac3]), { ffmpeg: null });
  assert.equal(plan.mode, "unplayable");
  assert.match(plan.reason, /brew install ffmpeg/);
});

test("no probe at all: a native container is Chromium's to judge, anything else needs ffmpeg", () => {
  assert.equal(playbackPlan(null, { ffmpeg: "/usr/bin/ffmpeg", path: "a.mp4" }).mode, "direct");
  assert.equal(playbackPlan(null, { ffmpeg: "/usr/bin/ffmpeg", path: "a.vob" }).mode, "transcode");
  assert.equal(playbackPlan(null, { ffmpeg: null, path: "a.vob" }).mode, "unplayable");
});

test("the ffmpeg line seeks before the input and writes a fragmented MP4", () => {
  const args = transcodeArgs({
    input: "/films/a.mkv", start: 90, plan: { mode: "transcode", video: "h264", audio: "aac" },
    videoArgs: ["-c:v", "libx264", "-crf", "23", "-preset", "veryfast"],
  });
  const line = args.join(" ");
  // Before -i, or ffmpeg decodes everything up to the seek point first.
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"));
  assert.match(line, /-movflags frag_keyframe\+empty_moov\+default_base_moof/, "a plain MP4 writes its index at the end and cannot be streamed");
  assert.match(line, /-f mp4 pipe:1/);
  assert.match(line, /-c:v libx264/);
  assert.match(line, /-c:a aac/);
  // Subtitles reach the player as text tracks, not burned into the picture.
  assert.ok(args.includes("-sn"));
});

test("a transcode with no probed encoder refuses rather than guessing a name", () => {
  /*
    The bundled ffmpeg is LGPL and has no libx264, the developer's Homebrew one
    does. A default here would be a line that works on one machine and is
    `Unknown encoder` on the other, which is the failure bundling was meant to
    end. See `docs/MEDIA_LICENSING.md`.
  */
  assert.throws(
    () => transcodeArgs({ input: "/films/a.mkv", start: 0, plan: { mode: "transcode", video: "h264", audio: "aac" } }),
    /videoArgs/,
  );
});

test("a remux copies both streams, and no seek means no -ss", () => {
  const args = transcodeArgs({ input: "/films/a.avi", start: 0, plan: { mode: "remux", video: "copy", audio: "copy" } });
  assert.ok(!args.includes("-ss"));
  assert.match(args.join(" "), /-c:v copy .*-c:a copy/);
});

test("an audio-only plan turns the video off rather than encoding silence", () => {
  const args = transcodeArgs({ input: "/a.wma", start: 0, plan: { mode: "transcode", video: null, audio: "aac" } });
  assert.ok(args.includes("-vn"));
  assert.equal(transcodeHeaders({ video: null }).ContentType ?? transcodeHeaders({ video: null })["Content-Type"], "audio/mp4");
});

test("a transcode advertises no ranges, because there is no file to seek in", () => {
  const headers = transcodeHeaders({ video: "h264" });
  assert.equal(headers["Content-Type"], "video/mp4");
  assert.equal(headers["Accept-Ranges"], "none");
  assert.ok(!("Content-Length" in headers));
});

test("a subtitle stream is written as WebVTT by its index among subtitles", () => {
  assert.deepEqual(subtitleArgs({ input: "/a.mkv", stream: 2 }).join(" ").includes("-map 0:s:2 -f webvtt pipe:1"), true);
});
