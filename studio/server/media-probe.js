/**
 * What a media file holds, and how the player can play it.
 *
 * Chromium's player demuxes a handful of containers and decodes a handful of
 * codecs, and the gateway's format table admits many more than that — `.mkv`
 * with HEVC inside, `.avi`, `.wmv`, a ProRes `.mov`. The honest answer for
 * those used to be a sentence naming the codec and an ffmpeg line. This module
 * is the other half of that answer: ffprobe says what is inside, `playbackPlan`
 * decides between handing the bytes straight to the element, remuxing them
 * into fragmented MP4 (the streams are fine, the container is not), or
 * re-encoding whichever stream Chromium cannot decode, and `transcodeArgs` is
 * the ffmpeg line, built once and tested rather than typed in a pane.
 *
 * Nothing here spawns anything unless asked: `playbackPlan` and
 * `transcodeArgs` are pure, `probeMedia` and `extractSubtitleVtt` run a binary
 * the caller has found. `findBinary` looks in the PATH *and* in Homebrew's
 * two prefixes, because a Finder-launched app inherits launchd's PATH, which
 * has neither.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, extname, join } from "node:path";

/** Containers Chromium demuxes on its own. Anything else needs ffmpeg even when the codecs are fine. */
export const NATIVE_CONTAINERS = new Set([
  ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".3gp", ".ogv", ".weba",
  ".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac", ".opus",
]);

/** ffprobe's names for what Chromium decodes. */
export const NATIVE_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1", "theora"]);
export const NATIVE_AUDIO_CODECS = new Set([
  "aac", "mp3", "opus", "vorbis", "flac",
  "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8", "pcm_s16be",
]);

/** Subtitle streams ffmpeg can write as WebVTT. Bitmap ones (PGS, DVD) cannot become text and are not listed. */
export const TEXT_SUBTITLE_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);

const HOMEBREW_BINS = ["/opt/homebrew/bin", "/usr/local/bin"];
const binaries = new Map();

/** An executable by name, from the PATH or a Homebrew prefix; null when absent. Cached per process. */
export async function findBinary(name, { env = process.env } = {}) {
  if (binaries.has(name)) return binaries.get(name);
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const pathVal = env[pathKey] || "";
  const pathDirs = String(pathVal).split(delimiter).filter(Boolean);
  const fixedDirs = process.platform === "win32"
    ? [
        join(env.ProgramFiles || "C:\\Program Files", "ffmpeg", "bin"),
        join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "ffmpeg", "bin"),
        join(env.LOCALAPPDATA || "", "Programs", "ffmpeg", "bin"),
        "C:\\ffmpeg\\bin",
        "C:\\ProgramData\\chocolatey\\bin",
      ].filter(Boolean)
    : HOMEBREW_BINS;
  const dirs = [...pathDirs, ...fixedDirs];
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ? env.PATHEXT.split(";").filter(Boolean) : [".exe", ".cmd", ".bat"])
    : [""];
  let found = null;
  for (const dir of dirs) {
    const candidateBase = join(dir, name);
    const candidateList = process.platform === "win32" && !extname(candidateBase)
      ? [candidateBase, ...extensions.map((ext) => candidateBase + ext.toLowerCase())]
      : [candidateBase];
    for (const candidate of candidateList) {
      try {
        await access(candidate, constants.X_OK);
        found = candidate;
        break;
      } catch {
        /* not here */
      }
    }
    if (found) break;
  }
  binaries.set(name, found);
  return found;
}

/** Both tools, or the nulls that say which is missing. */
export async function mediaTools(options) {
  const [ffmpeg, ffprobe] = await Promise.all([findBinary("ffmpeg", options), findBinary("ffprobe", options)]);
  return { ffmpeg, ffprobe };
}

/** Forget the cached lookups — for tests, and for a `brew install` mid-session. */
export function resetBinaryCache() {
  binaries.clear();
}

function run(binary, args, { maxBytes = 8 * 1024 * 1024, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out = [];
    const err = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(Buffer.concat(err).toString("utf8").trim() || `${basename(binary)} exited ${code}`));
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function frameRate(text) {
  if (typeof text !== "string") return null;
  const [num, den] = text.split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return Math.round((num / den) * 1000) / 1000;
}

/** ffprobe's JSON, reduced to what the plan and the pane read. Pure, so a fixture can drive it. */
export function summariseProbe(parsed, path) {
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1) ?? null;
  const audio = streams.find((stream) => stream.codec_type === "audio") ?? null;
  const subtitles = streams
    .filter((stream) => stream.codec_type === "subtitle")
    .map((stream, position) => ({
      /* The index among subtitle streams, which is what `-map 0:s:N` counts. */
      stream: position,
      codec: String(stream.codec_name || "").toLowerCase(),
      language: stream.tags?.language ? String(stream.tags.language) : null,
      title: stream.tags?.title ? String(stream.tags.title) : null,
      text: TEXT_SUBTITLE_CODECS.has(String(stream.codec_name || "").toLowerCase()),
    }));
  return {
    container: extname(path).toLowerCase(),
    format: parsed?.format?.format_name ? String(parsed.format.format_name) : null,
    duration: number(parsed?.format?.duration) ?? number(video?.duration) ?? number(audio?.duration),
    video: video
      ? {
        codec: String(video.codec_name || "").toLowerCase(),
        profile: video.profile ? String(video.profile) : null,
        width: number(video.width),
        height: number(video.height),
        fps: frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate),
        pixelFormat: video.pix_fmt ? String(video.pix_fmt) : null,
      }
      : null,
    audio: audio
      ? { codec: String(audio.codec_name || "").toLowerCase(), channels: number(audio.channels), sampleRate: number(audio.sample_rate) }
      : null,
    subtitles,
  };
}

/** Run ffprobe on one file. Null when the tool is missing or the file defeats it. */
export async function probeMedia(absolutePath, { ffprobe } = {}) {
  if (!ffprobe) return null;
  try {
    const json = await run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", absolutePath]);
    return summariseProbe(JSON.parse(json), absolutePath);
  } catch {
    return null;
  }
}

/**
 * Direct, remux, transcode, or nothing — and why, in words the pane can show.
 *
 * `probe` null means ffprobe is not installed (or failed): a native container
 * is handed straight to the element, which will say for itself if the codec
 * inside is foreign; anything else needs ffmpeg and the plan says so.
 * 10-bit H.264 is the one native-named codec Chromium does not decode, so the
 * pixel format is part of the decision, not only the codec name.
 */
export function playbackPlan(probe, { ffmpeg = null, path = "" } = {}) {
  const container = probe?.container ?? extname(path).toLowerCase();
  const nativeContainer = NATIVE_CONTAINERS.has(container);
  const hasFfmpeg = Boolean(ffmpeg);

  if (!probe) {
    if (nativeContainer) return { mode: "direct", video: null, audio: null, reason: "Chromium demuxes this container; without ffprobe the codecs inside are its to judge." };
    if (hasFfmpeg) return { mode: "transcode", video: "h264", audio: "aac", reason: `Chromium has no demuxer for ${container || "this container"}; ffmpeg re-encodes it live.` };
    return { mode: "unplayable", video: null, audio: null, reason: `Chromium has no demuxer for ${container || "this container"}, and ffmpeg is not installed to convert it. \`brew install ffmpeg\`.` };
  }

  const tenBit = probe.video?.pixelFormat ? /10|12|16/.test(probe.video.pixelFormat) : false;
  const videoNative = !probe.video || (NATIVE_VIDEO_CODECS.has(probe.video.codec) && !(probe.video.codec === "h264" && tenBit));
  const audioNative = !probe.audio || NATIVE_AUDIO_CODECS.has(probe.audio.codec);

  if (nativeContainer && videoNative && audioNative) {
    return { mode: "direct", video: null, audio: null, reason: "Chromium plays this file as it is." };
  }

  const foreign = [
    probe.video && !videoNative ? `${probe.video.codec}${tenBit ? " 10-bit" : ""} video` : null,
    probe.audio && !audioNative ? `${probe.audio.codec} audio` : null,
    !nativeContainer ? `the ${container} container` : null,
  ].filter(Boolean).join(", ");

  if (!hasFfmpeg) {
    return { mode: "unplayable", video: null, audio: null, reason: `Chromium cannot play ${foreign}, and ffmpeg is not installed to convert it. \`brew install ffmpeg\`.` };
  }

  const video = probe.video ? (videoNative ? "copy" : "h264") : null;
  const audio = probe.audio ? (audioNative ? "copy" : "aac") : null;
  const mode = video !== "h264" && audio !== "aac" ? "remux" : "transcode";
  return {
    mode,
    video,
    audio,
    reason: mode === "remux"
      ? `The streams play as they are; ffmpeg rewraps ${foreign} into fragmented MP4 live.`
      : `ffmpeg re-encodes ${foreign} to H.264/AAC live.`,
  };
}

/**
 * The ffmpeg line for a live fragmented-MP4 stream from `start` seconds.
 *
 * `-ss` before `-i` so the seek is a demuxer seek, not a decode of everything
 * before it. `frag_keyframe+empty_moov+default_base_moof` is what lets the
 * element start before the file is finished — a plain MP4 writes its index at
 * the end. Subtitle and data streams are dropped: subtitles reach the player
 * as text tracks, through `extractSubtitleVtt`, not burned in. The first video
 * and first audio stream only, each optional, so an audio file and a silent
 * clip both produce something the element accepts.
 */
export function transcodeArgs({ input, start = 0, plan, hardware = null }) {
  const at = Number.isFinite(start) && start > 0 ? ["-ss", String(Math.max(0, start))] : [];
  const video = plan.video === null
    ? ["-vn"]
    : plan.video === "copy"
      ? ["-c:v", "copy"]
      : hardware === "videotoolbox"
        ? ["-c:v", "h264_videotoolbox", "-b:v", "6M", "-pix_fmt", "yuv420p", "-g", "48"]
        : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-profile:v", "high", "-g", "48"];
  const audio = plan.audio === null
    ? ["-an"]
    : plan.audio === "copy"
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-b:a", "160k", "-ac", "2"];
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    ...at,
    "-i", input,
    "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn",
    ...video,
    ...audio,
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "pipe:1",
  ];
}

/** The ffmpeg line that writes one embedded text subtitle stream as WebVTT to stdout. */
export function subtitleArgs({ input, stream }) {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", input, "-map", `0:s:${stream}`, "-f", "webvtt", "pipe:1"];
}

/** One embedded subtitle stream, as WebVTT text. Throws when ffmpeg is absent or the stream is not text. */
export async function extractSubtitleVtt(absolutePath, stream, { ffmpeg } = {}) {
  if (!ffmpeg) throw new Error("ffmpeg is not installed, so an embedded subtitle stream cannot be read out. `brew install ffmpeg`.");
  return run(ffmpeg, subtitleArgs({ input: absolutePath, stream }), { maxBytes: 5 * 1024 * 1024, timeoutMs: 60_000 });
}

/** The headers a live transcode answers with: a 200 with no length and no ranges, because there is no file. */
export function transcodeHeaders(plan) {
  return {
    "Content-Type": plan.video === null ? "audio/mp4" : "video/mp4",
    "Cache-Control": "no-store",
    "Accept-Ranges": "none",
  };
}
