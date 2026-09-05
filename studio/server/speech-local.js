/**
 * Local speech engine — whisper.cpp for recognition, macOS `say` for synthesis.
 *
 * Why this exists at all: the browser's Web Speech API does not work inside
 * Electron. Chromium's implementation calls Google's speech service using an
 * API key that Chrome ships and Electron does not, so `SpeechRecognition`
 * constructs fine and then fails at runtime with a bare `network` error. Voice
 * in the desktop build therefore *cannot* rely on it, and the honest fix is an
 * engine that runs on this machine.
 *
 * whisper.cpp gives us that: multilingual (Kiswahili included), Metal
 * accelerated, no network, no per-token cost. `say` covers synthesis with the
 * system voices the operator already has installed.
 *
 * Nothing here downloads anything. If the binary or the model is missing, the
 * status call reports exactly what is absent and how to install it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withBinPaths } from "./bin-paths.js";

const run = promisify(execFile);

const WHISPER_BINARIES = ["whisper-cli", "whisper-cpp", "main"];
const MODEL_SEARCH_PATHS = [
  path.join(os.homedir(), ".cache/whisper"),
  path.join(os.homedir(), ".local/share/whisper"),
  "/opt/homebrew/share/whisper-cpp",
  "/usr/local/share/whisper-cpp",
];
/** Preferred first: quality per second of audio, on a laptop. */
const MODEL_PREFERENCE = [
  "ggml-large-v3-turbo.bin", "ggml-medium.bin", "ggml-small.bin",
  "ggml-base.bin", "ggml-tiny.bin", "ggml-base.en.bin", "ggml-small.en.bin", "ggml-tiny.en.bin",
];

const TRANSCRIBE_TIMEOUT_MS = 120_000;
const SPEAK_TIMEOUT_MS = 60_000;

async function which(binary) {
  try {
    const { stdout } = await run("which", [binary], {
      timeout: 3000,
      encoding: "utf8",
      env: withBinPaths(),
    });
    const resolved = stdout.trim();
    return resolved || null;
  } catch {
    return null;
  }
}

async function exists(file) {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

let cached = null;

/** Locate the binary and the best available model. Cached; the paths do not move. */
export async function localAsrStatus({ force = false } = {}) {
  if (cached && !force) return cached;

  let binary = null;
  for (const candidate of WHISPER_BINARIES) {
    binary = await which(candidate);
    if (binary) break;
  }
  if (!binary) {
    cached = {
      available: false,
      detail: "whisper.cpp is not installed. `brew install whisper-cpp` enables fully local transcription.",
    };
    return cached;
  }

  let model = null;
  for (const directory of MODEL_SEARCH_PATHS) {
    for (const name of MODEL_PREFERENCE) {
      const candidate = path.join(directory, name);
      if (await exists(candidate)) {
        model = candidate;
        break;
      }
    }
    if (model) break;
  }
  if (!model) {
    cached = {
      available: false,
      binary,
      detail: `whisper.cpp is installed but no ggml model was found. Place one in ${MODEL_SEARCH_PATHS[0]}.`,
    };
    return cached;
  }

  // A `.en` model cannot do anything but English; say so rather than letting
  // someone select Kiswahili and get nonsense back.
  const englishOnly = /\.en\.bin$/.test(model);
  const ffmpeg = await which("ffmpeg");

  cached = {
    available: true,
    binary,
    model,
    modelName: path.basename(model),
    multilingual: !englishOnly,
    ffmpeg,
    detail: englishOnly
      ? "The installed whisper model is English-only. Install a multilingual model for other languages."
      : null,
  };
  return cached;
}

/** macOS speech synthesis. Local, offline, and already installed. */
export async function localTtsStatus() {
  if (process.platform !== "darwin") {
    return { available: false, detail: "Local synthesis currently requires macOS." };
  }
  const binary = await which("say");
  if (!binary) return { available: false, detail: "The macOS `say` command was not found." };

  let voices = [];
  try {
    const { stdout } = await run("say", ["-v", "?"], { timeout: 5000, encoding: "utf8", maxBuffer: 1024 * 1024 });
    // `say` pads the name into a column, but a long name leaves a single space
    // before the tag, and every voice Apple has shipped since the novelty era
    // carries parentheses in its name ("Samantha (English (US))"). The previous
    // pattern accepted at most two whitespace-free words, so it dropped 113 of
    // this machine's 187 voices — including every usable one — and left en-US
    // holding nothing but "Albert" and its joke siblings. Anchor on the
    // language tag and the `#` example instead: that parses all 187.
    const seen = new Set();
    voices = stdout
      .split("\n")
      .map((line) => /^(.+?)\s+([a-z]{2,3}[-_][A-Za-z0-9]{2,3})\s+#/.exec(line))
      .filter(Boolean)
      .map((match) => ({ name: match[1].trim(), language: match[2].replace("_", "-") }))
      // macOS lists a voice once per installed quality tier, under one name.
      .filter((voice) => {
        const key = `${voice.name}\u0000${voice.language}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  } catch {
    /* Voice list is a nicety; synthesis still works with the system default. */
  }
  return { available: true, binary, voices, detail: null };
}

/**
 * Transcribe an audio buffer.
 *
 * whisper.cpp only reads 16 kHz mono WAV, and the renderer may send WebM/Opus,
 * so anything that is not already a WAV goes through ffmpeg first. When ffmpeg
 * is missing and the input is not WAV, that is reported rather than producing
 * an empty transcript.
 *
 * @param maxSegmentChars split the transcript into segments of at most this
 *   many characters, for a caller laying SUBTITLES down. 0 leaves whisper's
 *   own segmentation, which is one cue per utterance and too long to read.
 */
export async function transcribeLocal(buffer, { language = "auto", maxSegmentChars = 0 } = {}) {
  const status = await localAsrStatus();
  if (!status.available) {
    throw Object.assign(new Error(status.detail), { status: 503, code: "LOCAL_ASR_UNAVAILABLE" });
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "teminali-asr-"));
  const inputPath = path.join(directory, "input.audio");
  const wavPath = path.join(directory, "input.wav");
  const outputBase = path.join(directory, "out");

  try {
    await writeFile(inputPath, buffer);

    const isWav = buffer.length > 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF";
    if (isWav) {
      await writeFile(wavPath, buffer);
    } else if (status.ffmpeg) {
      // 16 kHz mono PCM is exactly what the model expects; resampling here is
      // cheaper and more predictable than asking whisper to cope.
      await run(status.ffmpeg, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath], {
        timeout: 30_000,
      });
    } else {
      throw Object.assign(new Error("ffmpeg is required to transcribe compressed audio. `brew install ffmpeg`."), {
        status: 503, code: "FFMPEG_REQUIRED",
      });
    }

    const wanted = language === "auto" ? "auto" : String(language).split("-")[0];
    const requested = status.multilingual ? wanted : "en";

    await run(
      status.binary,
      [
        "-m", status.model,
        "-f", wavPath,
        "-l", requested,
        "-oj",                 // JSON output, so we get the detected language too
        "-of", outputBase,
        /*
          `-nt` used to be here and had to go. It is documented as
          suppressing timestamps in the PLAIN TEXT output, which this
          code does not read — but it also collapses the JSON to a
          single segment spanning the whole 30-second decode window.
          Measured on this machine: a 3.8s utterance came back as one
          cue with `offsets` 0..30000. Every one of those numbers was
          invented, and a caption track built on them would have sat on
          screen for half a minute. Without the flag the same utterance
          reports 0..3840, which is what the audio actually is.
        */
        ...(maxSegmentChars > 0 ? ["-ml", String(maxSegmentChars)] : []),
        "-t", String(Math.max(2, Math.min(8, os.cpus().length - 2))),
      ],
      { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );

    const raw = await readFile(`${outputBase}.json`, "utf8");
    const parsed = JSON.parse(raw);
    return parseWhisperJson(parsed, requested);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Pull the transcript and detected language out of whisper.cpp's JSON.
 * Split out from the shelling-out so it can be tested against a fixture.
 */
export function parseWhisperJson(parsed, requestedLanguage = "auto") {
  const segments = Array.isArray(parsed?.transcription) ? parsed.transcription : [];
  const text = segments
    .map((segment) => String(segment?.text ?? ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  /*
    The timings, which this function used to throw away.

    `offsets` is whisper.cpp's own millisecond pair and is the only
    reason subtitles are possible at all — the `timestamps` field beside
    it is the same numbers formatted for a human, and reparsing a string
    we already have as a number would be silly. A segment with no text
    is dropped rather than laid down as an empty cue.
  */
  const cues = segments
    .map((segment) => ({
      startMs: Math.max(0, Math.round(Number(segment?.offsets?.from ?? NaN))),
      endMs: Math.max(0, Math.round(Number(segment?.offsets?.to ?? NaN))),
      text: String(segment?.text ?? "").trim(),
    }))
    .filter((cue) => cue.text.length > 0 && Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs)
      && cue.endMs > cue.startMs);

  const detected = parsed?.result?.language ?? null;
  // whisper.cpp reports a bare ISO-639-1 code; the studio speaks BCP-47.
  const language = detected
    ? detected
    : requestedLanguage === "auto"
      ? ""
      : requestedLanguage;

  return {
    text,
    language,
    // whisper.cpp does not expose a confidence in this output mode; -1 is the
    // agreed "not reported" value rather than a fabricated number.
    confidence: -1,
    model: parsed?.model?.type ?? null,
    segments: cues,
  };
}

/** Synthesise speech to a WAV buffer using the system voice. */
export async function speakLocal(text, { language = "en-US", voice = null, rate = 1 } = {}) {
  const status = await localTtsStatus();
  if (!status.available) {
    throw Object.assign(new Error(status.detail), { status: 503, code: "LOCAL_TTS_UNAVAILABLE" });
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "teminali-tts-"));
  const outputPath = path.join(directory, "speech.wav");

  try {
    const chosen = voice ?? pickVoice(status.voices, language);
    // `say` speaks in words per minute; 175 is its default, and the studio's
    // rate is a multiplier around that.
    const wordsPerMinute = Math.round(Math.max(90, Math.min(400, 175 * (Number(rate) || 1))));

    const args = ["-o", outputPath, "--data-format=LEI16@22050", "-r", String(wordsPerMinute)];
    if (chosen) args.push("-v", chosen);
    args.push(text);

    await run(status.binary, args, { timeout: SPEAK_TIMEOUT_MS });
    return { body: await readFile(outputPath), contentType: "audio/wav", voice: chosen };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Voices macOS ships as jokes. `say` speaks with them perfectly happily, so a
 * picker that takes the first match for a language lands on "Albert" for
 * en-US — a wheezing cartoon — which is what made the desktop voice sound
 * robotic. Kept in step with NOVELTY_VOICES in
 * src/services/voice/providers/webSpeech.ts: the two tiers should not disagree
 * about which voices are unusable.
 */
const NOVELTY_VOICES = new Set([
  "albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos",
  "deranged", "good news", "hysterical", "jester", "organ", "pipe organ",
  "princess", "superstar", "trinoids", "whisper", "wobble", "zarvox",
]);

/**
 * Eloquence, and the MacinTalk voices that predate the Vocalizer downloads.
 * Not jokes: macOS files them under a language, a screen-reader user may
 * genuinely prefer them, and they are perfectly intelligible. They are also
 * flat and synthetic next to anything newer, so they lose to a real voice
 * without being banned outright.
 *
 * "Alex" is deliberately absent from both sets. It was on the novelty list
 * inherited from the client, which is simply wrong — it is Apple's flagship
 * US male voice and the largest voice asset macOS offers at 885 MB. Scoring
 * it out meant that an operator who downloaded the best male voice on the
 * platform would have found the assistant refusing to use it.
 */
const LEGACY_VOICES = new Set([
  "eddy", "flo", "grandma", "grandpa", "reed", "rocko", "sandy", "shelley",
  "agnes", "bruce", "fred", "junior", "kathy", "ralph", "vicki", "victoria",
]);

function matchesVoiceSet(name, set) {
  const lower = name.toLowerCase();
  for (const entry of set) {
    if (lower.includes(entry)) return true;
  }
  return false;
}

function isNoveltyVoice(name) {
  return matchesVoiceSet(name, NOVELTY_VOICES);
}

function isLegacyVoice(name) {
  return matchesVoiceSet(name, LEGACY_VOICES);
}

/**
 * How good the voice sounds, from the tier macOS puts in the name.
 *
 * The gap between tiers is larger than the gap between regional accents, so
 * these are weighted to let an Enhanced or Premium voice win across a region
 * boundary (en-GB read to an en-US operator) while a merely ordinary one
 * cannot. An operator who has downloaded exactly one good voice should hear it.
 */
function voiceQualityScore(name) {
  const lower = name.toLowerCase();
  if (lower.includes("premium")) return 80;
  if (lower.includes("enhanced")) return 55;
  if (lower.includes("compact")) return -30;
  return 0;
}

/** Best installed voice for a language tag, or null for the system default. */
export function pickVoice(voices, languageTag) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const tag = String(languageTag || "").replace("_", "-").toLowerCase();
  const prefix = tag.split("-")[0];

  let best = null;
  for (const entry of voices) {
    const language = entry.language.toLowerCase();
    let score;
    if (language === tag) score = 100;
    else if (prefix && language.startsWith(prefix)) score = 50;
    else continue;

    score += voiceQualityScore(entry.name);
    // Enough to lose to any real voice, including one from another region,
    // but not enough to fall below zero: alone in its language it is still a
    // better answer than whatever `say` would have defaulted to.
    if (isLegacyVoice(entry.name)) score -= 60;
    if (isNoveltyVoice(entry.name)) score -= 1000;

    if (!best || score > best.score) best = { name: entry.name, score };
  }

  // Every candidate was a joke voice. The system default is a better answer
  // than deliberately choosing one of them.
  if (!best || best.score < 0) return null;
  return best.name;
}
