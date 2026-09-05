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

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withBinPaths } from "./bin-paths.js";
import { DOMAIN_TERMS, buildLexicon, repairVocabulary, vocabularyFromEnv } from "../voice-runtime/lexicon.js";

const run = promisify(execFile);

const WHISPER_BINARIES = ["whisper-cli", "whisper-cpp", "main"];
const MODEL_SEARCH_PATHS = [
  path.join(os.homedir(), ".cache/whisper"),
  path.join(os.homedir(), ".local/share/whisper"),
  "/opt/homebrew/share/whisper-cpp",
  "/usr/local/share/whisper-cpp",
];
/**
 * Preferred first: quality per second of audio, on a laptop. A quantised file
 * ranks with its parent — `-q8_0` is indistinguishable from fp16 by ear and
 * `-q5_0` nearly so — so the 874 MB turbo beats a 147 MB base rather than
 * being invisible because its filename carried a suffix.
 */
export const MODEL_PREFERENCE = [
  "ggml-large-v3-turbo.bin", "ggml-large-v3-turbo-q8_0.bin", "ggml-large-v3-turbo-q5_0.bin",
  "ggml-large-v3.bin", "ggml-large-v3-q5_0.bin",
  "ggml-medium.bin", "ggml-medium-q8_0.bin", "ggml-medium-q5_0.bin",
  "ggml-small.bin", "ggml-small-q8_0.bin", "ggml-small-q5_1.bin",
  "ggml-base.bin", "ggml-base-q8_0.bin", "ggml-base-q5_1.bin",
  "ggml-tiny.bin", "ggml-tiny-q8_0.bin", "ggml-tiny-q5_1.bin",
  "ggml-medium.en.bin", "ggml-small.en.bin", "ggml-base.en.bin", "ggml-tiny.en.bin",
];

/**
 * How good a Whisper is, by family, on a scale the sidecar's models share:
 * the gateway compares this against the sidecar's `whisper-base` to decide
 * which engine gets to listen. Higher is better.
 */
export function rankLocalModel(name) {
  const base = String(name ?? "").toLowerCase();
  if (/large-v3-turbo/.test(base)) return 5;
  if (/large/.test(base)) return 6;
  if (/medium/.test(base)) return 4;
  if (/small/.test(base)) return 3;
  if (/base/.test(base)) return 2;
  if (/tiny/.test(base)) return 1;
  return 0;
}

/** The domain vocabulary, once; the same list the sidecar repairs against. */
const VOCABULARY = [...DOMAIN_TERMS, ...vocabularyFromEnv()];
const LEXICON = buildLexicon(VOCABULARY);
/** Whisper's initial prompt is capped at half its text context; stay well inside it. */
const PROMPT_MAX_CHARS = 600;

/**
 * The words Whisper could not have known, handed to the decoder before it
 * hears anything. This is the `initial_prompt` the sidecar cannot pass (see
 * voice-runtime/lexicon.js); whisper.cpp takes it, and a recogniser told
 * "Teminali" is a word stops hearing it as "terminally".
 *
 * `hints` are the caller's — the open project's folder and file names — and
 * go first, because they are the words most likely to be said next.
 */
export function buildPrompt(hints = []) {
  const seen = new Set();
  const words = [];
  for (const term of [...hints, ...VOCABULARY]) {
    const clean = String(term ?? "").replace(/[\r\n,]+/g, " ").trim();
    if (!clean || clean.length > 48) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(clean);
  }
  let prompt = "";
  for (const word of words) {
    const next = prompt ? `${prompt}, ${word}` : word;
    if (next.length > PROMPT_MAX_CHARS) break;
    prompt = next;
  }
  return prompt ? `${prompt}.` : "";
}

/* ── whisper-server: the model loaded once, not once per utterance ──────── */

/**
 * `whisper-cli` pays for the model on every call. Measured here on an M4 Pro:
 * large-v3-turbo-q8_0 decodes a 5.7 s utterance in 1.02 s wall, of which the
 * decode is a fraction and the rest is reading 874 MB off disk and into Metal.
 * `whisper-server` (shipped by the same brew formula) holds the model warm, so
 * the per-utterance cost is the decode alone. The gateway starts one on demand,
 * keeps it for the life of the process, and falls back to the CLI when the
 * server is not installed or will not come up.
 */
const SERVER_PORT = Number(process.env.TEMINALI_WHISPER_SERVER_PORT) || 8323;
const SERVER_START_TIMEOUT_MS = 20_000;
let server = null;



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
  const englishOnly = /\.en(?:-q\d_\d)?\.bin$/.test(model);
  const ffmpeg = await which("ffmpeg");
  const serverBinary = await which("whisper-server");

  cached = {
    available: true,
    binary,
    serverBinary,
    model,
    modelName: path.basename(model),
    rank: rankLocalModel(path.basename(model)),
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
/** Start `whisper-server` once and wait until it answers; null when it cannot. */
async function ensureServer(status) {
  if (!status.serverBinary) return null;
  if (server?.model === status.model && !server.dead) return server;
  if (server && !server.dead) {
    try { server.child.kill(); } catch {}
  }
  const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
  const child = spawn(status.serverBinary, [
    "-m", status.model,
    "--host", "127.0.0.1",
    "--port", String(SERVER_PORT),
    "-t", threads,
    "-bs", "5", "-bo", "5",
  ], { stdio: ["ignore", "ignore", "pipe"], env: withBinPaths(process.env) });
  const entry = { child, model: status.model, dead: false, url: `http://127.0.0.1:${SERVER_PORT}/inference` };
  child.on("exit", () => { entry.dead = true; if (server === entry) server = null; });
  child.stderr?.on("data", () => undefined);
  server = entry;

  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline && !entry.dead) {
    try {
      const probe = await fetch(`http://127.0.0.1:${SERVER_PORT}/`, { signal: AbortSignal.timeout(500) });
      if (probe.status < 500) return entry;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  try { child.kill(); } catch {}
  entry.dead = true;
  if (server === entry) server = null;
  return null;
}

/** Stop a warm server, if one is running. Called on gateway shutdown. */
export function stopLocalAsr() {
  if (server && !server.dead) {
    try { server.child.kill(); } catch {}
  }
  server = null;
}

async function transcribeViaServer(entry, wavPath, { requested, prompt }) {
  const form = new FormData();
  form.append("file", new Blob([await readFile(wavPath)], { type: "audio/wav" }), "utterance.wav");
  form.append("language", requested);
  form.append("response_format", "verbose_json");
  if (prompt) form.append("prompt", prompt);
  const response = await fetch(entry.url, { method: "POST", body: form, signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`whisper-server answered ${response.status}`);
  return response.json();
}

export async function transcribeLocal(buffer, { language = "auto", maxSegmentChars = 0, hints = [] } = {}) {
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
    const prompt = buildPrompt(hints);

    // Caption segmentation (`-ml`) is a CLI-only option; a caller who wants
    // cue-sized segments gets the CLI. Everyone else gets the warm server.
    if (maxSegmentChars <= 0) {
      const warm = await ensureServer(status).catch(() => null);
      if (warm) {
        try {
          const parsed = await transcribeViaServer(warm, wavPath, { requested, prompt });
          const result = parseWhisperJson(parsed, requested);
          return { ...result, text: repairVocabulary(result.text, LEXICON) };
        } catch {
          // Fall through to the CLI: a server that has just died must not cost
          // the operator the sentence they said.
        }
      }
    }

    await run(
      status.binary,
      [
        "-m", status.model,
        "-f", wavPath,
        "-l", requested,
        /*
          `-ojf`, not `-oj`. The plain flag writes the transcript and the
          offsets and nothing else — measured on this machine, its JSON
          carries no probability of any kind, which is why `confidence`
          was hard-coded to -1 here for as long as it was. The full flag
          adds `transcription[].tokens[].p`, the per-token probability,
          at the cost of a larger file and no extra decoding. That is the
          only confidence the CLI can give: unlike the server it reports
          no language probability, so it cannot tell speech from silence.
        */
        "-ojf",                // full JSON: detected language *and* per-token probability
        "-of", outputBase,
        "-bs", "5", "-bo", "5",
        ...(prompt ? ["--prompt", prompt] : []),
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
    const result = parseWhisperJson(parsed, requested);
    return { ...result, text: repairVocabulary(result.text, LEXICON) };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Pull the transcript and detected language out of whisper.cpp's JSON.
 * Split out from the shelling-out so it can be tested against a fixture.
 */
/**
 * whisper.cpp says the language two different ways depending on which end of
 * it you ask: the CLI reports a bare ISO-639-1 code, the server the English
 * name. Only the languages this build advertises need mapping; anything else
 * falls through and the caller's own request stands.
 */
const LANGUAGE_NAMES = {
  english: "en", swahili: "sw", french: "fr", spanish: "es", german: "de",
  portuguese: "pt", italian: "it", arabic: "ar", hindi: "hi", chinese: "zh",
  japanese: "ja", korean: "ko", dutch: "nl", russian: "ru", turkish: "tr",
};

/**
 * The two JSON shapes, read as one.
 *
 * `whisper-cli -oj` writes `transcription[]` with `offsets` in milliseconds and
 * `result.language` as a code. `whisper-server` answers OpenAI's shape instead:
 * a whole `text`, `segments[]` with `start`/`end` in **seconds**, and the
 * language spelled out. Reading only the first is how the warm server path
 * came back with an empty transcript for audio it had transcribed correctly.
 */
export function parseWhisperJson(parsed, requestedLanguage = "auto") {
  if (!Array.isArray(parsed?.transcription) && Array.isArray(parsed?.segments)) {
    parsed = {
      transcription: parsed.segments.map((segment) => ({
        text: segment?.text ?? "",
        offsets: {
          from: Math.round(Number(segment?.start ?? NaN) * 1000),
          to: Math.round(Number(segment?.end ?? NaN) * 1000),
        },
        /*
          The server spells a token `{ word, probability }` and the CLI
          `{ text, p }`. Same numbers — a clip run through both paths
          returned means agreeing to three decimals — so they are read as
          one shape here rather than twice downstream.
        */
        tokens: (Array.isArray(segment?.words) ? segment.words : []).map((word) => ({
          text: word?.word ?? "",
          p: word?.probability,
        })),
      })),
      result: {
        language:
          LANGUAGE_NAMES[String(parsed?.language ?? "").toLowerCase()] ??
          (typeof parsed?.language === "string" && parsed.language.length <= 3 ? parsed.language : null),
      },
      /* A server that returned no segments at all still returned the text. */
      _whole: typeof parsed?.text === "string" ? parsed.text : "",
      /*
        The strongest signal either path offers, and only this one offers it:
        how sure the model is that the audio was the language it picked. The
        CLI has no equivalent field on any flag.
      */
      _languageProbability: parsed?.detected_language_probability,
    };
  }
  const whole = typeof parsed?._whole === "string" ? parsed._whole : "";
  const segments = Array.isArray(parsed?.transcription) ? parsed.transcription : [];
  const text = (segments.length > 0
    ? segments.map((segment) => String(segment?.text ?? "")).join(" ")
    : whole)
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

  const languageConfidence = probability(parsed?._languageProbability);
  const acoustic = meanProbability(tokenProbabilities(parsed));

  return {
    text,
    language,
    languageConfidence,
    acousticConfidence: acoustic,
    confidence: speechConfidence(languageConfidence, acoustic),
    model: parsed?.model?.type ?? null,
    segments: cues,
  };
}

/** A finite 0-1 number, or -1 for "the engine did not say". */
function probability(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : -1;
}

/**
 * Every per-word or per-token probability in the payload, whichever shape it
 * came in. The server names it `segments[].words[].probability`; the CLI's
 * `-ojf` names it `transcription[].tokens[].p`. whisper.cpp's own markers —
 * `[_BEG_]` and the `[_TT_n]` timestamps — are dropped: they are decoder
 * bookkeeping, always confidently predicted, and averaging them in would drag
 * every score toward the same number.
 */
function tokenProbabilities(parsed) {
  const out = [];
  for (const segment of Array.isArray(parsed?.transcription) ? parsed.transcription : []) {
    for (const token of Array.isArray(segment?.tokens) ? segment.tokens : []) {
      if (String(token?.text ?? "").startsWith("[_")) continue;
      const value = probability(token?.p);
      if (value >= 0) out.push(value);
    }
  }
  return out;
}

function meanProbability(values) {
  if (values.length === 0) return -1;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * One 0-1 number for "the recogniser was sure of this utterance", from the two
 * independent things it can be unsure about.
 *
 * It is the weaker of the two, not their average, because they fail
 * separately: the recogniser must be sure both that this *was* speech in a
 * language it knows, and of the words it then chose. Averaging lets a
 * confident transcription of noise pass.
 *
 * Measured here on ggml-large-v3-turbo-q8_0, language=auto:
 *
 *   clip                       langP   meanP   transcript
 *   6s digital silence         0.369   0.734   "Thank you."
 *   6s pink noise              0.603   0.944   "."
 *   8s low hum                 0.613   0.954   "."
 *   8s two-tone "music"        0.800   0.262   "."
 *   `say`, one sentence        1.000   0.884   the sentence, correctly
 *   the jfk.wav brew ships     0.960   0.911   the speech, correctly
 *
 * Speech sits at 0.96+ on the language probability and non-speech below 0.81,
 * while the token probability barely separates them at all — silence decodes
 * to "Thank you." at 0.73, which is why a token-probability-only score cannot
 * be the gate. Note what the table does *not* show: a repetition loop scores
 * high on both (a clip of "tk tk tk" measured 0.813/0.893 and came back with
 * two more "TK"s than were said). Confidence cannot catch a loop. That is a
 * job for lexical plausibility, not for this number.
 *
 * The CLI path reports no language probability at all, so its confidence is
 * the token score alone and says nothing about whether this was speech. A
 * caller that needs that distinction must check `languageConfidence >= 0`.
 */
export function speechConfidence(languageConfidence, acousticConfidence) {
  const parts = [languageConfidence, acousticConfidence].filter((value) => value >= 0);
  if (parts.length === 0) return -1;
  return Math.min(...parts);
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
