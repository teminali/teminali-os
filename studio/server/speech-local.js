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

const run = promisify(execFile);

const WHISPER_BINARIES = ["whisper-cli", "whisper-cpp", "main"];
/**
 * A GUI app launched from Finder inherits launchd's PATH — /usr/bin:/bin:
 * /usr/sbin:/sbin — not the shell's. Homebrew puts whisper in /opt/homebrew/bin,
 * which is therefore invisible to the packaged build even when it is plainly
 * installed, and the status call then tells someone who has whisper that they
 * do not. Search the usual prefixes explicitly rather than trusting PATH.
 */
const BIN_SEARCH_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
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
      env: {
        ...process.env,
        PATH: [process.env.PATH, ...BIN_SEARCH_PATHS].filter(Boolean).join(path.delimiter),
      },
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
    voices = stdout
      .split("\n")
      .map((line) => /^(\S[^\s]*(?:\s\S+)?)\s+([a-z]{2}[-_][A-Z]{2})\s/.exec(line))
      .filter(Boolean)
      .map((match) => ({ name: match[1].trim(), language: match[2].replace("_", "-") }));
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
 */
export async function transcribeLocal(buffer, { language = "auto" } = {}) {
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
        "-nt",                 // no timestamps in the plain text
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

/** Best installed voice for a language tag, or null for the system default. */
export function pickVoice(voices, languageTag) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const tag = String(languageTag || "").replace("_", "-");
  const exact = voices.find((entry) => entry.language.toLowerCase() === tag.toLowerCase());
  if (exact) return exact.name;
  const prefix = tag.split("-")[0].toLowerCase();
  const sameLanguage = voices.find((entry) => entry.language.toLowerCase().startsWith(prefix));
  return sameLanguage ? sameLanguage.name : null;
}
